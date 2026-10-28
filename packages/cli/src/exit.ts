/**
 * Exit codes — the only one that means "the app regressed" is 1, so CI can
 * tell a broken app from a run that never got to test it:
 *   0  pass (flaky results warn but pass, unless --strict)
 *   1  a confirmed regression
 *   2  usage / configuration error
 *   4  Argus could not test (target unreachable, no browser slot, fleet error)
 */
export const EXIT = { pass: 0, regression: 1, usage: 2, untested: 4 } as const;

/** Combine per-check statuses (pass | fail | error | untested | flaky | skipped) into one exit code. */
export function exitCodeFor(statuses: string[], strict = false): number {
  if (statuses.includes("fail")) return EXIT.regression;
  if (statuses.includes("error") || statuses.includes("untested")) return EXIT.untested;
  if (statuses.includes("flaky")) return strict ? EXIT.regression : EXIT.pass;
  return EXIT.pass;
}

/** An API refusal status → exit code: capacity (429) and server errors are "could not test". */
export function exitCodeForApiStatus(status: number): number {
  return status === 429 || status >= 500 ? EXIT.untested : EXIT.regression;
}
