/**
 * `argus fix` — confirmed failure → fix in its own worktree → proof → draft PR.
 *
 * The bar is Argus's, not the agent's: a fix ships only when the flow that
 * caught the bug PASSES against a build of the fixed branch and the rest of
 * the suite still does. An agent that "fixes" a failure by editing the flow
 * that caught it is refused — weakening the test is not a fix. No preview
 * command means no proof, so the branch is kept and no PR is opened
 * (verify-or-refuse, same as everywhere else).
 */

export interface SuiteResult {
  flow: string;
  status: string;
  failedStep?: number;
  evidenceTier?: string;
  reproFlow?: string;
  screenshotKey?: string;
  confirmation?: { state?: string };
  decision?: { verdict?: string; whatChanged?: string; nextAction?: string; suggestedFix?: string };
}

export interface Suite {
  status: string;
  results: SuiteResult[];
}

export interface FixDeps {
  /** Replay flows (all, or the named subset) against baseUrl. */
  verify(baseUrl: string, names?: string[]): Promise<Suite>;
  /** Run a shell command; resolves with exit code and output. Never throws. */
  sh(cmd: string, opts: { cwd: string; input?: string; timeoutMs?: number }): Promise<{ code: number; out: string }>;
  log(msg: string): void;
  /**
   * Has a human already turned this fix down (an `argus fix` PR for the flow
   * closed without merging)? Then the loop leaves it alone — automation never
   * overrides a human decision.
   */
  declined?(flow: string): Promise<boolean>;
}

export interface FixOptions {
  repo: string; // repo root
  target: string; // where the failures were found
  agent: string; // shell command that reads the prompt on stdin, e.g. `claude -p`
  preview?: string; // shell command run in the worktree that prints the fixed build's URL
  openPr: boolean;
  max: number;
  /** A suite result already in hand (patrol just ran it) — skips the first verify. */
  suite?: Suite;
}

export type FixOutcome =
  | { flow: string; result: "pr"; branch: string; url: string }
  | { flow: string; result: "verified"; branch: string } // proven, PR not requested
  | { flow: string; result: "unverified"; branch: string; why: string }
  | { flow: string; result: "rejected"; branch: string; why: string }
  | { flow: string; result: "declined"; branch: string; why: string }
  | { flow: string; result: "no-change" | "still-failing" | "agent-failed"; branch: string; why: string };

/** Verdicts that mean "Argus could not test", never "the app is broken". */
const UNTESTED = new Set(["fleet_busy", "auth_profile_missing"]);

/** Failures worth a fix: repeated (confirmed) product failures only — never flaky, never untested. */
export function fixableFailures(suite: Suite): SuiteResult[] {
  return suite.results.filter(
    (r) => r.status !== "ok" && r.confirmation?.state === "confirmed" && !UNTESTED.has(r.decision?.verdict ?? "")
  );
}

export function branchName(flow: string, stamp: string): string {
  return `argus/fix/${flow.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60)}-${stamp}`;
}

