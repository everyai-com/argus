/**
 * What a test holds: `page`, `network` and `audit`.
 *
 * These are thin, serializable handles. A `Locator` is nothing but a semantic
 * `Anchor` from the wire contract plus the driver it will be resolved by; an
 * action is a wire `Action`. Nothing here imports Playwright, so the same test
 * runs unchanged on any `Driver` (see ./driver.ts).
 */
import type { Action, Anchor, ConsoleEvent, NetworkEvent, ViewportName } from "@argus/shared";
import { describeAnchor, firstPartyConsoleErrors, type OverflowReading } from "@argus/core";
import type { Driver } from "./driver.ts";
import { ArgusTestError } from "./errors.ts";

export interface AuditGates {
  /** Fail a test whose page logged a first-party console error. Default true. */
  consoleErrors: boolean;
  /** Fail a test whose page ends up scrolling sideways. Default true. */
  horizontalOverflow: boolean;
  /** Count console errors from other hosts' scripts too. Default false. */
  includeThirdParty: boolean;
}

export interface TestOptions {
  /** Time budget for this test, ms. */
  timeout?: number;
  /** A named Argus viewport or an exact size. */
  viewport?: ViewportName | { width: number; height: number };
  /** Override the audit gates for this test. */
  audit?: Partial<AuditGates>;
}

/** Per-test state shared by the fixtures. */
export interface TestContext {
  driver: Driver;
  actionTimeout: number;
  expectTimeout: number;
  gates: AuditGates;
  /** Console errors the test declared as expected. */
  allowedConsole: Array<string | RegExp>;
  /** Every runner call the test made (missing-await guard). */
  calls: Array<TrackedCall<any>>;
}

/**
 * A runner call's promise, which knows whether anyone ever waited on it.
 * `await`, `.then`, `.catch` and `Promise.all` all go through `then` for a
 * Promise subclass, so `observed` is exact — not a timing guess.
 */
export class TrackedCall<T> extends Promise<T> {
  observed = false;
  /** Stack of the test line that made the call. */
  site?: string;

  // Derived promises (`call.then(...)`) are ordinary ones.
  static get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  override then<A = T, B = never>(
    onfulfilled?: ((value: T) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null
  ): Promise<A | B> {
    this.observed = true;
    return super.then(onfulfilled, onrejected);
  }
}

/**
 * Run one runner call on behalf of a test. Captures the call site
 * synchronously — before any await — so a failure points at the test's own
 * line, and tracks the promise so a missing `await` cannot pass silently:
 * an un-awaited `expect` would otherwise never be able to fail its test.
 */
export function traced<T>(ctx: TestContext, op: () => Promise<T>): Promise<T> {
  const site = new Error("call site").stack;
  const inner = (async () => {
    try {
      return await op();
    } catch (err) {
      if (err instanceof ArgusTestError && !err.site) err.site = site;
      throw err;
    }
  })();
  const call = new TrackedCall<T>((resolve, reject) => {
    inner.then(resolve, reject);
  });
  call.site = site;
  // A call nobody awaited must fail its test (see run.ts), not crash the run
  // as an unhandled rejection. Attached below `then`, so it does not count.
  Promise.prototype.then.call(call, undefined, () => {});
  ctx.calls.push(call);
  return call;
}

export interface ActionOptions {
  timeout?: number;
}

/**
 * A semantic anchor, addressed the Argus way: testid → role+name → label →
 * placeholder → text → css. Acting on it, or reading one element through it,
 * requires that it match exactly one element — several is a refusal that names
 * the candidates, never a guess. That is why there is no `.first()` or
 * `.nth()`: tighten the anchor instead.
 */
export class Locator {
  readonly anchor: Anchor;
  /** @internal */
  readonly ctx: TestContext;

  constructor(ctx: TestContext, anchor: Anchor) {
    this.ctx = ctx;
    this.anchor = anchor;
  }

