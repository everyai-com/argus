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
import { acquirePooledBrowser, FleetBusyError, releasePooledBrowser } from "./pool";
import type { Page, Locator } from "@cloudflare/playwright";
import {
  type ConsoleEvent,
  type Flow,
  type FlowReplayResult,
  type NetworkEvent,
  type Predicate,
  type PredicateResult,
  type StreamEvent,
  type SuiteStatus,
  type NetworkProfile,
} from "@argus/shared";
import { evalPredicate, nearestMatch, resolveAnchor, weakestTier } from "./verify";
import { triageFlowFailure } from "./judge";
import { hostOf, loadAuthProfile, saveAuthProfile } from "./auth-store";
import { applyNetwork, applyViewport, contextOptionsFor, persistPredicates, rehomeFlow, settleBudget, trackInflight, waitForQuiet } from "./flow-utils";
import { putFlow } from "./flows-store";
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
  stream: StreamEvent[];
  seq: number;
}

/** A Playwright WebSocket frame payload, stringified and capped. */
function framePayload(frame: unknown): string {
  const payload = (frame as { payload?: unknown })?.payload;
  if (payload === undefined || payload === null) return "";
  return (typeof payload === "string" ? payload : String(payload)).slice(0, 500);
}

function bindBuffers(page: Page): Buffers {
  const buf: Buffers = { network: [], console: [], stream: [], seq: 0 };
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
    if ((res.headers()["content-type"] ?? "").includes("text/event-stream")) {
      buf.stream.push({
        seq: ++buf.seq,
        stream: "sse",
        url: req.url().slice(0, 300),
        direction: "open",
        at: Date.now(),
      });
    }
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
  page.on("websocket", (ws) => {
    const url = ws.url().slice(0, 300);
    buf.stream.push({ seq: ++buf.seq, stream: "websocket", url, direction: "open", at: Date.now() });
    ws.on("framesent", (frame) =>
      buf.stream.push({
        seq: ++buf.seq,
        stream: "websocket",
        url,
        direction: "sent",
        data: framePayload(frame),
        at: Date.now(),
      })
    );
    ws.on("framereceived", (frame) =>
      buf.stream.push({
        seq: ++buf.seq,
        stream: "websocket",
        url,
        direction: "received",
        data: framePayload(frame),
        at: Date.now(),
      })
    );
    ws.on("close", () =>
      buf.stream.push({ seq: ++buf.seq, stream: "websocket", url, direction: "close", at: Date.now() })
    );
  });
  return buf;
}

/**
 * Rescope event-window predicates to "since this step started" (incl. groups).
 *
 * Contract agents rely on: a step's `expect` predicates observe only events
 * after their step started — replay overwrites any hand-set `since`. The
 * flow's `success` predicates observe the whole run. A step expectation that
 * must see earlier events (e.g. "no console error anywhere so far") opts out
 * with `cumulative: true`, which keeps its `since` untouched.
 */
