/**
 * Flow replay engine — deterministic, no model.
 *
 * Re-resolves each step's semantic anchor against the live DOM, performs the
 * action, checks the step's `expect` predicates, and finally the flow's
 * `success` predicates. Drift (an anchor that no longer resolves) is legible:
 * the result names the step, what changed, the nearest surviving candidate,
 * and the next action — a decision envelope, not a blind failure.
 *
 * heal mode: on drift, rebind to the confident nearest match and continue,
 * collecting proposals. Proposals only become real when the client applies
 * them to the flow file (which lives in the repo, not here).
 */
import { acquirePooledBrowser, releasePooledBrowser } from "./pool";
import type { Page, Locator } from "@cloudflare/playwright";
import {
  VIEWPORTS,
  type ConsoleEvent,
  type Flow,
  type FlowReplayResult,
  type NetworkEvent,
  type Predicate,
  type PredicateResult,
} from "@argus/shared";
import { evalPredicate, nearestMatch, resolveAnchor, weakestTier } from "./verify";
import { hostOf, loadAuthProfile, saveAuthProfile } from "./auth-store";
import { rehomeFlow } from "./flow-utils";
import type { Env } from "./env";

export { rehomeFlow } from "./flow-utils";

export interface HealProposal {
  step: number;
  from: string;
  to: string;
  confidence: number;
}

export interface ReplayOutcome extends FlowReplayResult {
  proposals?: HealProposal[];
  stepResults?: Array<{ step: number; ok: boolean; note?: string }>;
  /** Set when the flow declared saveAuthAs and succeeded. */
  authSaved?: { name: string; cookies: number };
}

interface Buffers {
  network: NetworkEvent[];
  console: ConsoleEvent[];
  seq: number;
}

function bindBuffers(page: Page): Buffers {
  const buf: Buffers = { network: [], console: [], seq: 0 };
  page.on("console", (msg) => {
    const level = (["log", "info", "warn", "error"] as const).includes(msg.type() as never)
      ? (msg.type() as "log" | "info" | "warn" | "error")
      : "log";
    buf.console.push({
      seq: ++buf.seq,
      level,
      text: msg.text().slice(0, 500),
      sourceUrl: msg.location()?.url || undefined,
    });
  });
  page.on("pageerror", (err) => {
    buf.console.push({ seq: ++buf.seq, level: "error", text: `Uncaught: ${String(err).slice(0, 500)}` });
  });
  page.on("response", (res) => {
    const req = res.request();
    buf.network.push({
      seq: ++buf.seq,
      method: req.method(),
      url: req.url().slice(0, 300),
      status: res.status(),
      failed: res.status() >= 400,
      resourceType: req.resourceType(),
    });
  });
  page.on("requestfailed", (req) => {
    buf.network.push({
      seq: ++buf.seq,
      method: req.method(),
      url: req.url().slice(0, 300),
      failed: true,
      resourceType: req.resourceType(),
    });
  });
  return buf;
}

/** Rescope event-window predicates to "since this step started". */
function scopePredicates(predicates: Predicate[], since: number): Predicate[] {
  return predicates.map((p) =>
    p.kind === "network" || p.kind === "console-clean" ? { ...p, since } : p
  );
}

/**
 * Evaluate predicates with a bounded settle-retry: a slow response that lands
 * 1s late must not flake the verdict. Retries only while failing, up to ~4s.
 */
async function evalAllSettled(
  page: Page,
  buf: Buffers,
  predicates: Predicate[]
): Promise<PredicateResult[]> {
  let results: PredicateResult[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    results = [];
    for (const p of predicates) results.push(await evalPredicate(page, buf, p));
    if (results.every((r) => r.pass)) return results;
    await page.waitForTimeout(800);
  }
  return results;
}

async function candidatesOnPage(page: Page): Promise<string[]> {
  return await page
    .evaluate(() =>
      (Array.from(document.querySelectorAll("[data-testid]")) as any[]).map((el) =>
        String(el.getAttribute("data-testid"))
      )
    )
    .catch(() => []);
}

/**
 * Re-home a flow onto another environment. A suite recorded against prod must
 * be runnable against a version-preview URL without editing every file — that
 * is what makes a deploy gate possible. Only the origin changes; path, query
 * and every anchor stay exactly as recorded.
 */