  private act(action: Action, opts?: ActionOptions): Promise<void> {
    return traced(this.ctx, async () => {
      await this.ctx.driver.act(action, { timeoutMs: opts?.timeout ?? this.ctx.actionTimeout });
    });
  }

  click(opts?: ActionOptions): Promise<void> {
    return this.act({ action: "click", anchor: this.anchor }, opts);
  }
  fill(value: string, opts?: ActionOptions): Promise<void> {
    return this.act({ action: "fill", anchor: this.anchor, value }, opts);
  }
  clear(opts?: ActionOptions): Promise<void> {
    return this.fill("", opts);
  }
  press(key: string, opts?: ActionOptions): Promise<void> {
    return this.act({ action: "press", anchor: this.anchor, key }, opts);
  }
  hover(opts?: ActionOptions): Promise<void> {
    return this.act({ action: "hover", anchor: this.anchor }, opts);
  }
  selectOption(value: string, opts?: ActionOptions): Promise<void> {
    return this.act({ action: "select", anchor: this.anchor, value }, opts);
  }

  private read<T extends string | number | boolean>(what: "text" | "value" | "count" | "visible"): Promise<T> {
    return traced(this.ctx, async () => {
      return (await this.ctx.driver.read(this.anchor, what, { timeoutMs: this.ctx.actionTimeout })) as T;
    });
  }

  /** Rendered text of the one element (whitespace collapsed). */
  text(): Promise<string> {
    return this.read<string>("text");
  }
  /** Value of the one form control. Refused for password and other secure fields. */
  value(): Promise<string> {
    return this.read<string>("value");
  }
  /** How many elements the anchor matches right now. */
  count(): Promise<number> {
    return this.read<number>("count");
  }
  isVisible(): Promise<boolean> {
    return this.read<boolean>("visible");
  }

  toString(): string {
    return describeAnchor(this.anchor);
  }
}

export class Page {
  /** @internal */
  readonly ctx: TestContext;

  constructor(ctx: TestContext) {
    this.ctx = ctx;
  }

  private act(action: Action, timeout?: number): Promise<void> {
    return traced(this.ctx, async () => {
      await this.ctx.driver.act(action, { timeoutMs: timeout ?? this.ctx.actionTimeout });
    });
  }

  /**
   * Navigate. A path ("/settings?tab=1") resolves against the app's URL — by
   * the driver, which is the one that knows where the app is.
   */
  goto(pathOrUrl: string, opts?: { timeout?: number }): Promise<void> {
    return this.act({ action: "goto", url: pathOrUrl }, opts?.timeout ?? 30_000);
  }
  reload(): Promise<void> {
    return this.act({ action: "reload" }, 30_000);
  }
  back(): Promise<void> {
    return this.act({ action: "back" }, 30_000);
  }
  /** Press a key on whatever has focus. */
  press(key: string): Promise<void> {
    return this.act({ action: "press", key });
  }
  scroll(direction: "up" | "down" = "down", amount = 600): Promise<void> {
    return this.act({ action: "scroll", direction, amount });
  }
  /** A fixed pause. Assertions already wait; reach for this last. */
  wait(ms: number): Promise<void> {
    return this.act({ action: "wait", ms });
  }

  url(): Promise<string> {
    return traced(this.ctx, () => this.ctx.driver.url());
  }
  title(): Promise<string> {
    return traced(this.ctx, () => this.ctx.driver.title());
  }
  screenshot(): Promise<Uint8Array> {
    return traced(this.ctx, () => this.ctx.driver.screenshot());
  }