function scopePredicates(predicates: Predicate[], since: number): Predicate[] {
  return predicates.map((p) => {
    if (p.kind === "allOf" || p.kind === "anyOf") {
      return { ...p, predicates: scopePredicates(p.predicates, since) };
    }
    if (p.kind === "network" || p.kind === "console-clean" || p.kind === "stream" || p.kind === "signal") {
      if ("cumulative" in p && p.cumulative) return p;
      return { ...p, since };
    }
    return p;
  });
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

/** Describe up to 5 matched elements so an ambiguous anchor names its candidates. */
async function describeCandidates(locator: Locator, total: number): Promise<string[]> {
  try {
    const infos = (await locator.evaluateAll((els) =>
      (els as unknown as any[]).slice(0, 5).map((el) => {
        const text = String(el.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 60);
        const testid = el.getAttribute("data-testid");
        return `${String(el.tagName).toLowerCase()}${testid ? `[data-testid="${testid}"]` : ""}${text ? ` "${text}"` : ""}`;
      })
    )) as string[];
    return total > infos.length ? [...infos, `+${total - infos.length} more`] : infos;
  } catch {
    return [];
  }
}

/**
 * The ambiguity decision — pure so it's unit-testable without a browser.
 * An anchor matching N>1 elements is an error, never a guess: .first() would
 * silently drive the wrong element and bless a false green.
 */
export function ambiguityDecision(
  step: number,
  from: string,
  via: string,
  count: number,
  candidates: string[]
): { verdict: "ambiguous_anchor"; whatChanged: string; suggestedFix: string; nextAction: string } {
  const shown = candidates.length ? ` — candidates: ${candidates.join(" · ")}` : "";
  return {
    verdict: "ambiguous_anchor",
    whatChanged: `step ${step}: anchor "${from}" (via ${via}) matched ${count} elements${shown}`,
    suggestedFix:
      "tighten the anchor until it matches exactly one element — prefer a unique data-testid, else role+name",
    nextAction:
      "disambiguate the anchor in the flow file (or remove the duplicate element from the page) and re-run",
  };
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
  opts: { heal?: boolean; tenantId?: string; judge?: boolean } = {}
): Promise<ReplayOutcome> {
  const owner = opts.tenantId ?? "_admin";
  const t0 = Date.now();
  const proposals: HealProposal[] = [];
  const stepResults: Array<{ step: number; ok: boolean; note?: string }> = [];

  const pooled = await acquirePooledBrowser(env, owner, `flow:${flow.name}`);
  const browser = pooled.browser;
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
      ...contextOptionsFor(flow.viewport, browser.version()),
      ...(storageState ? { storageState: storageState as never } : {}),
    });
    const page = await context.newPage();
    const buf = bindBuffers(page);
    trackInflight(page);

    await page.goto(flow.startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});

    let network: NetworkProfile = "none"; // a recorded throttle is replayed as a step
    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i]!;
      const seqBefore = buf.seq;

      // Resolve the anchor (if the action needs a target).
      let locator: Locator | undefined;
      if (step.anchor) {
        const { locator: found, via } = resolveAnchor(page, step.anchor);
        const matched = await found.count();
        const from = step.anchor.testid ?? step.anchor.text ?? step.anchor.css ?? `${step.anchor.role}/${step.anchor.name}`;
        if (matched > 1) {
          // Ambiguity is an error, never a guess.
          const key = await finalShot(env, owner, page, flow.name);
          return await withTriage(env, {
            flow: flow.name,
            status: "error",
            stepsRun: i,
            failedStep: i,
            decision: ambiguityDecision(i, from, via, matched, await describeCandidates(found, matched)),
            durationMs: Date.now() - t0,
            screenshotKey: key,
            stepResults: failStep(stepResults, i, "ambiguous anchor"),
          }, { buf, judge: opts.judge });
        }
        if (matched === 0) {
          // Drift. Name it, find the nearest survivor, decide.
          const near = step.anchor.testid
            ? nearestMatch(step.anchor.testid, await candidatesOnPage(page))
            : undefined;
          // A heal target must itself resolve to exactly one element — a
          // rebind onto an ambiguous (or vanished) id is a guess, not a fix.
          const healTarget = opts.heal && near && step.anchor.testid ? page.getByTestId(near.value) : undefined;
          const healCount = healTarget ? await healTarget.count() : 0;
          if (healTarget && near && step.anchor.testid && healCount === 1) {
            proposals.push({ step: i, from: step.anchor.testid, to: near.value, confidence: near.confidence });
            locator = healTarget.first();
            stepResults.push({ step: i, ok: true, note: `healed ${from} → ${near.value}` });
          } else if (healTarget && near && healCount > 1) {
            const key = await finalShot(env, owner, page, flow.name);
            return await withTriage(env, {
              flow: flow.name,
              status: "error",
              stepsRun: i,
              failedStep: i,
              decision: ambiguityDecision(i, near.value, "testid", healCount, await describeCandidates(healTarget, healCount)),
              durationMs: Date.now() - t0,
              screenshotKey: key,
              proposals: proposals.length ? proposals : undefined,
              stepResults: failStep(stepResults, i, "ambiguous heal target"),
            }, { buf, judge: opts.judge });
          } else {
            const key = await finalShot(env, owner, page, flow.name);
            return await withTriage(env, {
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
                ...(near ? { action: { tool: "argus_flow_heal", args: { name: flow.name } } } : {}),
              },
              durationMs: Date.now() - t0,
              screenshotKey: key,
              proposals: proposals.length ? proposals : undefined,
              stepResults: failStep(stepResults, i, "anchor not found"),
            }, { buf, judge: opts.judge });
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
      const stepStart = Date.now();
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
          case "viewport":
            await applyViewport(page, a);
            break;
          case "network":
            await applyNetwork(page, a.profile);
            network = a.profile;
            break;
          case "scroll":
            await page.mouse.wheel(0, a.direction === "down" ? a.amount : -a.amount);
            break;
          case "click":
            await requireLocator(locator, i).click({ timeout: 5_000, clickCount: a.clickCount });
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
        return await withTriage(env, {
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
          stepResults: failStep(stepResults, i, "action failed"),
        }, { buf, judge: opts.judge });
      }

      await waitForQuiet(page, stepStart, settleBudget(3_000, network));

      // Step expectations — scoped to this step's event window.
      if (step.expect.length > 0) {
        const results = await evalAllSettled(page, buf, scopePredicates(step.expect, seqBefore));
        const failed = results.filter((r) => !r.pass);
        if (failed.length > 0) {
          const key = await finalShot(env, owner, page, flow.name);
          return await withTriage(env, {
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
            stepResults: failStep(stepResults, i, "expectation failed"),
          }, { buf, judge: opts.judge });
        }
      }
    }

    // The golden end condition.
    const successResults = await evalAllSettled(page, buf, flow.success);
    const failedSuccess = successResults.filter((r) => !r.pass);
    const key = await finalShot(env, owner, page, flow.name);

    if (failedSuccess.length > 0) {
      return await withTriage(env, {
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
      }, { buf, judge: opts.judge });
    }

    // Held on screen — does it survive a reload? An optimistic UI that never
    // saved passes `success` and fails here (the bug a first-time user finds
    // by coming back, and a per-step check never sees).
    const persist = persistPredicates(flow);
    if (persist.length > 0) {
      const tReload = Date.now();
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitForQuiet(page, tReload, settleBudget(3_000, network));
      const kept = await evalAllSettled(page, buf, persist);
      const lost = kept.filter((r) => !r.pass);
      if (lost.length > 0) {
        return await withTriage(env, {
          flow: flow.name,
          status: "error",
          stepsRun: flow.steps.length,
          decision: {
            verdict: "not_persisted",
            whatChanged: `after a reload: ${lost.map((f) => f.evidence).join("; ")}`,
            nextAction:
              "the outcome showed on screen but did not survive a reload — it was never saved, or saved somewhere the page does not read back",
          },
          evidenceTier: weakestTier(kept),
          durationMs: Date.now() - t0,
          screenshotKey: await finalShot(env, owner, page, flow.name),
          stepResults,
        }, { buf, judge: opts.judge });
      }
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
    await releasePooledBrowser(env, pooled);
  }
}

