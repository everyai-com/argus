import { describe, expect, it } from "vitest";
import { patrolTick, type PatrolDeps, type PatrolState } from "./patrol";
import type { Suite } from "./fix";

const red: Suite = {
  status: "fail",
  results: [{ flow: "add-task", status: "error", confirmation: { state: "confirmed" }, decision: { verdict: "not_persisted" } }],
};

function deps(over: Partial<PatrolDeps> & { head?: string; suite?: Suite; state?: PatrolState }) {
  let state: PatrolState = over.state ?? {};
  let verifies = 0;
  let fixes = 0;
  const d: PatrolDeps = {
    headSha: async () => over.head ?? "abc1234",
    verify: async () => (verifies++, over.suite ?? { status: "pass", results: [] }),
    fix: async () => (fixes++, []),
    readState: () => state,
    writeState: (s) => void (state = s),
    log: () => {},
    ...over,
  };
  return { d, counts: () => ({ verifies, fixes }), state: () => state };
}

describe("argus patrol", () => {
  it("costs nothing on a quiet branch", async () => {
    const t = deps({ state: { lastSha: "abc1234" } });
    expect(await patrolTick(t.d)).toMatchObject({ ran: false });
    expect(t.counts()).toEqual({ verifies: 0, fixes: 0 });
  });

  it("verifies a new head once, fixes confirmed failures, and remembers the sha", async () => {
    const t = deps({ suite: red, state: { lastSha: "old0000" } });
    expect(await patrolTick(t.d)).toMatchObject({ ran: true, failing: ["add-task"] });
    expect(t.counts()).toEqual({ verifies: 1, fixes: 1 });
    expect(t.state().lastSha).toBe("abc1234");
    expect(await patrolTick(t.d)).toMatchObject({ ran: false });
  });

  it("retries a commit it could not test instead of skipping it", async () => {
    const t = deps({ suite: { status: "untested", results: [] } });
    await patrolTick(t.d);
    expect(t.state().lastSha).toBeUndefined();
  });
});