  /** Any anchor from the wire contract, as written in a saved flow. */
  anchor(anchor: Anchor): Locator {
    return new Locator(this.ctx, anchor);
  }
  getByTestId(testid: string): Locator {
    return this.anchor({ testid });
  }
  /** `getByRole("button", "Add")` or, Playwright-style, `getByRole("button", { name: "Add" })`. */
  getByRole(role: string, name?: string | { name?: string }): Locator {
    const n = typeof name === "string" ? name : name?.name;
    return this.anchor(n === undefined ? { role } : { role, name: n });
  }
  getByLabel(label: string): Locator {
    return this.anchor({ label });
  }
  getByPlaceholder(placeholder: string): Locator {
    return this.anchor({ placeholder });
  }
  getByText(text: string): Locator {
    return this.anchor({ text });
  }
  /** Last resort: a structural CSS selector. Prefer anything above. */
  locator(css: string): Locator {
    return this.anchor({ css });
  }
}

export interface RequestMatch {
  /** Substring of the request URL (the wire predicate's `urlIncludes`). */
  url: string;
  method?: string;
  status?: number;
}

/**
 * The network as the page produced it — observed, never intercepted. Assert on
 * it with `expect(network).toHaveRequest(...)`. Interception belongs to this
 * fixture too; it is not built yet.
 */
export class Network {
  /** @internal */
  readonly ctx: TestContext;

  constructor(ctx: TestContext) {
    this.ctx = ctx;
  }

  /** Every request seen so far that matches, oldest first. */
  requests(match?: Partial<RequestMatch>): Promise<NetworkEvent[]> {
    return traced(this.ctx, async () => {
      const { network } = await this.ctx.driver.events();
      return network.filter((e) => matchesRequest(e, match));
    });
  }

  /**
   * A watermark for "from here on": pass it as `since` to
   * `toHaveRequest`/`toSatisfy` to ignore everything before this point.
   */
  mark(): Promise<number> {
    return traced(this.ctx, async () => (await this.ctx.driver.events()).seq);
  }
}

export function matchesRequest(e: NetworkEvent, match?: Partial<RequestMatch>): boolean {
  if (!match) return true;
  if (match.url !== undefined && !e.url.includes(match.url)) return false;
  if (match.method !== undefined && e.method !== match.method.toUpperCase()) return false;
  if (match.status !== undefined && e.status !== match.status) return false;
  return true;
}

/**
 * Argus's audit signals, inside a test. By default every test fails if its
 * page logged a console error or ends up scrolling sideways — the two classes
 * a locator-only test passes straight over. A test that provokes an error on
 * purpose says so with `allowConsoleErrors`.
 */
export class Audit {
  /** @internal */
  readonly ctx: TestContext;

  constructor(ctx: TestContext) {
    this.ctx = ctx;
  }

  /** Declare console errors this test expects; anything else still fails it. */
  allowConsoleErrors(...patterns: Array<string | RegExp>): void {
    this.ctx.allowedConsole.push(...patterns);
  }

  /** First-party console errors so far, minus the ones the test allowed. */
  consoleErrors(): Promise<ConsoleEvent[]> {
    return traced(this.ctx, () => unexpectedConsoleErrors(this.ctx));
  }

  /** Whether the page scrolls sideways right now, and what is too wide. */
  horizontalOverflow(): Promise<OverflowReading> {
    return traced(this.ctx, () => this.ctx.driver.overflow());
  }
}

export async function unexpectedConsoleErrors(ctx: TestContext): Promise<ConsoleEvent[]> {
  const events = await ctx.driver.events();
  const { errors } = firstPartyConsoleErrors(events.console, await ctx.driver.url(), {
    includeThirdParty: ctx.gates.includeThirdParty,
  });
  return errors.filter(
    (e) => !ctx.allowedConsole.some((p) => (typeof p === "string" ? e.text.includes(p) : p.test(e.text)))
  );
}

export interface Fixtures {
  /** The page under test: navigation and anchors. */
  page: Page;
  /** Observed network traffic. */
  network: Network;
  /** Console errors and layout overflow — Argus's audit signals. */
  audit: Audit;
}

export function createFixtures(ctx: TestContext): Fixtures {
  return { page: new Page(ctx), network: new Network(ctx), audit: new Audit(ctx) };
}
