/**
 * LocalDriver — the Driver on a Chromium on this machine (playwright-core).
 *
 * Anchors resolve through `@argus/core`, the same ladder and the same
 * ambiguity refusal the cloud's flow replay uses. Nothing here needs a model
 * or an Argus token.
 */
import type { Locator as PwLocator, Page as PwPage } from "playwright-core";
import type { Action, Anchor, AnchorResolution, Predicate, PredicateResult } from "@argus/shared";
import {
  ambiguityDecision,
  bindBuffers,
  describeAnchor,
  describeCandidates,
  evalPredicate,
  nearestMatch,
  readHorizontalOverflow,
  resolveAnchor,
  testidsOnPage,
  type AnchorVia,
  type Buffers,
  type OverflowReading,
} from "@argus/core";
import type {
  CheckOutcome,
  Driver,
  ElementCheck,
  ElementRead,
  ObservedEvents,
  TextExpectation,
} from "./driver.ts";
import { ArgusTestError, fail } from "./errors.ts";

/**
 * An anchor that matches several elements is refused, but only once it has
 * stayed ambiguous this long: a list re-rendering can show two matches for a
 * frame, and that is not what the refusal is for.
 */
const AMBIGUITY_GRACE_MS = 250;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll delays: tight at first (most things are already true), then relaxed. */
function* backoff(): Generator<number> {
  yield* [10, 20, 40, 60];
  for (;;) yield 100;
}

export const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

function show(expected: TextExpectation): string {
  return typeof expected === "string" ? JSON.stringify(expected) : String(expected);
}

function textMatches(
  actual: string,
  expected: TextExpectation,
  mode: "exact" | "contains",
  ignoreCase = false
): boolean {
  if (expected instanceof RegExp) return expected.test(actual);
  const a = ignoreCase ? actual.toLowerCase() : actual;
  const e = ignoreCase ? normalize(expected).toLowerCase() : normalize(expected);
  return mode === "exact" ? a === e : a.includes(e);
}

/**
 * Runs in the page. A password field is the obvious secure field; the
 * autocomplete tokens catch the same data behind a "show password" toggle
 * (which flips `type` to text) and one-time codes / card numbers.
 */
const isSecureField = (el: any): boolean => {
  const attr = (name: string) => String((el.getAttribute && el.getAttribute(name)) || "").toLowerCase();
  if (attr("type") === "password") return true;
  return /(^|\s)(current-password|new-password|one-time-code|cc-number|cc-csc)(\s|$)/.test(
    attr("autocomplete")
  );
};

/** Rendered text, the way the cloud's `text` predicate reads it (innerText). */
const renderedTexts = (els: any[]): string[] =>
  els.map((el) => String(typeof el.innerText === "string" ? el.innerText : (el.textContent ?? "")));

type Snapshot =
  | { state: "ok"; pass: boolean; actual: string; resolution: AnchorResolution }
  | { state: "missing"; via: AnchorVia }
  | { state: "ambiguous"; via: AnchorVia; count: number; locator: PwLocator };

export interface LocalDriverOptions {
  /** Relative `goto` targets resolve against this. */
  baseURL?: string;
}

export class LocalDriver implements Driver {
  private readonly page: PwPage;
  private readonly baseURL?: string;
  private readonly buffers: Buffers;
  private lastActionSeq = 0;
  private inflight = 0;
  private lastNetworkAt = Date.now();

  constructor(page: PwPage, opts: LocalDriverOptions = {}) {
    this.page = page;
    this.baseURL = opts.baseURL;
    this.buffers = bindBuffers(page);
    const touch = (delta: number) => () => {
      this.inflight = Math.max(0, this.inflight + delta);
      this.lastNetworkAt = Date.now();
    };
    page.on("request", touch(+1));
    page.on("requestfinished", touch(-1));
    page.on("requestfailed", touch(-1));
  }

  // ---- resolution: exactly one element, or a refusal ------------------------

  private async ambiguous(anchor: Anchor, via: AnchorVia, count: number, locator: PwLocator): Promise<never> {
    const d = ambiguityDecision(
      undefined,
      describeAnchor(anchor),
      via,
      count,
      await describeCandidates(locator, count)
    );
    return fail({
      ...d,
      nextAction: "disambiguate the anchor in the test (or remove the duplicate element from the page) and re-run",
    });
  }

