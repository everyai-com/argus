/**
 * Audit engine — the full UX/visual pass. Deterministic, no model.
 *
 * Per viewport×scheme: load with perf collectors installed, run the smoke
 * checks, inject axe-core (cached in R2) for a11y, read Web-Vitals-style
 * metrics, screenshot and pixel-diff against the stored baseline. Same-origin
 * links are checked from the Worker (parallel, cheap). Everything lands as
 * findings with decision envelopes; the report persists to R2.
 */
import { acquirePooledBrowser, releasePooledBrowser } from "./pool";
import type { Page } from "@cloudflare/playwright";
// @ts-expect-error — upng-js ships no types; pure-JS PNG codec that runs in workerd
import UPNG from "upng-js";
import pixelmatch from "pixelmatch";
import {
  VIEWPORTS,
  type AuditReport,
  type AuditRequest,
  type Finding,
  type PerfMetrics,
  type ViewportName,
  type VisualDiff,
} from "@argus/shared";
import { hostOf, loadAuthProfile } from "./auth-store";
import { writeRunMeta } from "./runs";
import type { Env } from "./env";

const AXE_SOURCE_URL = "https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js";
const AXE_R2_KEY = "vendor/axe-core-4.10.2.min.js";

async function getAxeSource(env: Env): Promise<string | undefined> {
  const cached = await env.ARTIFACTS.get(AXE_R2_KEY);
  if (cached) return await cached.text();
  try {
    const res = await fetch(AXE_SOURCE_URL);
    if (!res.ok) return undefined;
    const src = await res.text();
    await env.ARTIFACTS.put(AXE_R2_KEY, src, {
      httpMetadata: { contentType: "text/javascript" },
    });
    return src;
  } catch {
    return undefined;
  }
}

/** Installed at document start so LCP/CLS observers don't miss early entries. */
const PERF_INIT_SCRIPT = `
(() => {
  const perf = { lcp: 0, cls: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) perf.lcp = Math.max(perf.lcp, e.startTime);
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { if (!e.hadRecentInput) perf.cls += e.value; }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
  window.__argusPerf = perf;
})();`;

function severityForImpact(impact: string | undefined): Finding["severity"] {
  switch (impact) {
    case "critical":
      return "critical";
    case "serious":
      return "major";
    case "moderate":
      return "minor";
    default:
      return "info";
  }
}