/** Did the change touch the suite itself? Then it weakened the test, not fixed the app. */
export function touchesFlows(changedFiles: string[]): string[] {
  return changedFiles.filter((f) => /(^|\/)\.argus\/(flows|baselines)\//.test(f));
}

/** The last http(s) URL a preview command printed (wrangler/vercel/netlify all end with it). */
export function lastUrl(output: string): string | undefined {
  const all = output.match(/https?:\/\/[^\s"'<>)\]]+/g);
  return all?.at(-1)?.replace(/[.,;]+$/, "");
}

export function fixPrompt(r: SuiteResult, target: string): string {
  const d = r.decision ?? {};
  return [
    `Argus replayed the flow "${r.flow}" against ${target} twice and it failed the same way both times (a confirmed regression, not flake).`,
    "",
    `verdict: ${d.verdict ?? "unknown"}`,
    `what changed: ${d.whatChanged ?? "n/a"}`,
    ...(r.failedStep !== undefined ? [`failed at step: ${r.failedStep}`] : []),
    ...(d.suggestedFix ? [`suggested fix: ${d.suggestedFix}`] : []),
    `evidence tier: ${r.evidenceTier ?? "unknown"}`,
    `flow file: .argus/flows/${r.flow}.json`,
    "",
    "Fix the APPLICATION so this flow passes. Rules:",
    "- Do not edit anything under .argus/ — the flow is the spec; changing it is not a fix.",
    "- Make the smallest change that fixes the cause, in the app's own style.",
    "- Run the project's typecheck and tests if it has them, and leave them passing.",
    "- Do not commit, push or open PRs; just leave the change in the working tree.",
  ].join("\n");
}

export function prBody(r: SuiteResult, before: SuiteResult, after: Suite, previewUrl: string): string {
  const others = after.results.filter((x) => x.flow !== r.flow);
  return [
    `Fixes the confirmed Argus failure in \`${r.flow}\`.`,
    "",
    "| | verdict | evidence |",
    "|---|---|---|",
    `| before | \`${before.decision?.verdict ?? before.status}\` (confirmed twice) | ${before.decision?.whatChanged ?? ""} |`,
    `| after (${previewUrl}) | \`ok\` | flow passes |`,
    "",
    `The rest of the suite on the fixed build: ${others.filter((x) => x.status === "ok").length}/${others.length} pass.`,
    "",
    "Opened by `argus fix`: the fix was written by an agent in its own worktree, then proven by replaying the flow against a preview of this branch. Review it like any other change.",
  ].join("\n");
}

export async function runFixLoop(deps: FixDeps, opts: FixOptions): Promise<FixOutcome[]> {
  const { sh, log } = deps;
  const suite = opts.suite ?? (await deps.verify(opts.target));
  const failures = fixableFailures(suite).slice(0, opts.max);
  if (failures.length === 0) {
    log("no confirmed failures to fix");
    return [];
  }
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 12);
  const outcomes: FixOutcome[] = [];

  for (const r of failures) {
    const branch = branchName(r.flow, stamp);
    if (await deps.declined?.(r.flow)) {
      outcomes.push({ flow: r.flow, result: "declined", branch, why: "a person closed an earlier argus fix PR for this flow" });
      continue;
    }
    const dir = `${opts.repo}/.argus/worktrees/${branch.replace(/\//g, "_")}`;
    log(`\n${r.flow}: ${r.decision?.verdict} — fixing on ${branch}`);
    const add = await sh(`git worktree add -b ${branch} "${dir}" HEAD`, { cwd: opts.repo });
    if (add.code !== 0) {
      outcomes.push({ flow: r.flow, result: "agent-failed", branch, why: `worktree: ${add.out.slice(-300)}` });
      continue;
    }

    const agent = await sh(opts.agent, { cwd: dir, input: fixPrompt(r, opts.target), timeoutMs: 20 * 60_000 });
    if (agent.code !== 0) {
      outcomes.push({ flow: r.flow, result: "agent-failed", branch, why: agent.out.slice(-300) });
      continue;
    }
    const changed = (await sh("git status --porcelain", { cwd: dir })).out
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
    if (changed.length === 0) {
      outcomes.push({ flow: r.flow, result: "no-change", branch, why: "the agent changed nothing" });
      continue;
    }
    const cheated = touchesFlows(changed);
    if (cheated.length) {
      outcomes.push({ flow: r.flow, result: "rejected", branch, why: `edited the suite instead of the app: ${cheated.join(", ")}` });
      continue;
    }
    await sh(`git add -A && git commit -m "fix: ${r.flow} (argus fix)"`, { cwd: dir });

    if (!opts.preview) {
      outcomes.push({ flow: r.flow, result: "unverified", branch, why: "no --preview command, so the fix was never run — no PR" });
      continue;
    }
    const preview = await sh(opts.preview, { cwd: dir, timeoutMs: 10 * 60_000 });
    const url = preview.code === 0 ? lastUrl(preview.out) : undefined;
    if (!url) {
      outcomes.push({ flow: r.flow, result: "unverified", branch, why: `preview printed no URL (exit ${preview.code})` });
      continue;
    }
    const after = await deps.verify(url);
    const mine = after.results.find((x) => x.flow === r.flow);
    const broken = fixableFailures(after).filter((x) => x.flow !== r.flow);
    if (mine?.status !== "ok") {
      outcomes.push({ flow: r.flow, result: "still-failing", branch, why: mine?.decision?.whatChanged ?? "flow did not pass on the preview" });
      continue;
    }
    if (broken.length) {
      outcomes.push({ flow: r.flow, result: "rejected", branch, why: `fix breaks ${broken.map((b) => b.flow).join(", ")}` });
      continue;
    }
    if (!opts.openPr) {
      outcomes.push({ flow: r.flow, result: "verified", branch });
      continue;
    }
    const push = await sh(`git push -u origin ${branch}`, { cwd: dir });
    const pr = await sh(`gh pr create --draft --head ${branch} --title "fix: ${r.flow} (argus)" --body-file -`, {
      cwd: dir,
      input: prBody(r, r, after, url),
    });
    const prUrl = lastUrl(pr.out);
    if (push.code !== 0 || pr.code !== 0 || !prUrl) {
      outcomes.push({ flow: r.flow, result: "verified", branch });
      log(`  proven, but the PR could not be opened: ${(push.code ? push.out : pr.out).slice(-200)}`);
      continue;
    }
    outcomes.push({ flow: r.flow, result: "pr", branch, url: prUrl });
  }
  return outcomes;
}
