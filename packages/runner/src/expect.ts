/**
 * expect — assertions that wait, and say what they saw.
 *
 * On a `Locator`, `Page` or `Network` an assertion retries until it holds or
 * its budget runs out, then fails with a decision envelope. On any other value
 * it is a plain synchronous comparison. Either way: no model, no token.
 */
import { isDeepStrictEqual } from "node:util";
import type { Predicate } from "@argus/shared";
import { weakestTier } from "@argus/core";
import {
  Locator,
  Network,
  Page,
  matchesRequest,
  traced,
  unexpectedConsoleErrors,
  type RequestMatch,
  type TestContext,
} from "./api.ts";
import type { ElementCheck, TextExpectation } from "./driver.ts";
import { fail } from "./errors.ts";

export interface ExpectOptions {
  /** Budget for this assertion, ms. */
  timeout?: number;
}

const show = (v: unknown): string => {
  if (v instanceof RegExp) return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

// ---------------------------------------------------------------------------
// Locator
// ---------------------------------------------------------------------------

export class LocatorAssertions {
  private readonly target: Locator;
  private readonly negate: boolean;

  constructor(target: Locator, negate = false) {
    this.target = target;
    this.negate = negate;
  }

  get not(): LocatorAssertions {
    return new LocatorAssertions(this.target, !this.negate);
  }

  private run(check: ElementCheck, wanted: string, opts?: ExpectOptions): Promise<void> {
    const { ctx, anchor } = this.target;
    return traced(ctx, async () => {
      const outcome = await ctx.driver.check(anchor, check, {
        timeoutMs: opts?.timeout ?? ctx.expectTimeout,
        negate: this.negate,
      });
      if (!outcome.missing && outcome.pass !== this.negate) return;
      fail({
        verdict: outcome.missing ? "drift" : "expectation_failed",
        whatChanged: `expected "${this.target}" ${this.negate ? "not " : ""}${wanted} — ${outcome.actual}`,
        nextAction: outcome.missing
          ? "the anchor never matched an element — check the page reached this state, or fix the anchor"
          : "the page did not reach the expected state in time — see the failure screenshot",
        evidenceTier: "dom",
      });
    });
  }

  toBeVisible(opts?: ExpectOptions): Promise<void> {
    return this.run({ kind: "visible" }, "to be visible", opts);
  }
  toBeHidden(opts?: ExpectOptions): Promise<void> {
    return this.run({ kind: "hidden" }, "to be hidden", opts);
  }
  toBeEnabled(opts?: ExpectOptions): Promise<void> {
    return this.run({ kind: "enabled" }, "to be enabled", opts);
  }
  toBeDisabled(opts?: ExpectOptions): Promise<void> {
    return this.run({ kind: "disabled" }, "to be disabled", opts);
  }
  toBeChecked(opts?: ExpectOptions): Promise<void> {
    return this.run({ kind: "checked", checked: true }, "to be checked", opts);
  }

  /**
   * The element's rendered text, whole (whitespace collapsed). Pass an array
   * to assert the text of every match, in order — one of the two assertions
   * (with `toHaveCount`) that an anchor matching many elements may answer.
   * Text is what the user sees: a CSS-uppercased label reads uppercased.
   */
  toHaveText(expected: TextExpectation | TextExpectation[], opts?: ExpectOptions & { ignoreCase?: boolean }): Promise<void> {
    if (Array.isArray(expected))
      return this.run({ kind: "texts", expected }, `to have texts ${show(expected.map(String))}`, opts);
    return this.run(
      { kind: "text", expected, mode: "exact", ignoreCase: opts?.ignoreCase },
      `to have text ${show(expected)}`,
      opts
    );
  }
  toContainText(expected: TextExpectation, opts?: ExpectOptions & { ignoreCase?: boolean }): Promise<void> {
    return this.run(
      { kind: "text", expected, mode: "contains", ignoreCase: opts?.ignoreCase },
      `to contain text ${show(expected)}`,
      opts
    );
  }
  /** A form control's value. Refused outright for password and other secure fields. */
  toHaveValue(expected: TextExpectation, opts?: ExpectOptions): Promise<void> {
    return this.run({ kind: "value", expected }, `to have value ${show(expected)}`, opts);
  }
  toHaveAttribute(name: string, expected: TextExpectation, opts?: ExpectOptions): Promise<void> {
    return this.run({ kind: "attribute", name, expected }, `to have ${name}=${show(expected)}`, opts);
  }
  toHaveCount(expected: number, opts?: ExpectOptions): Promise<void> {
    return this.run({ kind: "count", expected }, `to match ${expected} element(s)`, opts);
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export class PageAssertions {
  private readonly ctx: TestContext;
  private readonly negate: boolean;

  constructor(ctx: TestContext, negate = false) {
    this.ctx = ctx;
    this.negate = negate;
  }

  get not(): PageAssertions {
    return new PageAssertions(this.ctx, !this.negate);
  }

  private noNegation(name: string): void {
    if (this.negate) throw new Error(`expect(page).not.${name} is not supported — state what should be true instead`);
  }

  /** Poll a reading of the page until it matches (or, negated, stops matching). */
  private poll(
    read: () => Promise<string>,
    matches: (actual: string) => boolean,
    wanted: string,
    opts?: ExpectOptions
  ): Promise<void> {
    return traced(this.ctx, async () => {
      const deadline = Date.now() + (opts?.timeout ?? this.ctx.expectTimeout);
      let actual = "";
      for (;;) {
        actual = await read();
        if (matches(actual) !== this.negate) return;
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      fail({
        verdict: "expectation_failed",
        whatChanged: `expected the page ${this.negate ? "not " : ""}${wanted} — it is ${show(actual)}`,
        nextAction: "the page did not reach the expected state in time — see the failure screenshot",
        evidenceTier: "consequence",
      });
    });
  }

  /** The current URL: contains the string, or matches the pattern. */
  toHaveURL(expected: TextExpectation, opts?: ExpectOptions): Promise<void> {
    return this.poll(
      () => this.ctx.driver.url(),
      (url) => (typeof expected === "string" ? url.includes(expected) : expected.test(url)),
      `to be at ${show(expected)}`,
      opts
    );
  }
  toHaveTitle(expected: TextExpectation, opts?: ExpectOptions): Promise<void> {
    return this.poll(
      () => this.ctx.driver.title(),
      (title) => (typeof expected === "string" ? title === expected : expected.test(title)),
      `to be titled ${show(expected)}`,
      opts
    );
  }

  /**
   * Any predicate from the wire contract — `network`, `route`, `console-clean`,
   * `stream`, `storage`, `signal`, `state`, `visible`, `text`, `allOf`/`anyOf` —
   * evaluated by the same code the cloud's flow replay runs. A saved flow's
   * `success` block pastes straight in.
   */
  toSatisfy(predicates: PredicateInput | PredicateInput[], opts?: ExpectOptions): Promise<void> {
    this.noNegation("toSatisfy");
    const list = (Array.isArray(predicates) ? predicates : [predicates]).map(withDefaults);
    return traced(this.ctx, async () => {
      const results = await this.ctx.driver.assert(list, {
        timeoutMs: opts?.timeout ?? this.ctx.expectTimeout,
      });
      const failed = results.filter((r) => !r.pass);
      if (failed.length === 0) return;
      fail({
        verdict: "expectation_failed",
        whatChanged: failed.map((f) => f.evidence).join("; "),
        nextAction:
          "the action landed but its expected consequence did not occur — check the handler and the network call it should make",
        evidenceTier: weakestTier(results),
      });
    });
  }

  /** No first-party console error so far (beyond what the test allowed). */
  toHaveNoConsoleErrors(): Promise<void> {
    this.noNegation("toHaveNoConsoleErrors");
    return traced(this.ctx, async () => {
      await this.ctx.driver.settle();
      const errors = await unexpectedConsoleErrors(this.ctx);
      if (errors.length > 0) fail(consoleErrorDecision(errors.map((e) => e.text)));
    });
  }

  /** The page does not scroll sideways at this viewport. */
  toHaveNoHorizontalOverflow(): Promise<void> {
    this.noNegation("toHaveNoHorizontalOverflow");
    return traced(this.ctx, async () => {
      const reading = await this.ctx.driver.overflow();
      if (reading.overflow) fail(overflowDecision(reading));
    });
  }
}

/** A wire predicate as a person writes it: fields that have defaults may be left out. */
export type PredicateInput = Predicate extends infer P
  ? P extends { kind: string }
    ? Omit<P, "since" | "cumulative" | "minCount" | "includeThirdParty" | "area"> &
        Partial<Pick<P, Extract<keyof P, "since" | "cumulative" | "minCount" | "includeThirdParty" | "area">>>
    : never
  : never;

/** Fill the same defaults the zod schema would, without parsing (and without zod). */
function withDefaults(p: PredicateInput): Predicate {
  const raw = p as Record<string, unknown> & { kind: string };
  switch (raw.kind) {
    case "allOf":
    case "anyOf":
      return { ...raw, predicates: (raw.predicates as PredicateInput[]).map(withDefaults) } as Predicate;
    case "network":
    case "stream":
    case "signal":
      return { minCount: 1, since: 0, cumulative: false, ...raw } as Predicate;
    case "console-clean":
      return { since: 0, cumulative: false, includeThirdParty: false, ...raw } as Predicate;
    case "storage":
      return { area: "local", ...raw } as Predicate;
    default:
      return raw as Predicate;
  }
}

export function consoleErrorDecision(texts: string[]) {
  const shown = texts.slice(0, 3).map((t) => t.slice(0, 160));
  return {
    verdict: "console_error" as const,
    whatChanged: `the page logged ${texts.length} console error(s): ${shown.join(" | ")}${texts.length > shown.length ? ` | +${texts.length - shown.length} more` : ""}`,
    suggestedFix:
      "fix the error — or, if this test provokes it on purpose, declare it with audit.allowConsoleErrors(pattern)",
    nextAction: "reproduce and fix — silent errors mask real breakage",
    evidenceTier: "consequence" as const,
  };
}

export function overflowDecision(reading: { scrollWidth: number; viewportWidth: number; offenders: string[] }) {
  return {
    verdict: "horizontal_overflow" as const,
    whatChanged: `page content is ${reading.scrollWidth}px wide in a ${reading.viewportWidth}px viewport${
      reading.offenders.length ? ` — widest: ${reading.offenders.join(" · ")}` : ""
    }`,
    nextAction: `find the element exceeding ${reading.viewportWidth}px (fixed-width container, unwrapped table, or long unbroken string)`,
    evidenceTier: "dom" as const,
  };
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export interface RequestExpectation extends RequestMatch {
  /** Exactly this many matching requests. Default: at least one. */
  times?: number;
  /** Only count events after this watermark (`await network.mark()`). */
  since?: number;
}

export class NetworkAssertions {
  private readonly ctx: TestContext;
  private readonly negate: boolean;

  constructor(ctx: TestContext, negate = false) {
    this.ctx = ctx;
    this.negate = negate;
  }

  get not(): NetworkAssertions {
    return new NetworkAssertions(this.ctx, !this.negate);
  }

  /**
   * The page made this request and it succeeded — or returned exactly
   * `status`, when given. Consequence-tier evidence: it is the wire `network`
   * predicate, so a failing POST fails this even if the UI looks done.
   *
   * Negated, it means no such request was made at all (success or not), and
   * it waits for the network to go quiet before saying so.
   */
  toHaveRequest(match: RequestExpectation, opts?: ExpectOptions): Promise<void> {
    const { ctx } = this;
    const timeoutMs = opts?.timeout ?? ctx.expectTimeout;
    const label = `${match.method ? match.method.toUpperCase() + " " : ""}${match.url}`;

    if (this.negate) {
      return traced(ctx, async () => {
        await ctx.driver.settle(Math.min(2_000, timeoutMs));
        const { network } = await ctx.driver.events();
        const seen = network.filter((e) => e.seq > (match.since ?? 0) && matchesRequest(e, match));
        if (seen.length === 0) return;
        fail({
          verdict: "expectation_failed",
          whatChanged: `expected no request to ${label} — saw ${seen.length}: ${seen
            .slice(-3)
            .map((e) => `${e.method} ${e.url.split("?")[0]!.slice(-48)} → ${e.status ?? "failed"}`)
            .join("; ")}`,
          nextAction: "the page made a request this test says it must not make — check the handler's guard",
          evidenceTier: "consequence",
        });
      });
    }

    const predicate: Predicate = {
      kind: "network",
      urlIncludes: match.url,
      method: match.method,
      status: match.status,
      minCount: match.times ?? 1,
      maxCount: match.times,
      since: match.since ?? 0,
      cumulative: false,
    };
    return traced(ctx, async () => {
      const [result] = await ctx.driver.assert([predicate], { timeoutMs });
      if (result?.pass) return;
      fail({
        verdict: "expectation_failed",
        whatChanged: result?.evidence ?? `no request to ${label}`,
        nextAction:
          "the action landed but its expected consequence did not occur — this is the silent-failure class; check the handler and the network call it should make",
        evidenceTier: "consequence",
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Plain values
// ---------------------------------------------------------------------------

export class ValueAssertions<T> {
  private readonly actual: T;
  private readonly negate: boolean;

  constructor(actual: T, negate = false) {
    this.actual = actual;
    this.negate = negate;
  }

  get not(): ValueAssertions<T> {
    return new ValueAssertions(this.actual, !this.negate);
  }

  private verify(pass: boolean, wanted: string): void {
    if (pass !== this.negate) return;
    fail({
      verdict: "assertion_failed",
      whatChanged: `expected ${show(this.actual)} ${this.negate ? "not " : ""}${wanted}`,
    });
  }

  toBe(expected: unknown): void {
    this.verify(Object.is(this.actual, expected), `to be ${show(expected)}`);
  }
  toEqual(expected: unknown): void {
    this.verify(isDeepStrictEqual(this.actual, expected), `to equal ${show(expected)}`);
  }
  toBeTruthy(): void {
    this.verify(Boolean(this.actual), "to be truthy");
  }
  toBeFalsy(): void {
    this.verify(!this.actual, "to be falsy");
  }
  toBeDefined(): void {
    this.verify(this.actual !== undefined, "to be defined");
  }
  toBeUndefined(): void {
    this.verify(this.actual === undefined, "to be undefined");
  }
  toBeNull(): void {
    this.verify(this.actual === null, "to be null");
  }
  toBeGreaterThan(n: number): void {
    this.verify(typeof this.actual === "number" && this.actual > n, `to be greater than ${n}`);
  }
  toBeGreaterThanOrEqual(n: number): void {
    this.verify(typeof this.actual === "number" && this.actual >= n, `to be at least ${n}`);
  }
  toBeLessThan(n: number): void {
    this.verify(typeof this.actual === "number" && this.actual < n, `to be less than ${n}`);
  }
  toBeLessThanOrEqual(n: number): void {
    this.verify(typeof this.actual === "number" && this.actual <= n, `to be at most ${n}`);
  }
  toContain(item: unknown): void {
    const a = this.actual as unknown;
    const pass =
      typeof a === "string"
        ? typeof item === "string" && a.includes(item)
        : Array.isArray(a) && a.some((x) => isDeepStrictEqual(x, item));
    this.verify(pass, `to contain ${show(item)}`);
  }
  toMatch(pattern: RegExp | string): void {
    const a = String(this.actual);
    this.verify(typeof pattern === "string" ? a.includes(pattern) : pattern.test(a), `to match ${show(pattern)}`);
  }
  toHaveLength(n: number): void {
    const len = (this.actual as { length?: unknown } | null | undefined)?.length;
    this.verify(len === n, `to have length ${n} (it has ${show(len)})`);
  }
}

export function expect(actual: Locator): LocatorAssertions;
export function expect(actual: Page): PageAssertions;
export function expect(actual: Network): NetworkAssertions;
export function expect<T>(actual: T): ValueAssertions<T>;
export function expect(actual: unknown): unknown {
  if (actual instanceof Locator) return new LocatorAssertions(actual);
  if (actual instanceof Page) return new PageAssertions(actual.ctx);
  if (actual instanceof Network) return new NetworkAssertions(actual.ctx);
  return new ValueAssertions(actual);
}
