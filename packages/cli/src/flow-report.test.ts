import { describe, expect, it } from "vitest";
import { describePredicate, formatFlowFailures } from "./flow-report";

const flow = {
  version: 1,
  name: "add-task",
  startUrl: "http://localhost:5199/",
  viewport: "desktop",
  steps: [
    { action: { action: "wait", ms: 1500 }, expect: [] },
    { action: { action: "fill", value: "Buy milk" }, anchor: { testid: "new-task" }, expect: [] },
    {
      action: { action: "click" },
      anchor: { testid: "add-task" },
      expect: [{ kind: "network", urlIncludes: "/api/tasks", method: "POST", status: 201, minCount: 1, maxCount: 1 }],
    },
  ],
  success: [
    { kind: "text", anchor: { testid: "task-count" }, includes: "3 task(s)" },
    { kind: "console-clean", since: 0 },
  ],
};

describe("formatFlowFailures", () => {
  it("prints nothing for passing flows", () => {
    expect(formatFlowFailures([{ flow: "add-task", status: "ok", stepsRun: 3 }], [flow])).toEqual([]);
  });

  it("names the success condition, expected vs actual, and the evidence", () => {
    const lines = formatFlowFailures(
      [
        {
          flow: "add-task",
          status: "error",
          stepsRun: 3,
          decision: {
            verdict: "success_condition_failed",
            whatChanged: 'text is "3 tasks"',
            nextAction: "every step ran but the flow's success condition does not hold",
          },
          evidenceTier: "dom",
          screenshotKey: "tenants/_admin/flows/add-task/final.png",
        },
      ],
      [flow],
      { api: "https://argus.example", runId: "ab12cd34" }
    );
    expect(lines).toEqual([
      "✘ add-task — success_condition_failed",
      "    failed at: success condition (all 3 steps ran)",
      '    expected:  [testid=task-count] text includes "3 task(s)"; no console errors',
      '    actual:    text is "3 tasks"',
      "    next:      every step ran but the flow's success condition does not hold",
      "    evidence:  run ab12cd34 · tier dom · screenshot https://argus.example/v1/artifact/tenants/_admin/flows/add-task/final.png",
    ]);
  });

  it("names the failing step and its expectation", () => {
    const lines = formatFlowFailures(
      [
        {
          flow: "add-task",
          status: "error",
          stepsRun: 3,
          failedStep: 2,
          decision: {
            verdict: "expectation_failed",
            whatChanged: 'step 2: 0 matching request(s) for "/api/tasks"',
            nextAction: "check the handler",
          },
        },
      ],
      [flow]
    );
    expect(lines[1]).toBe("    failed at: step 2 of 3 — click on [testid=add-task]");
    expect(lines[2]).toBe("    expected:  exactly 1 × POST /api/tasks → 201");
    expect(lines[3]).toBe('    actual:    step 2: 0 matching request(s) for "/api/tasks"');
  });

  it("reports drift with the suggested fix, and survives results it has no flow file for", () => {
    const lines = formatFlowFailures(
      [
        {
          flow: "unknown",
          status: "drift",
          stepsRun: 1,
          failedStep: 1,
          decision: {
            verdict: "drift",
            whatChanged: 'step 1: anchor "new-task" (via testid) not found on the live page',
            suggestedFix: 'rebind the anchor to "task-input"',
            nextAction: "run flow heal",
          },
        },
        { flow: "bare", status: "error" },
        "garbage",
      ],
      [flow]
    );
    expect(lines).toContain("✘ unknown — drift");
    expect(lines).toContain("    failed at: step 1");
    expect(lines).toContain('    fix:       rebind the anchor to "task-input"');
    expect(lines).toContain("✘ bare — error");
    expect(lines).toContain("    actual:    status error, no detail returned");
  });
});

describe("describePredicate", () => {
  it("falls back to JSON for kinds it does not know", () => {
    expect(describePredicate({ kind: "storage", key: "k" })).toBe('{"kind":"storage","key":"k"}');
  });
});
