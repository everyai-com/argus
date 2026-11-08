import { describe, expect, it } from "vitest";
import type { Suite } from "./fix";
import { checkContract, countSpecialCases, runUntangle, untanglePrompt, type UntangleDeps, type UntangleOptions } from "./untangle";

const before: Suite = {
  status: "fail",
  results: [
    { flow: "add-task", status: "ok" },
    { flow: "loads-clean", status: "ok" },
    { flow: "persists", status: "error", confirmation: { state: "confirmed" }, decision: { verdict: "not_persisted" } },
  ],
};
const allPass: Suite = {
  status: "pass",
  results: [
    { flow: "add-task", status: "ok" },
    { flow: "loads-clean", status: "ok" },
    { flow: "persists", status: "ok" },
  ],
};

const tangled = { path: "a.ts", text: "try { x() } catch {}\nsetTimeout(go, 100)\nit.skip('later', () => {})\np.catch(() => {})" };
const clean = { path: "a.ts", text: "x()\ngo()" };

function fakeDeps(script: { after?: Suite; changed?: string; preview?: string; agentCode?: number; before?: Suite }) {
  const calls: string[] = [];
  let verifies = 0;
  let agentRan = false;
  const deps: UntangleDeps = {
    verify: async () => (verifies++ === 0 ? (script.before ?? before) : (script.after ?? allPass)),
    readSources: async () => [agentRan ? clean : tangled],
    sh: async (cmd, opts) => {
      calls.push(cmd);
      if (cmd === "AGENT") {
        agentRan = true;
        expect(opts.input).toContain("- add-task");
        return { code: script.agentCode ?? 0, out: "" };
      }
      if (cmd.startsWith("cat ")) return { code: 0, out: "- Fold the two action lists into one command table\n  - `ui/Menu.tsx:22` duplicates the toolbar's checks" };
      if (cmd.startsWith("git status")) return { code: 0, out: script.changed ?? " M src/app.ts\n" };
      if (cmd === "PREVIEW") return { code: 0, out: script.preview ?? "built\nhttps://preview.app.test\n" };
      if (cmd.startsWith("gh pr create")) return { code: 0, out: "https://github.com/o/r/pull/9\n" };
      return { code: 0, out: "" };
    },
    log: () => {},
  };
  return { deps, calls };
}

const opts: UntangleOptions = {
  repo: "/repo",
  target: "https://app.test",
  agent: "AGENT",
  preview: "PREVIEW",
  openPr: true,
  comments: false,
  tests: false,
  timeoutMin: 120,
};

describe("runUntangle", () => {
  it("opens a PR when every flow that passed still passes — and counts a newly passing flow as fixed", async () => {
    const { deps, calls } = fakeDeps({});
    const o = await runUntangle(deps, opts);
    expect(o).toMatchObject({ result: "pr", url: "https://github.com/o/r/pull/9", contract: { kept: 2, total: 2, fixed: ["persists"] } });
    expect(o.specialCases?.before.total).toBe(4);
    expect(o.specialCases?.after?.total).toBe(0);
    // The decision log is read for the PR, then kept out of the commit.
    expect(calls.indexOf("rm -f UNTANGLE_LOG.md")).toBeLessThan(calls.findIndex((c) => c.startsWith("git add -A")));
  });

  it("rejects a refactor that changed behavior", async () => {
    const after: Suite = {
      status: "fail",
      results: [
        { flow: "add-task", status: "error", confirmation: { state: "confirmed" }, decision: { verdict: "success_condition_failed", whatChanged: "0 matching request(s)" } },
        { flow: "loads-clean", status: "ok" },
      ],
    };
    const o = await runUntangle(fakeDeps({ after }).deps, opts);
    expect(o.result).toBe("rejected");
    expect(o.why).toContain("behavior changed: add-task");
  });

  it("will not call flaky or untested flows proven", async () => {
    const after: Suite = {
      status: "untested",
      results: [
        { flow: "add-task", status: "error", confirmation: { state: "flaky" } },
        { flow: "loads-clean", status: "error", decision: { verdict: "fleet_busy" } },
      ],
    };
    const o = await runUntangle(fakeDeps({ after }).deps, opts);
    expect(o).toMatchObject({ result: "unverified" });
    expect(o.why).toContain("add-task, loads-clean");
  });

  it("rejects an agent that edits the flows instead of keeping behavior", async () => {
    const o = await runUntangle(fakeDeps({ changed: " M src/app.ts\n M .argus/flows/add-task.json\n" }).deps, opts);
    expect(o).toMatchObject({ result: "rejected", why: "edited the behavior contract: .argus/flows/add-task.json" });
  });

  it("refuses without a contract, and never opens a PR without a preview", async () => {
    const none: Suite = { status: "fail", results: [{ flow: "x", status: "error" }] };
    expect((await runUntangle(fakeDeps({ before: none }).deps, opts)).result).toBe("refused");
    const { deps, calls } = fakeDeps({});
    expect((await runUntangle(deps, { ...opts, preview: undefined })).result).toBe("unverified");
    expect(calls.some((c) => c.startsWith("gh pr"))).toBe(false);
  });
});

describe("checkContract", () => {
  it("separates kept, broken, unproven and fixed", () => {
    const after: Suite = {
      status: "fail",
      results: [
        { flow: "add-task", status: "ok" },
        { flow: "persists", status: "ok" },
      ],
    };
    expect(checkContract(before, after)).toMatchObject({ total: 2, kept: ["add-task"], broken: [], unproven: ["loads-clean"], fixed: ["persists"] });
  });
});

describe("countSpecialCases", () => {
  it("counts sleeps, swallowed errors (comment-only catches too) and disabled tests", () => {
    const c = countSpecialCases([tangled, { path: "b.ts", text: "try { f() } catch {\n  /* best effort */\n}\nxit('no', () => {})" }]);
    expect(c).toEqual({ sleeps: 1, swallowed: 3, disabledTests: 2, total: 6 });
  });

  it("does not count a catch that handles the error", () => {
    expect(countSpecialCases([{ path: "c.ts", text: "try { f() } catch (e) { log(e); throw e }" }]).swallowed).toBe(0);
  });
});

describe("untanglePrompt", () => {
  it("turns the skill's interactive choices into instructions and names the contract", () => {
    const p = untanglePrompt({ comments: true, tests: false, focus: "billing" }, ["add-task"]);
    expect(p).toContain("Focus area: billing");
    expect(p).toContain("remove comments that restate the implementation");
    expect(p).toContain("Don't remove or weaken tests");
    expect(p).toContain("- add-task");
    expect(p).toContain("Do not edit anything under .argus/");
  });
});