/**
 * Mark the step a replay stopped on as failed. Entries are pushed once the
 * anchor resolves — before the action runs and its expectations are checked —
 * so without this a verdict could say failedStep: 2 while step 2 read ok.
 */
function failStep(
  stepResults: Array<{ step: number; ok: boolean; note?: string }>,
  step: number,
  note: string
): Array<{ step: number; ok: boolean; note?: string }> {
  const entry = stepResults.find((r) => r.step === step);
  if (entry) {
    entry.ok = false;
    entry.note = entry.note ? `${entry.note}; ${note}` : note;
  } else {
    stepResults.push({ step, ok: false, note });
  }
  return stepResults;
}

function requireLocator(locator: Locator | undefined, step: number): Locator {
  if (!locator) throw new Error(`step ${step} needs an anchor but none resolved`);
  return locator;
}

/**
 * Attach vision-judge triage to a failed replay. Purely additive: status,
 * verdict and evidence are already final — triage only adds bug class,
 * severity and needs-human. Passes never call this (zero cost on green).
 * The judge can never break a replay: any failure returns the outcome as-is.
 */
async function withTriage(
  env: Env,
  outcome: ReplayOutcome,
  ctx: { buf: Buffers; judge?: boolean }
): Promise<ReplayOutcome> {
  if (ctx.judge === false || !outcome.decision || !outcome.screenshotKey) return outcome;
  try {
    let png: ArrayBuffer | undefined;
    try {
      const obj = await env.ARTIFACTS.get(outcome.screenshotKey);
      if (obj) png = await obj.arrayBuffer();
    } catch {
      // Text-only triage: the trace summary alone is still worth judging.
    }
    const triage = await triageFlowFailure(env, {
      verdict: outcome.decision.verdict,
      whatChanged: outcome.decision.whatChanged,
      failedStep: outcome.failedStep,
      stepsRun: outcome.stepsRun,
      consoleErrors: ctx.buf.console.filter((c) => c.level === "error").map((c) => c.text),
      failedRequests: ctx.buf.network
        .filter((n) => n.failed)
        .map((n) => `${n.method} ${n.url} → ${n.status ?? "failed"}`),
      screenshotPng: png,
    });
    if (triage) outcome.triage = triage;
  } catch {
    // Judge abstained — deterministic outcome stands.
  }
  return outcome;
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
  tenantId = "_admin",
  judge = true,
  opts: { confirm?: boolean; saveRepros?: boolean } = {}
): Promise<{
  status: SuiteStatus;
  total: number;
  passed: number;
  /** Failures confirmed by a second, agreeing replay (or unconfirmed when confirm is off). */
  failed: number;
  /** Failed once, then disagreed on the re-run — not reliably tested; never fails a build. */
  flaky: number;
  /** Argus could not test these (no browser slot, missing auth profile, unreachable start). */
  untested: number;
  summary: string;
  results: ReplayOutcome[];
}> {
  const confirm = opts.confirm ?? true;
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
            results[i] = await replayFlow(env, flows[i]!, { tenantId, judge });
          } catch (err) {
            results[i] = {
              flow: flows[i]!.name,
              status: "error",
              stepsRun: 0,
              decision:
                err instanceof FleetBusyError
                  ? {
                      // Not the app's fault — never let it read as a regression.
                      verdict: "fleet_busy",
                      whatChanged: `no browser slot: ${err.reason} — ${err.message}`.slice(0, 200),
                      nextAction:
                        "the app was not tested; re-run with lower concurrency, release idle sessions, or retry shortly",
                    }
                  : {
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

  // Point auth failures at their minting flow: the agent can execute the
  // recovery (replay the login flow, then this suite) without hunting for
  // which flow saves the missing profile. Rehomed suites carry baseUrl so the
  // profile mints for the same environment.
  const authOf = new Map(inputFlows.map((f) => [f.name, f.auth]));
  const savers = new Map<string, string>();
  for (const f of inputFlows) if (f.saveAuthAs) savers.set(f.saveAuthAs, f.name);
  for (const r of results) {
    const d = r.decision;
    if (!d || d.verdict !== "auth_profile_missing" || d.action) continue;
    const profile = authOf.get(r.flow);
    const saver = profile ? savers.get(profile) : undefined;
    if (saver) {
      d.action = {
        tool: "argus_flow_verify",
        args: { names: [saver], ...(baseUrl ? { baseUrl } : {}) },
      };
    }
  }

  // Only a repeated failure counts. Re-run each product failure once (no
  // judge — code decides): agreement confirms it; disagreement makes it flaky,
  // which is reported loudly but can never fail a build on its own.
  const toConfirm = confirm
    ? results.map((r, i) => ({ r, i })).filter(({ r }) => r.status !== "ok" && !isUntested(r))
    : [];
  if (toConfirm.length > 0) {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, toConfirm.length) }, async () => {
        for (;;) {
          const item = toConfirm[next++];
          if (!item) return;
          const second = await replayFlow(env, flows[item.i]!, { tenantId, judge: false }).catch(
            (err): ReplayOutcome => ({
              flow: item.r.flow,
              status: "error",
              stepsRun: 0,
              decision: { verdict: err instanceof FleetBusyError ? "fleet_busy" : "error", whatChanged: String(err).slice(0, 200), nextAction: "" },
              durationMs: 0,
            })
          );
          const agree = second.status !== "ok" && failureSignature(second) === failureSignature(item.r);
          item.r.confirmation = {
            state: agree ? "confirmed" : "flaky",
            ...(agree
              ? {}
              : {
                  second: {
                    status: second.status,
                    verdict: second.decision?.verdict,
                    failedStep: second.failedStep,
                    whatChanged: second.decision?.whatChanged,
                  },
                }),
          };
        }
      })
    );
  }

  // A confirmed failure leaves a named repro in the tenant's flow library, so
  // any agent (or a GitHub issue) can replay exactly this failure by name.
  if (opts.saveRepros !== false) {
    for (const r of results) {
      if (r.status === "ok" || isUntested(r) || r.confirmation?.state === "flaky") continue;
      const flow = flows.find((f) => f.name === r.flow);
      if (!flow) continue;
      const name = await reproName(flow.name, r);
      const step = r.failedStep;
      const repro: Flow = {
        ...flow,
        name,
        steps: flow.steps.map((st, idx) =>
          idx === step ? { ...st, label: `REPRO: ${(r.decision?.whatChanged ?? "fails here").slice(0, 160)}` } : st
        ),
      };
      try {
        await putFlow(env, tenantId, repro);
        r.reproFlow = name;
        if (r.decision && !r.decision.action) {
          r.decision.action = { tool: "argus_flow_replay", args: { name } };
        }
      } catch {
        /* the repro is a convenience; the verdict stands without it */
      }
    }
  }

  const passed = results.filter((r) => r.status === "ok").length;
  const untestedList = results.filter((r) => r.status !== "ok" && isUntested(r));
  const flakyList = results.filter((r) => r.status !== "ok" && !isUntested(r) && r.confirmation?.state === "flaky");
  const failures = results.filter(
    (r) => r.status !== "ok" && !isUntested(r) && r.confirmation?.state !== "flaky"
  );
  const status: SuiteStatus =
    failures.length > 0 ? "fail" : flakyList.length > 0 ? "flaky" : untestedList.length > 0 ? "untested" : "pass";
  const parts = [`${passed}/${results.length} flows pass`];
  if (failures.length) parts.push(`${failures.length} failed: ${failures.map((f) => f.flow).join(", ")}`);
  if (flakyList.length) parts.push(`${flakyList.length} flaky: ${flakyList.map((f) => f.flow).join(", ")}`);
  if (untestedList.length) parts.push(`${untestedList.length} untested: ${untestedList.map((f) => f.flow).join(", ")}`);
  return {
    status,
    total: results.length,
    passed,
    failed: failures.length,
    flaky: flakyList.length,
    untested: untestedList.length,
    summary: parts.join(" — "),
    results,
  };
}

/**
 * Argus could not test this flow — the app is not at fault: no browser slot,
 * a missing auth profile, or a crash before the first step ran.
 */
export function isUntested(r: ReplayOutcome): boolean {
  const v = r.decision?.verdict;
  return (
    v === "fleet_busy" ||
    v === "auth_profile_missing" ||
    (v === "error" && r.stepsRun === 0 && r.failedStep === undefined)
  );
}

/**
 * Two replays agree when code reached the same result: same status, same
 * verdict, same step, same evidence text. Screens are never compared.
 */
export function failureSignature(r: ReplayOutcome): string {
  // Timestamps, ids and durations (4+ digits) differ run to run without the
  // failure differing; small numbers ("2 task(s)" vs "3") are real evidence.
  const evidence = (r.decision?.whatChanged ?? "").replace(/\d{4,}/g, "#");
  return [r.status, r.decision?.verdict ?? "", r.failedStep ?? "", evidence].join("|");
}

async function reproName(flowName: string, r: ReplayOutcome): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${flowName}|${r.decision?.verdict}|${r.failedStep}|${r.decision?.whatChanged}`)
  );
  const hex = [...new Uint8Array(digest)].slice(0, 3).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `repro-${flowName}`.slice(0, 80) + `-${hex}`;
}
