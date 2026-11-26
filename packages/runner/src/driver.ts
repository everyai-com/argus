/**
 * Driver — the one seam between a test and a browser.
 *
 * Everything a test file can do reaches the browser through this interface,
 * and every argument is plain data from the wire contract: an `Action` with a
 * semantic `Anchor`, a `Predicate`, an element check. No Playwright object
 * crosses it. That is what lets the same test file run somewhere else later:
 * the local driver (./local-driver.ts) executes against Chromium on this
 * machine; a fleet driver can implement the same calls over the cloud's
 * session API (`/v1/sessions/:id/act|query|assert|observe`), which already
 * speaks these shapes.
 *
 * Waiting happens on the driver's side of the seam (each call takes a time
 * budget), so a remote driver waits next to the browser rather than polling
 * over HTTP.
 */
import type {
  Action,
  Anchor,
  AnchorResolution,
  ConsoleEvent,
  NetworkEvent,
  Predicate,
  PredicateResult,
  StreamEvent,
} from "@argus/shared";
import type { OverflowReading } from "@argus/core";

export type TextExpectation = string | RegExp;

/** What an assertion asks of the element(s) an anchor resolves to. */
export type ElementCheck =
  | { kind: "visible" }
  | { kind: "hidden" }
  | { kind: "enabled" }
  | { kind: "disabled" }
  | { kind: "checked"; checked: boolean }
  | { kind: "text"; expected: TextExpectation; mode: "exact" | "contains"; ignoreCase?: boolean }
  | { kind: "value"; expected: TextExpectation }
  | { kind: "attribute"; name: string; expected: TextExpectation }
  /** Plural by nature — these two are the only checks many elements may answer. */
  | { kind: "count"; expected: number }
  | { kind: "texts"; expected: TextExpectation[] };

export interface CheckOutcome {
  /** Whether the check held (before any negation). */
  pass: boolean;
  /** What was actually observed, phrased for the failure message. */
  actual: string;
  /** The check had to read an element and the anchor never resolved to one. */
  missing?: boolean;
  resolution?: AnchorResolution;
}

export type ElementRead = "text" | "value" | "count" | "visible";

export interface ObservedEvents {
  network: NetworkEvent[];
  console: ConsoleEvent[];
  stream: StreamEvent[];
  /** Sequence number of the newest event. */
  seq: number;
  /** Sequence number when the most recent action or navigation started. */
  lastActionSeq: number;
}

export interface Driver {
  /** Perform one wire `Action`. Anchored actions resolve to exactly one element or refuse. */
  act(action: Action, opts: { timeoutMs: number }): Promise<{ resolution?: AnchorResolution }>;
  /** Wait until the check holds (or, negated, stops holding); report what was seen. */
  check(
    anchor: Anchor,
    check: ElementCheck,
    opts: { timeoutMs: number; negate: boolean }
  ): Promise<CheckOutcome>;
  /** Read one fact about an anchor's element. Never the value of a secure field. */
  read(anchor: Anchor, what: ElementRead, opts: { timeoutMs: number }): Promise<string | number | boolean>;
  /** Evaluate wire predicates, retrying while they fail, within the budget. */
  assert(predicates: Predicate[], opts: { timeoutMs: number }): Promise<PredicateResult[]>;
  /** Everything the page has emitted so far. */
  events(): Promise<ObservedEvents>;
  /** Wait for the network to go quiet (bounded) — used before asserting an absence. */
  settle(maxMs?: number): Promise<void>;
  overflow(): Promise<OverflowReading>;
  url(): Promise<string>;
  title(): Promise<string>;
  screenshot(): Promise<Uint8Array>;
  close(): Promise<void>;
}