export async function runAudit(env: Env, req: AuditRequest, tenantId?: string): Promise<AuditReport> {
  const owner = tenantId ?? "_admin";
  const runId = crypto.randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const findings: Finding[] = [];
  const screenshots: AuditReport["screenshots"] = [];
  const perf: PerfMetrics[] = [];
  const visual: VisualDiff[] = [];
  const overflowViewports: ViewportName[] = [];
  let loaded = false;
  let consoleErrors = 0;
  let failedRequests = 0;
  let a11yViolations = 0;
  let findingSeq = 0;
  const fid = () => `f-${runId}-${++findingSeq}`;

  const baseKey =
    req.baselineKey ??
    (await (async () => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(req.url));
      return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
    })());

  const axeSource = req.checks.includes("a11y") ? await getAxeSource(env) : undefined;
  const seenA11yIds = new Set<string>();
  let pageLinks: string[] = [];
  let linkResults: Array<{ link: string; status: number }> | undefined;

  // Behind-the-login-wall auditing: same host-scoped profile the flows use.
  let storageState: unknown;
  if (req.authProfile) {
    const profile = await loadAuthProfile(env, owner, req.authProfile, hostOf(req.url));
    if (!profile) {
      throw new Error(
        `auth profile "${req.authProfile}" not found for ${hostOf(req.url)} — run the login flow first`
      );
    }
    storageState = profile.state;
  }

  const browser = await acquirePooledBrowser(env);
  try {
    for (const viewport of req.viewports) {
      for (const colorScheme of req.colorSchemes) {
        const context = await browser.newContext({
          viewport: VIEWPORTS[viewport],
          colorScheme,
          ...(storageState ? { storageState: storageState as never } : {}),
        });
        await context.addInitScript(PERF_INIT_SCRIPT);
        const page = await context.newPage();

        const pageErrors: string[] = [];
        const pageFails: string[] = [];
        let requests = 0;
        page.on("request", () => requests++);
        page.on("console", (m) => {
          if (m.type() === "error") pageErrors.push(m.text().slice(0, 300));
        });
        page.on("pageerror", (e) => pageErrors.push(`Uncaught: ${String(e).slice(0, 300)}`));
        page.on("response", (r) => {
          if (r.status() >= 400)
            pageFails.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 200)}`);
        });
        page.on("requestfailed", (r) => pageFails.push(`FAILED ${r.method()} ${r.url().slice(0, 200)}`));

        const navStart = Date.now();
        try {
          await page.goto(req.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
          loaded = true;
        } catch (err) {
          findings.push({
            id: fid(),
            severity: "critical",
            category: "load",
            summary: `Page failed to load at ${viewport}/${colorScheme}`,
            detail: String(err).slice(0, 300),
            evidence: { viewport },
            decision: {
              whatChanged: "the app did not reach domcontentloaded within 30s",
              nextAction: "check that the URL is reachable — this blocks all other checks",
            },
          });
          await context.close();
          continue;
        }
        const loadMs = Date.now() - navStart;

        // ---- perf ---------------------------------------------------------
        if (req.checks.includes("perf")) {
          const metrics = await page
            .evaluate(() => {
              const paint = (performance as any).getEntriesByType("paint") as any[];
              const fcp = paint.find((p) => p.name === "first-contentful-paint")?.startTime;
              const p = (window as any).__argusPerf ?? {};
              return { fcp, lcp: p.lcp, cls: p.cls };
            })
            .catch(() => ({ fcp: undefined, lcp: undefined, cls: undefined }));
          const m: PerfMetrics = {
            viewport,
            fcpMs: metrics.fcp ? Math.round(metrics.fcp) : undefined,
            lcpMs: metrics.lcp ? Math.round(metrics.lcp) : undefined,
            cls: metrics.cls !== undefined ? Math.round(metrics.cls * 1000) / 1000 : undefined,
            loadMs,
            requests,
          };
          perf.push(m);
          if (m.lcpMs !== undefined && m.lcpMs > 2500) {
            findings.push({
              id: fid(),
              severity: m.lcpMs > 4000 ? "major" : "minor",
              category: "perf",
              summary: `Slow LCP at ${viewport}: ${(m.lcpMs / 1000).toFixed(1)}s (target ≤2.5s)`,
              evidence: { viewport },
              decision: {
                whatChanged: "largest contentful paint exceeds the good threshold",
                nextAction: "check the largest above-the-fold element: defer non-critical JS, preload the hero image/font",
              },
            });
          }
          if (m.cls !== undefined && m.cls > 0.1) {
            findings.push({
              id: fid(),
              severity: m.cls > 0.25 ? "major" : "minor",
              category: "perf",
              summary: `Layout shift at ${viewport}: CLS ${m.cls} (target ≤0.1)`,
              evidence: { viewport },
              decision: {
                whatChanged: "content moves after first paint",
                nextAction: "reserve space for images/ads/dynamic content with explicit dimensions",
              },
            });
          }
        }

        // ---- a11y (once per viewport, light scheme) -----------------------
        if (axeSource && colorScheme === "light") {
          try {
            await page.addScriptTag({ content: axeSource });
            const violations = (await page.evaluate(async () => {
              const axe = (window as any).axe;
              const res = await axe.run(document, {
                resultTypes: ["violations"],
                runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
              });
              return res.violations.map((v: any) => ({
                id: v.id,
                impact: v.impact,
                help: v.help,
                nodes: v.nodes.length,
                sample: v.nodes[0]?.target?.join(" ") ?? "",
              }));
            })) as Array<{ id: string; impact?: string; help: string; nodes: number; sample: string }>;
            for (const v of violations) {
              a11yViolations += v.nodes;
              const dedupeKey = `${v.id}`;
              if (seenA11yIds.has(dedupeKey)) continue;
              seenA11yIds.add(dedupeKey);
              findings.push({
                id: fid(),
                severity: severityForImpact(v.impact),
                category: "a11y",
                summary: `a11y: ${v.help} (${v.nodes} element(s))`,
                detail: `rule ${v.id} · first: ${v.sample}`,
                evidence: { viewport },
                decision: {
                  whatChanged: `axe-core rule "${v.id}" fails on ${v.nodes} element(s)`,
                  nextAction: `fix per https://dequeuniversity.com/rules/axe/4.10/${v.id}`,
                },
              });
            }
          } catch {
            /* CSP may block injection — a11y is best-effort */
          }
        }

        // ---- responsive overflow -----------------------------------------
        const overflow = await page
          .evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
          .catch(() => false);
        if (overflow && !overflowViewports.includes(viewport)) {
          overflowViewports.push(viewport);
          findings.push({
            id: fid(),
            severity: "major",
            category: "responsive",
            summary: `Horizontal overflow at ${viewport} (${VIEWPORTS[viewport].width}px)`,
            evidence: { viewport },
            decision: {
              whatChanged: "page content is wider than the viewport",
              nextAction: `find the element exceeding ${VIEWPORTS[viewport].width}px (fixed-width container, unwrapped table, or long unbroken string)`,
            },
          });
        }

        // ---- screenshot + visual diff ------------------------------------
        const png = await page.screenshot({ fullPage: false, type: "png" });
        const currentKey = `tenants/${owner}/runs/${runId}/audit-${viewport}-${colorScheme}.png`;
        await env.ARTIFACTS.put(currentKey, png, { httpMetadata: { contentType: "image/png" } });
        screenshots.push({ viewport, colorScheme, key: currentKey, url: `/v1/artifact/${currentKey}` });

        if (req.checks.includes("visual")) {
          const blKey = `tenants/${owner}/baselines/${baseKey}/${viewport}-${colorScheme}.png`;
          const baseline = await env.ARTIFACTS.get(blKey);
          if (!baseline) {
            await env.ARTIFACTS.put(blKey, png, { httpMetadata: { contentType: "image/png" } });
            visual.push({ viewport, colorScheme, status: "baseline-created", currentKey, baselineKey: blKey });
          } else {
            const curImg = UPNG.decode(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength));
            const baseBuf = await baseline.arrayBuffer();
            const baseImg = UPNG.decode(baseBuf);
            if (curImg.width !== baseImg.width || curImg.height !== baseImg.height) {
              visual.push({ viewport, colorScheme, status: "size-mismatch", currentKey, baselineKey: blKey });
            } else {
              const curData = new Uint8Array(UPNG.toRGBA8(curImg)[0] as ArrayBuffer);
              const baseData = new Uint8Array(UPNG.toRGBA8(baseImg)[0] as ArrayBuffer);
              const diffData = new Uint8Array(curImg.width * curImg.height * 4);
              const changed = pixelmatch(baseData, curData, diffData, curImg.width, curImg.height, {
                threshold: 0.12,
              });
              const ratio = changed / (curImg.width * curImg.height);
              if (ratio > 0.001) {
                const diffKey = `tenants/${owner}/runs/${runId}/diff-${viewport}-${colorScheme}.png`;
                const diffPng = UPNG.encode([diffData.buffer as ArrayBuffer], curImg.width, curImg.height, 0);
                await env.ARTIFACTS.put(diffKey, diffPng, {
                  httpMetadata: { contentType: "image/png" },
                });
                visual.push({
                  viewport,
                  colorScheme,
                  status: "diff",
                  diffRatio: Math.round(ratio * 10000) / 10000,
                  currentKey,
                  baselineKey: blKey,
                  diffKey,
                });
                findings.push({
                  id: fid(),
                  severity: ratio > 0.05 ? "major" : "minor",
                  category: "visual",
                  summary: `Visual change at ${viewport}/${colorScheme}: ${(ratio * 100).toFixed(1)}% of pixels differ from baseline`,
                  evidence: { screenshotKey: currentKey, viewport },
                  decision: {
                    whatChanged: "the rendered page no longer matches the approved baseline",
                    nextAction: "inspect the diff image — approve with updateBaseline:true if intended, otherwise fix the regression",
                  },
                });
              } else {
                visual.push({ viewport, colorScheme, status: "match", diffRatio: 0, currentKey, baselineKey: blKey });
              }
            }
            if (req.updateBaseline) {
              await env.ARTIFACTS.put(blKey, png, { httpMetadata: { contentType: "image/png" } });
            }
          }
        }

        // ---- console / network findings ----------------------------------
        consoleErrors += pageErrors.length;
        failedRequests += pageFails.length;
        for (const text of pageErrors.slice(0, 5)) {
          findings.push({
            id: fid(),
            severity: "major",
            category: "console-error",
            summary: `Console error at ${viewport}: ${text.slice(0, 120)}`,
            detail: text,
            evidence: { viewport },
            decision: {
              whatChanged: "the page logged an error during load",
              nextAction: "reproduce and fix — silent errors mask real breakage",
            },
          });
        }
        for (const text of pageFails.slice(0, 5)) {
          findings.push({
            id: fid(),
            severity: "major",
            category: "network-failure",
            summary: `Failed request at ${viewport}: ${text.slice(0, 140)}`,
            detail: text,
            evidence: { viewport },
            decision: {
              whatChanged: "a request returned ≥400 or failed during load",
              nextAction: "check the endpoint — usually a broken API route or missing asset",
            },
          });
        }

        // ---- links (collect + check once, FROM THE PAGE) -----------------
        // Runs AFTER console/network findings are finalized so Argus's own
        // probe traffic never pollutes them. Checked in-page rather than from
        // the Worker: same-origin fetches reflect what a real user reaches,
        // and Worker→Worker fetches to same-account workers.dev are blocked
        // by Cloudflare (false 404s).
        if (req.checks.includes("links") && linkResults === undefined) {
          pageLinks = await page
            .evaluate(() =>
              (Array.from(document.querySelectorAll("a[href]")) as any[])
                .map((a) => String(a.href))
                .filter((h) => h.startsWith("http"))
            )
            .catch(() => []);
          const origin = new URL(req.url).origin;
          const targets = [...new Set(pageLinks)]
            .map((l) => l.split("#")[0]!) // #fragments resolve to the same document
            .filter((l) => l.startsWith(origin))
            .slice(0, 25);
          if (targets.length > 0) {
            linkResults = await page
              .evaluate(async (urls: string[]) => {
                return await Promise.all(
                  urls.map(async (link: string) => {
                    try {
                      let res = await fetch(link, { method: "HEAD" });
                      if (res.status === 405 || res.status === 501) res = await fetch(link);
                      return { link, status: res.status };
                    } catch {
                      return { link, status: 0 };
                    }
                  })
                );
              }, targets)
              .catch(() => []);
          } else {
            linkResults = [];
          }
        }

        await context.close();
      }
    }
  } finally {
    await releasePooledBrowser(env, browser);
  }

  // ---- broken-link findings ----------------------------------------------
  let linksChecked = 0;
  let brokenLinks = 0;
  if (linkResults && linkResults.length > 0) {
    linksChecked = linkResults.length;
    for (const r of linkResults) {
      if (r.status >= 400 || r.status === 0) {
        brokenLinks++;
        findings.push({
          id: fid(),
          severity: "major",
          category: "link",
          summary: `Broken link: ${r.link.slice(0, 120)} → ${r.status || "unreachable"}`,
          decision: {
            whatChanged: `an in-page link returns ${r.status || "no response"}`,
            nextAction: "fix the href or the route it points to",
          },
        });
      }
    }
  }

  const hasBlockers = findings.some((f) => f.severity === "critical" || f.severity === "major");
  const report: AuditReport = {
    runId,
    url: req.url,
    status: !loaded ? "error" : hasBlockers ? "fail" : "pass",
    startedAt,
    durationMs: Date.now() - t0,
    smoke: {
      loaded,
      consoleErrors,
      failedRequests,
      responsiveOverflow: overflowViewports,
    },
    perf,
    visual,
    a11yViolations,
    linksChecked,
    brokenLinks,
    screenshots,
    findings,
  };

  await env.ARTIFACTS.put(`tenants/${owner}/runs/${runId}/audit-report.json`, JSON.stringify(report, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  await writeRunMeta(env, {
    runId,
    kind: "audit",
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
