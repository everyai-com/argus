/**
 * `argus untangle` — an agent refactors the whole codebase; Argus holds it to
 * "same behavior".
 *
 * The method is Caldo's untangle-codebase skill (github.com/caldoai/skills,
 * MIT): list every hidden link, needless link, surplus and special case, then
 * redesign so pieces that change together live together. Its own bar for done
 * is "intended behavior is the same as when you started" — and an agent
 * grading its own refactor is the weakest evidence there is. So the contract
 * is the suite: every flow that passes on the target BEFORE must pass on a
 * preview of the refactored branch AFTER. A flow that failed before and passes
 * after is a bug the refactor fixed, which the skill allows. No preview means
 * no proof, so no PR (verify-or-refuse, as in `argus fix`).
 */
import { fixableFailures, lastUrl, touchesFlows, type FixDeps, type Suite, type SuiteResult } from "./fix";

export interface UntangleDeps extends Pick<FixDeps, "verify" | "sh" | "log"> {
  /** Tracked source files of the checkout at `dir`, for the special-case count. */
  readSources(dir: string): Promise<Array<{ path: string; text: string }>>;
}

export interface UntangleOptions {
  repo: string;
  target: string;
  agent: string;
  preview?: string;
  openPr: boolean;
  /** The skill's two optional passes — asked interactively there, flags here. */
  comments: boolean;
  tests: boolean;
  /** The skill's optional argument: an area or concern to focus on. */
  focus?: string;
  timeoutMin: number;
}

export interface SpecialCases {
  sleeps: number;
  swallowed: number;
  disabledTests: number;
  total: number;
}

export type UntangleOutcome = {
  result: "pr" | "verified" | "unverified" | "rejected" | "no-change" | "agent-failed" | "refused";
  branch?: string;
  url?: string;
  why?: string;
  specialCases?: { before: SpecialCases; after?: SpecialCases };
  contract?: { kept: number; total: number; fixed: string[] };
};

export const LOG_FILE = "UNTANGLE_LOG.md";

/**
 * The special cases a script can count — the skill's best measure of how close
 * a refactor is. Only the mechanical subset (sleeps/timers, swallowed errors,
 * disabled tests); `if`s for one value need judgement and stay with the agent.
 */