export async function replayFlow(
  env: Env,
  flow: Flow,
  opts: { heal?: boolean; tenantId?: string } = {}
): Promise<ReplayOutcome> {
  const owner = opts.tenantId ?? "_admin";
  const t0 = Date.now();
  const proposals: HealProposal[] = [];
  const stepResults: Array<{ step: number; ok: boolean; note?: string }> = [];

  const browser = await acquirePooledBrowser(env);
  try {
    // Behind-the-login-wall flows start from a saved session rather than
    // re-driving the login form on every replay.
    const scope = hostOf(flow.startUrl);
    let storageState: unknown;
    if (flow.auth) {
      const profile = await loadAuthProfile(env, owner, flow.auth, scope);
      if (!profile) {
        return {
          flow: flow.name,
          status: "error",
          stepsRun: 0,
          decision: {
            verdict: "auth_profile_missing",
            whatChanged: `flow requires auth profile "${flow.auth}" for ${scope}, which is not saved`,
            suggestedFix: `run the login flow (the one with saveAuthAs: "${flow.auth}") against ${scope} first`,
            nextAction: `replay the login flow to mint the profile for this environment, then re-run this flow`,
          },
          durationMs: Date.now() - t0,
        };
      }
      storageState = profile.state;
    }

    const context = await browser.newContext({
      viewport: VIEWPORTS[flow.viewport],
      ...(storageState ? { storageState: storageState as never } : {}),
    });
    const page = await context.newPage();
    const buf = bindBuffers(page);

    await page.goto(flow.startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});

    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i]!;
      const seqBefore = buf.seq;

      // Resolve the anchor (if the action needs a target).
      let locator: Locator | undefined;
      if (step.anchor) {
        const { locator: found, via } = resolveAnchor(page, step.anchor);
        const matched = await found.count();
        if (matched === 0) {
          // Drift. Name it, find the nearest survivor, decide.
          const from = step.anchor.testid ?? step.anchor.text ?? step.anchor.css ?? `${step.anchor.role}/${step.anchor.name}`;
          const near = step.anchor.testid
            ? nearestMatch(step.anchor.testid, await candidatesOnPage(page))
            : undefined;
          if (opts.heal && near && step.anchor.testid) {
            proposals.push({ step: i, from: step.anchor.testid, to: near.value, confidence: near.confidence });
            locator = page.getByTestId(near.value).first();
            stepResults.push({ step: i, ok: true, note: `healed ${from} → ${near.value}` });
          } else {
            const key = await finalShot(env, owner, page, flow.name);
            return {
              flow: flow.name,
              status: "drift",
              stepsRun: i,
              failedStep: i,
              decision: {
                verdict: "drift",
                whatChanged: `step ${i}: anchor "${from}" (via ${via}) not found on the live page`,
                suggestedFix: near
                  ? `rebind the anchor to "${near.value}" (closest survivor, ${Math.round(near.confidence * 100)}% similar)`
                  : "no confident nearest match — the element may have been removed",
                nextAction: near
                  ? `run flow heal to rebind, or update the flow if the change was intended`
                  : `re-record this step, or restore the element`,
              },
              durationMs: Date.now() - t0,
              screenshotKey: key,
              proposals: proposals.length ? proposals : undefined,
              stepResults,
            };
          }
        } else {
          locator = found.first();
          stepResults.push({ step: i, ok: true });
        }
      } else {
        stepResults.push({ step: i, ok: true });
      }

      // Perform the action.
      const a = step.action;
      try {
        switch (a.action) {
          case "goto":
            await page.goto(a.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
            break;
          case "back":
            await page.goBack({ timeout: 10_000 });
            break;
          case "reload":
            await page.reload({ timeout: 30_000 });
            break;
          case "wait":
            await page.waitForTimeout(a.ms);
            break;
          case "scroll":
            await page.mouse.wheel(0, a.direction === "down" ? a.amount : -a.amount);
            break;
          case "click":
            await requireLocator(locator, i).click({ timeout: 5_000 });
            break;
          case "fill":
            await requireLocator(locator, i).fill(a.value, { timeout: 5_000 });
            break;
          case "select":
            await requireLocator(locator, i).selectOption(a.value, { timeout: 5_000 });
            break;
          case "press":
            if (locator) await locator.press(a.key, { timeout: 5_000 });
            else await page.keyboard.press(a.key);
            break;
          case "hover":
            await requireLocator(locator, i).hover({ timeout: 5_000 });
            break;
        }
      } catch (err) {
        const key = await finalShot(env, owner, page, flow.name);
        return {
          flow: flow.name,
          status: "error",
          stepsRun: i,
          failedStep: i,
          decision: {
            verdict: "error",
            whatChanged: `step ${i} (${a.action}) failed: ${String(err).slice(0, 200)}`,
            nextAction: "the element resolved but the action failed — check if it's disabled, covered, or detached",
          },
          durationMs: Date.now() - t0,
          screenshotKey: key,
          stepResults,
        };
      }

      await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});

      // Step expectations — scoped to this step's event window.
      if (step.expect.length > 0) {
        const results = await evalAllSettled(page, buf, scopePredicates(step.expect, seqBefore));
        const failed = results.filter((r) => !r.pass);
        if (failed.length > 0) {
          const key = await finalShot(env, owner, page, flow.name);
          return {
            flow: flow.name,
            status: "error",
            stepsRun: i + 1,
            failedStep: i,
            decision: {
              verdict: "expectation_failed",
              whatChanged: `step ${i}: ${failed.map((f) => f.evidence).join("; ")}`,
              nextAction:
                "the action landed but its expected consequence did not occur — this is the silent-failure class; check the handler and the network call it should make",
            },
            evidenceTier: weakestTier(results),
            durationMs: Date.now() - t0,
            screenshotKey: key,
            stepResults,
          };
        }
      }
    }

    // The golden end condition.
    const successResults = await evalAllSettled(page, buf, flow.success);
    const failedSuccess = successResults.filter((r) => !r.pass);
    const key = await finalShot(env, owner, page, flow.name);

    if (failedSuccess.length > 0) {
      return {
        flow: flow.name,
        status: "error",
        stepsRun: flow.steps.length,
        decision: {
          verdict: "success_condition_failed",
          whatChanged: failedSuccess.map((f) => f.evidence).join("; "),
          nextAction:
            "every step ran but the flow's success condition does not hold — the journey completes visually without achieving its outcome",
        },
        evidenceTier: weakestTier(successResults),
        durationMs: Date.now() - t0,
        screenshotKey: key,
        stepResults,
      };
    }

    // A login flow only mints its auth profile once it actually succeeded —
    // never persist a session from a flow that failed to sign in.
    let authSaved: { name: string; cookies: number } | undefined;
    if (flow.saveAuthAs) {
      const state = await page.context().storageState();
      const saved = await saveAuthProfile(
        env,
        owner,
        flow.saveAuthAs,
        scope,
        state as never,
        page.url()
      );
      authSaved = { name: saved.name, cookies: saved.cookies };
    }

    return {
      flow: flow.name,
      status: "ok",
      stepsRun: flow.steps.length,
      evidenceTier: weakestTier(successResults),
      durationMs: Date.now() - t0,
      screenshotKey: key,
      proposals: proposals.length ? proposals : undefined,
      stepResults,
      authSaved,
    };
  } finally {
    await releasePooledBrowser(env, browser);
  }
}

