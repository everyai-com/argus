/**
 * `argus patrol` — re-verify on every new commit, fix what breaks.
 *
 * Polls the tracked branch; when its head moves, replays the suite against
 * the target (the environment that branch deploys to) and, with --fix, hands
 * confirmed failures to `argus fix`. A quiet branch costs one `git fetch` per
 * tick. The tested sha only advances after a run completes, so a crashed or
 * untested run is retried on the next tick instead of being skipped.
 */
import { fixableFailures, type FixOutcome, type Suite } from "./fix";

export interface PatrolState {
  lastSha?: string;
  lastRunAt?: string;
  lastStatus?: string;
  failing?: string[];
}

export interface PatrolDeps {
  headSha(): Promise<string | undefined>;
  verify(): Promise<Suite>;
  fix?(suite: Suite): Promise<FixOutcome[]>;
  readState(): PatrolState;
  writeState(s: PatrolState): void;
  log(msg: string): void;
}

export interface TickResult {
  ran: boolean;
  sha?: string;
  status?: string;
  failing?: string[];
  outcomes?: FixOutcome[];
}

export async function patrolTick(deps: PatrolDeps, now: () => Date = () => new Date()): Promise<TickResult> {
  const sha = await deps.headSha();
  if (!sha) {
    deps.log("could not read the branch head — is the remote reachable?");
    return { ran: false };
  }
  const state = deps.readState();
  if (state.lastSha === sha) {
    deps.log(`no new commits (${sha.slice(0, 7)})`);
    return { ran: false, sha };
  }
  deps.log(`new head ${sha.slice(0, 7)} — verifying`);
  const suite = await deps.verify();
  const failing = fixableFailures(suite).map((r) => r.flow);
  // "untested" (fleet busy, missing auth) is not a verdict on this commit: retry next tick.
  if (suite.status === "untested") {
    deps.log("could not test this commit — will retry");
    return { ran: true, sha, status: suite.status, failing };
  }
  const outcomes = failing.length && deps.fix ? await deps.fix(suite) : undefined;
  deps.writeState({ lastSha: sha, lastRunAt: now().toISOString(), lastStatus: suite.status, failing });
  return { ran: true, sha, status: suite.status, failing, outcomes };
}
