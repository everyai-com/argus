import { describe, expect, it } from "vitest";
import { compareVersions, validateFlowFile } from "./doctor";

const validFlow = {
  version: 1,
  name: "add-task",
  startUrl: "http://localhost:5199/",
  viewport: "desktop",
  steps: [
    { action: { action: "wait", ms: 1500 }, expect: [] },
    { action: { action: "fill", value: "Buy milk" }, anchor: { testid: "new-task" }, expect: [] },
    { action: { action: "click" }, anchor: { testid: "add-task" }, expect: [] },
  ],
  success: [
    { kind: "text", anchor: { testid: "task-count" }, includes: "3 task(s)" },
    { kind: "console-clean", since: 0 },
  ],
};

describe("validateFlowFile", () => {
  it("accepts a well-formed flow", () => {
    expect(validateFlowFile("add-task.json", validFlow)).toEqual([]);
  });

  it("rejects non-objects and missing top-level fields", () => {
    expect(validateFlowFile("x.json", null)).toHaveLength(1);
    expect(validateFlowFile("x.json", [])).toHaveLength(1);
    const missing = validateFlowFile("x.json", {});
    expect(missing.map((i) => i.issue)).toEqual([
      'missing string "name"',
      'missing string "startUrl"',
      'missing array "steps"',
      'missing non-empty array "success"',
    ]);
  });

  it("requires anchors on anchored actions, not on waits", () => {
    const flow = {
      ...validFlow,
      steps: [
        { action: { action: "wait", ms: 100 }, expect: [] },
        { action: { action: "click" }, expect: [] },
      ],
    };
    const issues = validateFlowFile("x.json", flow);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.issue).toContain('"click" needs a semantic anchor');
  });

  it("requires anchors on anchored predicates, not on console-clean", () => {
    const flow = { ...validFlow, success: [{ kind: "visible" }] };
    const issues = validateFlowFile("x.json", flow);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.issue).toContain('"visible" needs a semantic anchor');
  });

  it("accepts every anchor rung", () => {
    for (const anchor of [
      { testid: "a" },
      { role: "button", name: "Add" },
      { text: "Add" },
      { css: "h1" },
    ]) {
      const flow = {
        ...validFlow,
        steps: [{ action: { action: "click" }, anchor, expect: [] }],
      };
      expect(validateFlowFile("x.json", flow)).toEqual([]);
    }
  });
});

describe("compareVersions", () => {
  it("spots drift past ranges and date-versions", () => {
    expect(compareVersions("^4.20250101.0", "5.20261003.1")).toBe("behind");
    expect(compareVersions("^5.20260804.1", "5.20261003.1")).toBe("behind");
    expect(compareVersions("~1.2.3", "1.2.3")).toBe("current");
    expect(compareVersions("^5.20261003.1", "5.20261003.1")).toBe("current");
    expect(compareVersions("^6.0.0", "5.9.9")).toBe("current");
  });

  it("returns unknown for unparseable input", () => {
    expect(compareVersions("latest", "1.2.3")).toBe("unknown");
    expect(compareVersions("^1.2.3", "")).toBe("unknown");
  });
});
