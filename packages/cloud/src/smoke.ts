/**
 * Smoke suite — the zero-config "point Argus at a URL" check.
 *
 * One Chromium, one context per viewport×colorScheme: load the page, collect
 * console errors / failed requests / responsive overflow, screenshot to R2.
 * Deterministic, no model. Report JSON is also persisted to R2.
 */
import { acquirePooledBrowser, releasePooledBrowser } from "./pool";
import {
  VIEWPORTS,
  type Finding,
  type SmokeReport,
  type SmokeRequest,
} from "@argus/shared";
import { writeRunMeta } from "./runs";
import type { Env } from "./env";

export async function runSmoke(env: Env, req: SmokeRequest, tenantId?: string): Promise<SmokeReport> {
  const owner = tenantId ?? "_admin";
  const runId = crypto.randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const findings: Finding[] = [];
  const screenshots: SmokeReport["screenshots"] = [];
  const overflowViewports: SmokeReport["checks"]["responsiveOverflow"] = [];
  let loaded = false;
  let consoleErrors = 0;
  let failedRequests = 0;
  let findingSeq = 0;
  const fid = () => `f-${runId}-${++findingSeq}`;

  const browser = await acquirePooledBrowser(env);
  try {
    for (const viewport of req.viewports) {
      for (const colorScheme of req.colorSchemes) {
        const context = await browser.newContext({
          viewport: VIEWPORTS[viewport],
          colorScheme,
        });
        const page = await context.newPage();

        const pageErrors: string[] = [];
        const pageFails: string[] = [];
        page.on("console", (m) => {
          if (m.type() === "error") pageErrors.push(m.text().slice(0, 300));
        });
        page.on("pageerror", (e) => pageErrors.push(`Uncaught: ${String(e).slice(0, 300)}`));
        page.on("response", (r) => {
          if (r.status() >= 400) pageFails.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 200)}`);
        });
        page.on("requestfailed", (r) => pageFails.push(`FAILED ${r.method()} ${r.url().slice(0, 200)}`));

        try {
          await page.goto(req.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
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
              nextAction: "check that the URL is reachable and the server responds — this blocks all other checks",
            },
          });
          await context.close();
          continue;
        }

        // Responsive overflow: horizontal scroll on a fresh load is a layout bug.
        const overflow = await page
          .evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth + 1
          )
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
              nextAction: `find the element exceeding ${VIEWPORTS[viewport].width}px width (often a fixed-width container, unwrapped table, or long unbroken string)`,
            },
          });
        }

        // Screenshot → R2
        const png = await page.screenshot({ fullPage: true, type: "png" });
        const key = `tenants/${owner}/runs/${runId}/smoke-${viewport}-${colorScheme}.png`;
        await env.ARTIFACTS.put(key, png, { httpMetadata: { contentType: "image/png" } });
        screenshots.push({ viewport, colorScheme, key, url: `/v1/artifact/${key}` });

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
              nextAction: "reproduce locally and fix the thrown error — silent errors mask real breakage",
            },
          });
        }
        for (const text of pageFails.slice(0, 5)) {
          findings.push({
            id: fid(),
            severity: text.startsWith("5") || text.includes(" 5") ? "critical" : "major",
            category: "network-failure",
            summary: `Failed request at ${viewport}: ${text.slice(0, 140)}`,
            detail: text,
            evidence: { viewport },
            decision: {
              whatChanged: "a request returned ≥400 or failed during load",
              nextAction: "check the endpoint — a 4xx/5xx on first load is usually a broken API route or missing asset",
            },
          });
        }

        await context.close();
      }
    }
  } finally {
    await releasePooledBrowser(env, browser);
  }

  const report: SmokeReport = {
    runId,
    url: req.url,
    status: !loaded ? "error" : findings.some((f) => f.severity === "critical" || f.severity === "major") ? "fail" : "pass",
    startedAt,
    durationMs: Date.now() - t0,
    checks: {
      loaded,
      consoleErrors,
      failedRequests,
      responsiveOverflow: overflowViewports,
    },
    screenshots,
    findings,
  };

  await env.ARTIFACTS.put(`tenants/${owner}/runs/${runId}/report.json`, JSON.stringify(report, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  await writeRunMeta(env, {
    runId,
    kind: "smoke",
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
