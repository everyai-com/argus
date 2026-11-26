/**
 * Failures as decision envelopes — the same shape a flow replay reports
 * (verdict · whatChanged · suggestedFix · nextAction), so an agent reading a
 * local test failure switches on the same IDs it already knows from the cloud.
 */
import type { EvidenceTier, FlowVerdict } from "@argus/shared";

/**
 * Flow verdicts keep their meaning here; the rest only a code-first run can
 * produce. Agents switch on these — never on prose.
 */
export type TestVerdict =
  | FlowVerdict
  /** A plain-value `expect(x).toBe(y)` did not hold. */
  | "assertion_failed"
  /** The test asked for the value of a password (or other secure) field. */
  | "secure_field"
  /** Audit gate: the page logged an error during the test. */
  | "console_error"
  /** Audit gate: the page scrolls sideways. */
  | "horizontal_overflow"
  /** The test did not finish inside its time budget. */
  | "timeout"
  /** An action or assertion was still running when the test returned. */
  | "unawaited";

export interface Decision {
  verdict: TestVerdict;
  whatChanged: string;
  suggestedFix?: string;
  nextAction?: string;
  /** The weakest evidence tier the verdict rests on, when predicates decided it. */
  evidenceTier?: EvidenceTier;
}

export class ArgusTestError extends Error {
  readonly decision: Decision;
  /** Stack captured where the test called into the runner (see `traced`). */
  site?: string;

  constructor(decision: Decision) {
    super(decision.whatChanged);
    this.name = "ArgusTestError";
    this.decision = decision;
  }
}

/** Run-level problems: bad config, the port is taken, no browser. Exit code 2. */
export class RunnerError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
    this.hint = hint;
  }
}

export function fail(decision: Decision): never {
  throw new ArgusTestError(decision);
}