  private async notFound(anchor: Anchor, via: AnchorVia, doing: string): Promise<never> {
    const near = anchor.testid ? nearestMatch(anchor.testid, await testidsOnPage(this.page)) : undefined;
    return fail({
      verdict: "drift",
      whatChanged: `${doing}: anchor "${describeAnchor(anchor)}" (via ${via}) not found on the page`,
      suggestedFix: near
        ? `the closest surviving testid is "${near.value}" (${Math.round(near.confidence * 100)}% similar)`
        : "no confident nearest match — the element may not be rendered, or the anchor is wrong",
      nextAction: near
        ? "rebind the anchor if the rename was intended, otherwise restore the element"
        : "check the page actually reached the state this step expects (see the failure screenshot)",
    });
  }

  /** Wait for the anchor to match exactly one element. Zero or several is a refusal. */
  private async resolveUnique(
    anchor: Anchor,
    deadline: number,
    doing: string
  ): Promise<{ locator: PwLocator; resolution: AnchorResolution }> {
    const { locator, via } = resolveAnchor(this.page, anchor);
    let ambiguousSince: number | undefined;
    for (const delay of backoff()) {
      const count = await locator.count();
      const now = Date.now();
      if (count === 1) return { locator, resolution: { via, matched: 1 } };
      if (count > 1) {
        ambiguousSince ??= now;
        if (now - ambiguousSince >= AMBIGUITY_GRACE_MS || now >= deadline)
          return this.ambiguous(anchor, via, count, locator);
      } else {
        ambiguousSince = undefined;
        if (now >= deadline) return this.notFound(anchor, via, doing);
      }
      await sleep(delay);
    }
    throw new Error("unreachable");
  }

  // ---- act -------------------------------------------------------------------

  async act(action: Action, opts: { timeoutMs: number }): Promise<{ resolution?: AnchorResolution }> {
    const deadline = Date.now() + opts.timeoutMs;
    this.lastActionSeq = this.buffers.seq;
    const page = this.page;

    switch (action.action) {
      case "goto": {
        const url = this.baseURL ? new URL(action.url, this.baseURL).toString() : action.url;
        await this.pageOp(`goto ${url}`, () => page.goto(url, { waitUntil: "load", timeout: opts.timeoutMs }));
        return {};
      }
      case "back":
        await this.pageOp("back", () => page.goBack({ timeout: opts.timeoutMs }));
        return {};
      case "reload":
        await this.pageOp("reload", () => page.reload({ timeout: opts.timeoutMs }));
        return {};
      case "wait":
        await page.waitForTimeout(action.ms);
        return {};
      case "scroll":
        await page.mouse.wheel(0, action.direction === "down" ? action.amount : -action.amount);
        return {};
      case "press":
        if (!action.anchor) {
          await page.keyboard.press(action.key);
          return {};
        }
        break;
      default:
        break;
    }

    const anchor = action.anchor;
    if (!anchor) throw new Error(`${action.action} needs an anchor`);
    const doing = `${action.action} on "${describeAnchor(anchor)}"`;
    const { locator, resolution } = await this.resolveUnique(anchor, deadline, action.action);
    const timeout = Math.max(1, deadline - Date.now());
    // A value typed into a secure field must not surface in a failure message.
    const scrub = action.action === "fill" ? action.value : undefined;
    try {
      switch (action.action) {
        case "click":
          await locator.click({ timeout });
          break;
        case "fill":
          await locator.fill(action.value, { timeout });
          break;
        case "select":
          await locator.selectOption(action.value, { timeout });
          break;
        case "press":
          await locator.press(action.key, { timeout });
          break;
        case "hover":
          await locator.hover({ timeout });
          break;
      }
    } catch (err) {
      fail({
        verdict: "error",
        whatChanged: `${doing} failed: ${explain(err, scrub)}`,
        nextAction: "the element resolved but the action failed — check if it's disabled, covered, or detached",
      });
    }
    return { resolution };
  }

  private async pageOp(what: string, op: () => Promise<unknown>): Promise<void> {
    try {
      await op();
    } catch (err) {
      fail({
        verdict: "error",
        whatChanged: `${what} failed: ${explain(err)}`,
        nextAction: "check the URL is reachable and the app under test is up",
      });
    }
  }