function requireLocator(locator: Locator | undefined, step: number): Locator {
  if (!locator) throw new Error(`step ${step} needs an anchor but none resolved`);
  return locator;
}

async function finalShot(
  env: Env,
  tenantId: string,
  page: Page,
  flowName: string
): Promise<string | undefined> {
  try {
    const png = await page.screenshot({ type: "png" });
    const key = `tenants/${tenantId}/flows/${flowName}/${Date.now()}.png`;
    await env.ARTIFACTS.put(key, png, { httpMetadata: { contentType: "image/png" } });
    return key;
  } catch {
    return undefined;
  }
}

/**
 * Replay many flows with bounded parallelism; one consolidated verdict.
 *
 * Ordering rule: flows that MINT an auth profile (`saveAuthAs`) run first, as
 * a wave, because flows that CONSUME one (`auth`) would otherwise race a
 * profile that doesn't exist yet. Within each wave, everything is parallel.
 */
export async function verifyFlows(
  env: Env,
  inputFlows: Flow[],
  concurrency = 4,
  baseUrl?: string,
  tenantId = "_admin"
): Promise<{
  status: "pass" | "fail";
  total: number;
  passed: number;
  failed: number;
  summary: string;
  results: ReplayOutcome[];
}> {
  const flows = baseUrl ? inputFlows.map((f) => rehomeFlow(f, baseUrl)) : inputFlows;
  const results: ReplayOutcome[] = new Array(flows.length);

  const runWave = async (indices: number[]) => {
    let next = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, indices.length) },
      async () => {
        for (;;) {
          const slot = next++;
          if (slot >= indices.length) return;
          const i = indices[slot]!;
          try {
            results[i] = await replayFlow(env, flows[i]!, { tenantId });
          } catch (err) {
            results[i] = {
              flow: flows[i]!.name,
              status: "error",
              stepsRun: 0,
              decision: {
                verdict: "error",
                whatChanged: String(err).slice(0, 200),
                nextAction:
                  "replay crashed before the first step — check the start URL is reachable",
              },
              durationMs: 0,
            };
          }
        }
      }
    );
    await Promise.all(workers);
  };

  const authWave: number[] = [];
  const mainWave: number[] = [];
  flows.forEach((f, i) => (f.saveAuthAs ? authWave : mainWave).push(i));
  if (authWave.length > 0) await runWave(authWave);
  await runWave(mainWave);

  const passed = results.filter((r) => r.status === "ok").length;
  const failed = results.length - passed;
  const failures = results.filter((r) => r.status !== "ok");
  return {
    status: failed === 0 ? "pass" : "fail",
    total: results.length,
    passed,
    failed,
    summary:
      failed === 0
        ? `${passed}/${results.length} flows pass`
        : `${passed}/${results.length} flows pass — ${failed} need attention: ${failures
            .map((f) => f.flow)
            .join(", ")}`,
    results,
  };
}
