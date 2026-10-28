import { describe, expect, it } from "vitest";
import { fixableFailures, lastUrl, runFixLoop, touchesFlows, type FixDeps, type Suite } from "./fix";

const failing: Suite = {
  status: "fail",
  results: [
    { flow: "add-task", status: "error", confirmation: { state: "confirmed" }, decision: { verdict: "not_persisted", whatChanged: "after a reload: text is \"2 tasks\"" } },
    { flow: "flaky-one", status: "error", confirmation: { state: "flaky" }, decision: { verdict: "error" } },
    { flow: "busy", status: "error", confirmation: { state: "confirmed" }, decision: { verdict: "fleet_busy" } },
    { flow: "loads-clean", status: "ok" },
  ],
};
const passing = (extra: Suite["results"] = []): Suite => ({
  status: "pass",
  results: [{ flow: "add-task", status: "ok" }, { flow: "loads-clean", status: "ok" }, ...extra],
});

function fakeDeps(script: { changed?: string; preview?: string; after?: Suite; agentCode?: number }) {
  const calls: string[] = [];
  let verifies = 0;
  const deps: FixDeps = {
    verify: async () => (verifies++ === 0 ? failing : (script.after ?? passing())),
    sh: async (cmd) => {
      calls.push(cmd);
      if (cmd.startsWith("git status")) return { code: 0, out: script.changed ?? "" };
      if (cmd === "AGENT") return { code: script.agentCode ?? 0, out: "" };
      if (cmd === "PREVIEW") return { code: 0, out: script.preview ?? "" };
      if (cmd.startsWith("gh pr create")) return { code: 0, out: "https://github.com/o/r/pull/7\n" };
      return { code: 0, out: "" };
    },
    log: () => {},
  };
  return { deps, calls };
}
const opts = { repo: "/r", target: "https://app.dev", agent: "AGENT", preview: "PREVIEW", openPr: true, max: 3 };

describe("argus fix", () => {
  it("only fixes repeated product failures — never flaky or untested runs", () => {
    expect(fixableFailures(failing).map((r) => r.flow)).toEqual(["add-task"]);
  });

  it("refuses a 'fix' that edits the flow that caught the bug", async () => {
    const { deps, calls } = fakeDeps({ changed: " M .argus/flows/add-task.json\n M src/App.tsx\n" });
    const [o] = await runFixLoop(deps, opts);
    expect(o).toMatchObject({ result: "rejected" });
    expect(calls.some((c) => c.startsWith("gh pr"))).toBe(false);
    expect(touchesFlows(["src/a.ts", ".argus/baselines/v2/x.png"])).toEqual([".argus/baselines/v2/x.png"]);
  });

  it("opens a draft PR only after the flow passes on a preview of the fix", async () => {
    const { deps, calls } = fakeDeps({ changed: " M src/App.tsx\n", preview: "Uploaded\nPreview: https://abc.app.workers.dev\n" });
    const [o] = await runFixLoop(deps, opts);
    expect(o).toEqual({ flow: "add-task", result: "pr", branch: expect.stringMatching(/^argus\/fix\/add-task-/), url: "https://github.com/o/r/pull/7" });
    expect(calls.find((c) => c.startsWith("gh pr create"))).toContain("--draft");
  });

  it("no preview = no proof = no PR, and a fix that breaks another flow is rejected", async () => {
    const a = fakeDeps({ changed: " M src/App.tsx\n" });
    expect((await runFixLoop(a.deps, { ...opts, preview: undefined }))[0]).toMatchObject({ result: "unverified" });
    expect(a.calls.some((c) => c.startsWith("git push"))).toBe(false);

    const b = fakeDeps({
      changed: " M src/App.tsx\n",
      preview: "https://p.dev",
      after: passing([{ flow: "checkout", status: "error", confirmation: { state: "confirmed" }, decision: { verdict: "drift" } }]),
    });
    expect((await runFixLoop(b.deps, opts))[0]).toMatchObject({ result: "rejected", why: expect.stringContaining("checkout") });
  });

  it("leaves a fix alone once a person closed its PR unmerged", async () => {
    const { deps, calls } = fakeDeps({ changed: " M src/App.tsx\n", preview: "https://p.dev" });
    const [o] = await runFixLoop({ ...deps, declined: async (f) => f === "add-task" }, opts);
    expect(o).toMatchObject({ result: "declined" });
    expect(calls).toEqual([]);
  });

  it("reads the preview URL a deploy tool prints last", () => {
    expect(lastUrl("see https://dash.cloudflare.com\nVersion Preview URL: https://1a2b-app.acct.workers.dev.")).toBe(
      "https://1a2b-app.acct.workers.dev"
    );
    expect(lastUrl("no url here")).toBeUndefined();
  });
});