  // ---- check -----------------------------------------------------------------

  async check(
    anchor: Anchor,
    check: ElementCheck,
    opts: { timeoutMs: number; negate: boolean }
  ): Promise<CheckOutcome> {
    const deadline = Date.now() + opts.timeoutMs;
    let ambiguousSince: number | undefined;
    let last: Snapshot | undefined;
    for (const delay of backoff()) {
      let snap: Snapshot | undefined;
      try {
        snap = await this.snapshot(anchor, check);
      } catch (err) {
        if (err instanceof ArgusTestError) throw err;
        // The element detached or the page navigated mid-read: look again.
      }
      const now = Date.now();
      if (snap) {
        last = snap;
        if (snap.state === "ambiguous") {
          ambiguousSince ??= now;
          if (now - ambiguousSince >= AMBIGUITY_GRACE_MS || now >= deadline)
            return this.ambiguous(anchor, snap.via, snap.count, snap.locator);
        } else {
          ambiguousSince = undefined;
          if (snap.state === "ok" && snap.pass !== opts.negate) return snap;
        }
      }
      if (now >= deadline) break;
      await sleep(delay);
    }
    if (last?.state === "ok") return last;
    const via = last ? last.via : resolveAnchor(this.page, anchor).via;
    // A check that has to read the element cannot hold — or fail to hold —
    // on an element that is not there. Absence is its own answer.
    return { pass: false, missing: true, actual: `anchor not found (via ${via})`, resolution: { via, matched: 0 } };
  }

  /** One look at the page: does the check hold right now? */
  private async snapshot(anchor: Anchor, check: ElementCheck): Promise<Snapshot> {
    const { locator, via } = resolveAnchor(this.page, anchor);
    const count = await locator.count();
    const resolution: AnchorResolution = { via, matched: count };
    const ok = (pass: boolean, actual: string): Snapshot => ({ state: "ok", pass, actual, resolution });

    if (check.kind === "count") return ok(count === check.expected, `${count} element(s)`);
    if (check.kind === "texts") {
      const texts = ((await locator.evaluateAll(renderedTexts)) as string[]).map(normalize);
      const pass =
        texts.length === check.expected.length &&
        texts.every((t, i) => textMatches(t, check.expected[i]!, "exact"));
      return ok(pass, JSON.stringify(texts));
    }

    if (count > 1) return { state: "ambiguous", via, count, locator };
    if (count === 0) {
      if (check.kind === "hidden") return ok(true, "not in the page");
      if (check.kind === "visible") return ok(false, "not in the page");
      return { state: "missing", via };
    }

    switch (check.kind) {
      case "visible": {
        const visible = await locator.isVisible();
        return ok(visible, visible ? "visible" : "in the page but not visible");
      }
      case "hidden": {
        const visible = await locator.isVisible();
        return ok(!visible, visible ? "visible" : "not visible");
      }
      case "enabled": {
        const enabled = await locator.isEnabled();
        return ok(enabled, enabled ? "enabled" : "disabled");
      }
      case "disabled": {
        const disabled = await locator.isDisabled();
        return ok(disabled, disabled ? "disabled" : "enabled");
      }
      case "checked": {
        const checked = await locator.isChecked();
        return ok(checked === check.checked, checked ? "checked" : "unchecked");
      }
      case "text": {
        const text = normalize(((await locator.evaluateAll(renderedTexts)) as string[])[0] ?? "");
        return ok(textMatches(text, check.expected, check.mode, check.ignoreCase), `text is ${JSON.stringify(text.slice(0, 200))}`);
      }
      case "value": {
        await this.refuseSecure(locator, anchor, "its value");
        const value = await locator.inputValue({ timeout: 1_000 });
        return ok(textMatches(value, check.expected, "exact"), `value is ${JSON.stringify(value.slice(0, 200))}`);
      }
      case "attribute": {
        if (check.name.toLowerCase() === "value") await this.refuseSecure(locator, anchor, "its value attribute");
        const value = await locator.getAttribute(check.name, { timeout: 1_000 });
        return ok(
          value !== null && textMatches(value, check.expected, "exact"),
          value === null ? `no ${check.name} attribute` : `${check.name} is ${JSON.stringify(value.slice(0, 200))}`
        );
      }
    }
  }

