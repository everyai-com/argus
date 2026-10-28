/**
 * Crawl — sweep a whole site in parallel cloud browsers.
 *
 * Breadth-first from a start URL over same-origin links, N workers each
 * holding a tenant slot (admission applies). Every page is RENDERED and run
 * through the deterministic detectors: console errors, own-origin request
 * failures, sideways overflow, layout & content problems, and not-found pages
 * reached by an internal link. Findings go through triage memory per page.
 *
 * Read-only by construction: it follows links and never clicks or submits.
 * It skips sign-out links (they would end an auth profile's session) and
 * file downloads. A not-found page is decided from the rendered page, never
 * from HTTP status alone — a client-routed SPA answers 200 for every path.
 */
import { contextOptionsFor } from "./flow-utils";
import type { BrowserContext, Page } from "@cloudflare/playwright";
import { VIEWPORTS, type CrawlReport, type CrawlRequest, type Finding } from "@argus/shared";
import { acquirePooledBrowser, releasePooledBrowser } from "./pool";
import { detectorFindings, probeLayout } from "./detectors";
import { applyTriage } from "./triage";
import { hostOf, loadAuthProfile } from "./auth-store";
import { writeRunMeta } from "./runs";
import type { Env } from "./env";

const SKIP_PATH = /\/(log-?out|sign-?out|signout|logoff)(\/|$)/i;
const SKIP_FILE = /\.(pdf|zip|gz|tar|dmg|exe|png|jpe?g|gif|svg|webp|mp4|mp3|csv|xlsx?|docx?)$/i;
const NOT_FOUND_TEXT = /\b(404|page not found|not found|page (doesn['’]?t|does not) exist|no such page)\b/i;

/**
 * Same-origin, in-scope, crawlable — normalised to origin+path+query (hash
 * dropped, params sorted, tracking params stripped). The query stays because
 * many SPAs route with it (`?tab=runs`); maxPages bounds any facet explosion.
 */
export function crawlKey(href: string, origin: string, include?: string): string | undefined {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return undefined;
  }
  if (u.origin !== origin) return undefined;
  if (SKIP_PATH.test(u.pathname) || SKIP_FILE.test(u.pathname)) return undefined;
  if (include && !u.pathname.startsWith(include)) return undefined;
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : "/";
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !/^(utm_|fbclid$|gclid$|ref$|_ga$)/i.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  return `${u.origin}${path}${query}`;
}

interface Visit {
  url: string;
  from?: string;
}

export async function runCrawl(env: Env, req: CrawlRequest, tenantId?: string): Promise<CrawlReport> {
  const owner = tenantId ?? "_admin";
  const runId = crypto.randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const origin = new URL(req.url).origin;

  let storageState: unknown;
  if (req.authProfile) {
    const profile = await loadAuthProfile(env, owner, req.authProfile, hostOf(req.url));
    if (!profile) throw new Error(`auth profile "${req.authProfile}" not found for ${hostOf(req.url)} — run the login flow first`);
    storageState = profile.state;
  }

  const start = crawlKey(req.url, origin, req.include) ?? req.url;
  const queue: Visit[] = [{ url: start }];
  const seen = new Set([start]);
  let truncated = false;
  const pages: CrawlReport["pages"] = [];
  const screenshots: CrawlReport["screenshots"] = [];
  const byPage = new Map<string, Finding[]>();
  let seq = 0;
  const fid = () => `f-${runId}-${++seq}`;
  let claimed = 0; // pages handed to a worker (bounded by maxPages)
  let inFlight = 0; // pages being visited right now (they may still add links)

  const visitAll = async (context: BrowserContext): Promise<void> => {
    for (;;) {
      if (claimed >= req.maxPages) return;
      const next = queue.shift();
      if (!next) {
        // Another worker may still be discovering links; wait briefly for them.
        if (inFlight === 0) return;
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      claimed++;
      inFlight++;
      try {
        const page = await context.newPage();
        try {
          const n = pages.length;
          const result = await visit(env, owner, runId, page, next, req, fid, n);
          pages.push(result.page);
          if (result.screenshot) screenshots.push(result.screenshot);
          byPage.set(next.url, result.findings);
          for (const link of result.links) {
            const key = crawlKey(link, origin, req.include);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            if (seen.size > req.maxPages) truncated = true;
            queue.push({ url: key, from: next.url });
          }
        } finally {
          await page.close().catch(() => {});
        }
      } finally {
        inFlight--;
      }
    }
  };

  const workers = Array.from({ length: req.concurrency }, async () => {
    const pooled = await acquirePooledBrowser(env, owner, "crawl");
    try {
      const context = await pooled.browser.newContext({
        ...contextOptionsFor(req.viewport, pooled.browser.version()),
        ...(storageState ? { storageState: storageState as never } : {}),
      });
      try {
        await visitAll(context);
      } finally {
        await context.close().catch(() => {});
      }
    } finally {
      await releasePooledBrowser(env, pooled);
    }
  });
  await Promise.all(workers);

  // Triage per page: identity is (host, path, rule, …), so each page's
  // findings carry their own fingerprints and memory.
  const findings: Finding[] = [];
  const suppressed: NonNullable<CrawlReport["suppressed"]> = [];
  let newFindings = 0;
  let regressions = 0;
  for (const [pageUrl, list] of byPage) {
    const t = await applyTriage(env, owner, list, {
      pageUrl,
      ranFamilies: new Set(["console", "network", "load", "responsive", "layout", "content", "link"]),
      viewports: [req.viewport],
    });
    findings.push(...t.findings);
    suppressed.push(...t.suppressed);
    newFindings += t.newFindings;
    regressions += t.regressions;
  }

  // The same problem on two URLs of one page (e.g. ?tab=a / ?tab=b) is one
  // finding — keep the first, name the others.
  const byFingerprint = new Map<string, { finding: Finding; others: number }>();
  const unique: Finding[] = [];
  for (const f of findings) {
    const prior = f.fingerprint ? byFingerprint.get(f.fingerprint) : undefined;
    if (prior) {
      prior.others++;
      continue;
    }
    if (f.fingerprint) byFingerprint.set(f.fingerprint, { finding: f, others: 0 });
    unique.push(f);
  }
  for (const { finding, others } of byFingerprint.values()) {
    if (others) finding.detail = `${finding.detail ? `${finding.detail} · ` : ""}also on ${others} other URL(s) of this page`;
  }
  findings.length = 0;
  findings.push(...unique);

  const startPage = pages.find((p) => p.url === start);
  const loaded = Boolean(startPage && !startPage.error);
  const report: CrawlReport = {
    runId,
    url: req.url,
    status: !loaded ? "error" : findings.some((f) => f.severity === "critical" || f.severity === "major") ? "fail" : "pass",
    startedAt,
    durationMs: Date.now() - t0,
    pages: pages.sort((a, b) => a.url.localeCompare(b.url)),
    truncated,
    screenshots,
    findings,
    newFindings,
    regressions,
    suppressed,
  };
  await env.ARTIFACTS.put(`tenants/${owner}/runs/${runId}/crawl-report.json`, JSON.stringify(report, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  await writeRunMeta(env, {
    runId,
    kind: "crawl",
    project: req.project,
    tenantId,
    url: req.url,
    status: report.status,
    at: startedAt,
    durationMs: report.durationMs,
    findings: findings.length,
  });
  return report;
}

async function visit(
  env: Env,
  owner: string,
  runId: string,
  page: Page,
  v: Visit,
  req: CrawlRequest,
  fid: () => string,
  n: number
): Promise<{
  page: CrawlReport["pages"][number];
  findings: Finding[];
  links: string[];
  screenshot?: CrawlReport["screenshots"][number];
}> {
  const origin = new URL(req.url).origin;
  const path = new URL(v.url).pathname;
  const consoleErrors: string[] = [];
  const failures: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => consoleErrors.push(`Uncaught: ${String(e).slice(0, 300)}`));
  page.on("response", (r) => {
    if (r.status() >= 400 && r.url().startsWith(origin) && r.request().resourceType() !== "document") {
      failures.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 200)}`);
    }
  });
  page.on("requestfailed", (r) => {
    if (r.url().startsWith(origin)) failures.push(`FAILED ${r.method()} ${r.url().slice(0, 200)}`);
  });

  const findings: Finding[] = [];
  const t0 = Date.now();
  let httpStatus: number | undefined;
  try {
    const res = await page.goto(v.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    httpStatus = res?.status();
    // A linked API/JSON/text document is not a page a user browses: record it,
    // don't test it (its 401/404 is the API's business, not a UI bug).
    const type = (res?.headers()["content-type"] ?? "").toLowerCase();
    if (type && !type.includes("html")) {
      return {
        page: { url: v.url, from: v.from, httpStatus, notFound: false, findings: 0, linksOut: 0, skipped: `not an HTML page (${type.split(";")[0]})` },
        findings: [],
        links: [],
      };
    }
    await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
  } catch (err) {
    findings.push({
      id: fid(),
      severity: "critical",
      category: "load",
      rule: "load/failed",
      summary: `[${path}] page failed to load`,
      detail: String(err).slice(0, 300),
      evidence: { viewport: req.viewport },
      decision: {
        whatChanged: `the page did not reach domcontentloaded within 30s${v.from ? ` (linked from ${new URL(v.from).pathname})` : ""}`,
        nextAction: "check the route and the server — this page is unreachable",
      },
    });
    return {
      page: { url: v.url, from: v.from, notFound: false, findings: 1, linksOut: 0, error: String(err).slice(0, 200) },
      findings,
      links: [],
    };
  }
  const loadMs = Date.now() - t0;

  const seen = await page
    .evaluate(() => {
      const h1 = (document.querySelector("h1") as any)?.innerText ?? "";
      const links = (Array.from(document.querySelectorAll("a[href]")) as any[]).map((a) => String(a.href));
      const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
      return { title: document.title, h1: String(h1).slice(0, 200), links, overflow };
    })
    .catch(() => ({ title: "", h1: "", links: [] as string[], overflow: false }));

  // Rendered verdict: a 404 status, or a page that SAYS it is not found.
  const notFound = httpStatus === 404 || NOT_FOUND_TEXT.test(`${seen.title} ${seen.h1}`);
  if (notFound && v.from) {
    findings.push({
      id: fid(),
      severity: "major",
      category: "link",
      rule: "link/broken",
      summary: `[${path}] internal link leads to a not-found page`,
      detail: `linked from ${new URL(v.from).pathname}; rendered "${(seen.h1 || seen.title).slice(0, 80)}" (HTTP ${httpStatus ?? "?"})`,
      evidence: { viewport: req.viewport },
      decision: {
        whatChanged: `a link on ${new URL(v.from).pathname} points to ${path}, which renders a not-found page`,
        nextAction: "fix the href, or restore the route it points to",
      },
    });
  }

  if (!notFound) {
    const hits = await probeLayout(page, { tapTargets: req.viewport === "mobile" });
    for (const f of detectorFindings(hits, req.viewport, fid)) {
      f.summary = `[${path}] ${f.summary}`;
      findings.push(f);
    }
    if (seen.overflow) {
      findings.push({
        id: fid(),
        severity: "major",
        category: "responsive",
        rule: "responsive/overflow",
        summary: `[${path}] page scrolls sideways at ${req.viewport} (${VIEWPORTS[req.viewport].width}px)`,
        evidence: { viewport: req.viewport },
        decision: {
          whatChanged: "page content is wider than the viewport",
          nextAction: `find the element exceeding ${VIEWPORTS[req.viewport].width}px on ${path}`,
        },
      });
    }
  }
  for (const text of consoleErrors.slice(0, 3)) {
    findings.push({
      id: fid(),
      severity: "major",
      category: "console-error",
      summary: `[${path}] console error: ${text.slice(0, 120)}`,
      detail: text,
      evidence: { viewport: req.viewport },
      decision: { whatChanged: `${path} logged an error while loading`, nextAction: "reproduce on that page and fix" },
    });
  }
  for (const text of failures.slice(0, 3)) {
    findings.push({
      id: fid(),
      severity: "major",
      category: "network-failure",
      summary: `[${path}] failed request: ${text.slice(0, 140)}`,
      detail: text,
      evidence: { viewport: req.viewport },
      decision: { whatChanged: `${path} made a request that failed`, nextAction: "check the endpoint that page calls" },
    });
  }

  let screenshot: CrawlReport["screenshots"][number] | undefined;
  try {
    const png = await page.screenshot({ type: "png", fullPage: false });
    const key = `tenants/${owner}/runs/${runId}/crawl-${String(n).padStart(2, "0")}.png`;
    await env.ARTIFACTS.put(key, png, { httpMetadata: { contentType: "image/png" } });
    screenshot = { viewport: req.viewport, colorScheme: "light", key, url: `/v1/artifact/${key}` };
  } catch {
    /* evidence is best-effort */
  }

  return {
    page: {
      url: v.url,
      from: v.from,
      title: seen.title.slice(0, 120),
      httpStatus,
      notFound,
      loadMs,
      findings: findings.length,
      linksOut: seen.links.length,
      screenshotKey: screenshot?.key,
    },
    findings,
    links: seen.links,
    screenshot,
  };
}