export function countSpecialCases(files: Array<{ path: string; text: string }>): SpecialCases {
  let sleeps = 0;
  let swallowed = 0;
  let disabledTests = 0;
  for (const { text } of files) {
    sleeps += (text.match(/\b(setTimeout|sleep|usleep|waitForTimeout)\s*\(/g) ?? []).length;
    // An empty catch — or one holding only a comment — swallows the error either way.
    swallowed += (text.match(/catch\s*(\([^)]*\))?\s*\{\s*(\/\*[\s\S]*?\*\/|\/\/[^\n]*)?\s*\}/g) ?? []).length;
    swallowed += (text.match(/\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|undefined|null|void 0)\s*\)/g) ?? []).length;
    disabledTests += (
      text.match(/\b(it|test|describe)\.(skip|todo)\s*\(|\b(xit|xtest|xdescribe)\s*\(|@pytest\.mark\.skip|@Disabled\b|\bt\.Skip\(/g) ?? []
    ).length;
  }
  return { sleeps, swallowed, disabledTests, total: sleeps + swallowed + disabledTests };
}

/** Behavior before vs after: the flows that passed must still pass. */
export function checkContract(before: Suite, after: Suite) {
  const passedBefore = before.results.filter((r) => r.status === "ok").map((r) => r.flow);
  const afterBy = new Map(after.results.map((r) => [r.flow, r]));
  const confirmed = new Set(fixableFailures(after).map((r) => r.flow));
  const kept: string[] = [];
  const broken: SuiteResult[] = [];
  const unproven: string[] = [];
  for (const flow of passedBefore) {
    const r = afterBy.get(flow);
    if (r?.status === "ok") kept.push(flow);
    else if (r && confirmed.has(flow)) broken.push(r);
    else unproven.push(flow); // flaky, untested, or missing — not proven either way
  }
  const fixed = fixableFailures(before)
    .map((r) => r.flow)
    .filter((flow) => afterBy.get(flow)?.status === "ok");
  return { total: passedBefore.length, kept, broken, unproven, fixed };
}

export function untanglePrompt(opts: Pick<UntangleOptions, "comments" | "tests" | "focus">, contract: string[]): string {
  return [
    "Do a thorough refactor of this codebase and complete it to the end. Treat it as a goal.",
    "Why: agents write better code, spend fewer tokens searching, break less without noticing and debug faster in a well-structured codebase.",
    ...(opts.focus ? ["", `Focus area: ${opts.focus}`] : []),
    "",
    "1. List every problem first — change nothing yet. Ask one question everywhere: should these pieces change together? There are three ways to get it wrong:",
    "   - Hidden links (must change together, code doesn't show it): copied logic or values; a module reading a global or file another module sets; one feature split across folders by layer; a call order or convention callers just have to know.",
    "   - Needless links (tied together, change for different reasons): callers depending on internals; stable code importing something more volatile; a general function with a parameter only one workflow understands; a shallow module whose interface changes with its internals.",
    "   - Surplus (no reason of its own to change): pass-through wrappers; extension points and config for things that never vary; dead code.",
    "   Also list every special case — code that exists for one situation instead of following from how the system works: an `if` for one value, a parameter for one caller, a swallowed exception, a retry or sleep, a disabled test. Each is a requirement the design never accounted for.",
    "2. Redesign from first principles, as if the system had known today's requirements from the start. Find the one fix behind several problems; don't fix special cases one by one. Pieces that change together end up together, pieces that don't aren't tied, everything depends on what changes less.",
    "3. Fix everything on the list. Remove the special cases the redesign makes unnecessary; keep the ones the system still needs.",
    ...(opts.comments
      ? [
          "   Comments: remove comments that restate the implementation (even phrased as a why). Keep comments about things outside the code. Workaround comments go when the redesign removes the workaround.",
        ]
      : ["   Leave comments as they are, except where code you remove takes its comment with it."]),
    ...(opts.tests
      ? [
          "   Tests (do this LAST — they are your safety net): remove tests that repeat the implementation or can't fail; rewrite tests tied to internals so they depend on behavior.",
        ]
      : ["   Don't remove or weaken tests; update them only where a moved or renamed interface requires it."]),
    "4. Re-check, and repeat until nothing worth fixing is left: as few special cases as possible, a typical change lands in one place, every import is reasonable and nothing imports anything more volatile than itself.",
    "",
    "Tips: script a skeleton (bodies stripped) so the whole codebase fits in context; script a dependency graph and rerun it; use git history to see what changes together.",
    "",
    `Keep a decision log in ${LOG_FILE} at the repository root: each fix as a bullet, with the problems it solves nested under it (file:line + one sentence each). It becomes the PR description; it is not committed.`,
    "",
    "Behavior must not change. Argus will replay these end-to-end flows against a preview of your branch, and every one must still pass:",
    ...contract.map((f) => `- ${f}`),
    "",
    "Rules:",
    "- Do not edit anything under .argus/ — the flows are the behavior contract.",
    "- Run the project's typecheck and tests if it has them, and leave them passing.",
    "- Do not commit, push or open PRs; leave the change in the working tree.",
  ].join("\n");
}

function describeCases(c: SpecialCases): string {
  return `${c.total} (sleeps/timers ${c.sleeps}, swallowed errors ${c.swallowed}, disabled tests ${c.disabledTests})`;
}

export function untanglePrBody(o: { contract: ReturnType<typeof checkContract>; before: SpecialCases; after: SpecialCases; previewUrl: string; log: string }): string {
  const { contract } = o;
  return [
    "Untangles the codebase: pieces that change together now live together.",
    "",
    "| | |",
    "|---|---|",
    `| behavior (${o.previewUrl}) | ${contract.kept.length}/${contract.total} flows that passed before still pass |`,
    ...(contract.fixed.length ? [`| bugs fixed along the way | ${contract.fixed.map((f) => `\`${f}\``).join(", ")} now pass |`] : []),
    `| special cases (mechanical count) | ${describeCases(o.before)} → ${describeCases(o.after)} |`,
    "",
    "## Decision log",
    "",
    o.log.trim() ? o.log.trim().slice(0, 50_000) : "_The agent left no decision log._",
    "",
    "Opened by `argus untangle`: an agent refactored the code in its own worktree (method: caldoai/skills untangle-codebase), then Argus replayed the suite against a preview of this branch. Review it like any other change.",
  ].join("\n");
}

export async function runUntangle(deps: UntangleDeps, opts: UntangleOptions): Promise<UntangleOutcome> {
  const { sh, log } = deps;
  const before = await deps.verify(opts.target);
  const contract = before.results.filter((r) => r.status === "ok").map((r) => r.flow);
  if (contract.length === 0) {
    return { result: "refused", why: "no flow passes on the target, so there is no behavior to hold the refactor to — fix or build the suite first" };
  }

  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 12);
  const branch = `argus/untangle/${stamp}`;
  const dir = `${opts.repo}/.argus/worktrees/${branch.replace(/\//g, "_")}`;
  const add = await sh(`git worktree add -b ${branch} "${dir}" HEAD`, { cwd: opts.repo });
  if (add.code !== 0) return { result: "agent-failed", branch, why: `worktree: ${add.out.slice(-300)}` };

  const casesBefore = countSpecialCases(await deps.readSources(dir));
  log(`contract: ${contract.length} flows pass on ${opts.target} · special cases: ${describeCases(casesBefore)}`);
  log(`untangling on ${branch} (agent: ${opts.agent}) — this is a whole-codebase pass and can take a long time`);

  const agent = await sh(opts.agent, { cwd: dir, input: untanglePrompt(opts, contract), timeoutMs: opts.timeoutMin * 60_000 });
  if (agent.code !== 0) return { result: "agent-failed", branch, why: agent.out.slice(-300) };

  const decisionLog = (await sh(`cat ${LOG_FILE}`, { cwd: dir })).out;
  await sh(`rm -f ${LOG_FILE}`, { cwd: dir });
  const changed = (await sh("git status --porcelain", { cwd: dir })).out
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  if (changed.length === 0) return { result: "no-change", branch, why: "the agent changed nothing" };
  const cheated = touchesFlows(changed);
  if (cheated.length) return { result: "rejected", branch, why: `edited the behavior contract: ${cheated.join(", ")}` };

  const casesAfter = countSpecialCases(await deps.readSources(dir));
  const specialCases = { before: casesBefore, after: casesAfter };
  await sh(`git add -A && git commit -m "refactor: untangle the codebase (argus untangle)"`, { cwd: dir });

  if (!opts.preview) {
    return { result: "unverified", branch, specialCases, why: "no --preview command, so the refactor was never run — behavior unproven, no PR" };
  }
  const preview = await sh(opts.preview, { cwd: dir, timeoutMs: 10 * 60_000 });
  const url = preview.code === 0 ? lastUrl(preview.out) : undefined;
  if (!url) return { result: "unverified", branch, specialCases, why: `preview printed no URL (exit ${preview.code})` };

  const result = checkContract(before, await deps.verify(url));
  const summary = { kept: result.kept.length, total: result.total, fixed: result.fixed };
  if (result.broken.length) {
    const first = result.broken[0]!;
    return {
      result: "rejected",
      branch,
      specialCases,
      contract: summary,
      why: `behavior changed: ${result.broken.map((b) => b.flow).join(", ")} (${first.decision?.verdict}: ${first.decision?.whatChanged ?? ""})`.slice(0, 400),
    };
  }
  if (result.unproven.length) {
    return { result: "unverified", branch, specialCases, contract: summary, why: `could not prove ${result.unproven.join(", ")} (flaky or untested on the preview)` };
  }
  if (!opts.openPr) return { result: "verified", branch, specialCases, contract: summary };

  const push = await sh(`git push -u origin ${branch}`, { cwd: dir });
  const pr = await sh(`gh pr create --draft --head ${branch} --title "refactor: untangle the codebase (argus)" --body-file -`, {
    cwd: dir,
    input: untanglePrBody({ contract: result, before: casesBefore, after: casesAfter, previewUrl: url, log: decisionLog }),
  });
  const prUrl = lastUrl(pr.out);
  if (push.code !== 0 || pr.code !== 0 || !prUrl) {
    return { result: "verified", branch, specialCases, contract: summary, why: `proven, but the PR could not be opened: ${(push.code ? push.out : pr.out).slice(-200)}` };
  }
  return { result: "pr", branch, url: prUrl, specialCases, contract: summary };
}