  /** Never return the value of a password field — not to a test, not to a log. */
  private async refuseSecure(locator: PwLocator, anchor: Anchor, what: string): Promise<void> {
    const secure = (await locator.evaluate(isSecureField)) as boolean;
    if (!secure) return;
    fail({
      verdict: "secure_field",
      whatChanged: `refused to read ${what}: "${describeAnchor(anchor)}" is a secure field (password, one-time code or card data)`,
      suggestedFix: "assert a consequence of the value instead — what the app does once it is entered",
      nextAction: "replace the value read with an assertion on visible state, the route or a network call",
    });
  }

  // ---- read ------------------------------------------------------------------

  async read(anchor: Anchor, what: ElementRead, opts: { timeoutMs: number }): Promise<string | number | boolean> {
    if (what === "count") return await resolveAnchor(this.page, anchor).locator.count();
    if (what === "visible") {
      const { locator, via } = resolveAnchor(this.page, anchor);
      const count = await locator.count();
      if (count > 1) return this.ambiguous(anchor, via, count, locator);
      return count === 1 && (await locator.isVisible());
    }
    const { locator } = await this.resolveUnique(anchor, Date.now() + opts.timeoutMs, `read ${what}`);
    if (what === "value") {
      await this.refuseSecure(locator, anchor, "its value");
      return await locator.inputValue({ timeout: 1_000 });
    }
    return normalize(((await locator.evaluateAll(renderedTexts)) as string[])[0] ?? "");
  }

  // ---- predicates ------------------------------------------------------------

  async assert(predicates: Predicate[], opts: { timeoutMs: number }): Promise<PredicateResult[]> {
    const deadline = Date.now() + opts.timeoutMs;
    // "Nothing happened" is only true once the page has stopped talking.
    if (predicates.some(assertsAbsence)) await this.settle(Math.min(2_000, opts.timeoutMs));
    let results: PredicateResult[] = [];
    for (const delay of backoff()) {
      results = [];
      for (const p of predicates) results.push(await evalPredicate(this.page, this.buffers, p));
      if (results.every((r) => r.pass) || Date.now() >= deadline) break;
      await sleep(delay);
    }
    return results;
  }

  // ---- observation -----------------------------------------------------------

  async events(): Promise<ObservedEvents> {
    const { network, console, stream, seq } = this.buffers;
    return { network: [...network], console: [...console], stream: [...stream], seq, lastActionSeq: this.lastActionSeq };
  }

  async settle(maxMs = 2_000, quietMs = 200): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (this.inflight === 0 && Date.now() - this.lastNetworkAt >= quietMs) return;
      await sleep(25);
    }
  }

  async overflow(): Promise<OverflowReading> {
    return await readHorizontalOverflow(this.page);
  }

  async url(): Promise<string> {
    return this.page.url();
  }

  async title(): Promise<string> {
    return await this.page.title();
  }

  async screenshot(): Promise<Uint8Array> {
    return await this.page.screenshot({ type: "png", timeout: 5_000 });
  }

  async close(): Promise<void> {
    await this.page.context().close().catch(() => {});
  }
}

/** A predicate that can pass simply because something has not happened yet. */
function assertsAbsence(p: Predicate): boolean {
  if (p.kind === "allOf" || p.kind === "anyOf") return p.predicates.some(assertsAbsence);
  if (p.kind === "console-clean" || p.kind === "hidden") return true;
  return "maxCount" in p && p.maxCount !== undefined;
}

/**
 * Playwright's error, cut down to what a reader needs: the headline and the
 * last thing it was waiting on. `scrub` (a filled value) never appears.
 */
function explain(err: unknown, scrub?: string): string {
  const lines = String(err instanceof Error ? err.message : err)
    .split("\n")
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, "").trim())
    .filter(Boolean);
  const head = lines[0] ?? "unknown error";
  const log = lines.filter((l) => l.startsWith("- ") && !/^- (waiting for|locator resolved to)/.test(l));
  const tail = log.length ? ` (${log[log.length - 1]!.slice(2)})` : "";
  let text = `${head}${tail}`;
  if (scrub && scrub.trim().length > 0) text = text.split(scrub).join("•••");
  return text.slice(0, 300);
}
