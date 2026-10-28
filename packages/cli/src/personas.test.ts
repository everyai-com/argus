import { describe, expect, it } from "vitest";
import { checkedTier, extractReport, mergeReports, renderReport, type PersonaReport } from "./personas";

// Abridged from the real round-1 reports against the demo (2026-10-28).
const footer = { text: "Argus demo app · bug=none" };
const round1: PersonaReport[] = [
  { persona: "impatient", reachedSuccess: true, moments: [] },
  {
    persona: "literal",
    reachedSuccess: true,
    moments: [
      { kind: "confused", where: "/", element: { testid: "add-task" }, symptom: "no-validation-message", severity: "major",
        evidence: { tier: "signal", effects: { silentAction: true, domMutations: 0 } } },
      { kind: "confused", where: "/", element: footer, symptom: "internal-text-visible", severity: "minor", evidence: { tier: "dom" } },
      { kind: "confused", where: "/", element: { testid: "new-task" }, symptom: "placeholder-only-label", severity: "minor", evidence: { tier: "visual" } },
    ],
  },
  {
    persona: "mobile",
    reachedSuccess: true,
    moments: [
      { kind: "annoyed", where: "/", element: { testid: "add-task" }, symptom: "tap-target-too-small", severity: "minor",
        evidence: { tier: "dom", effects: { bounds: { h: 35 } } } },
      { kind: "confused", where: "/", element: footer, symptom: "unclear-copy", severity: "minor", evidence: { tier: "visual" } },
    ],
  },
  {
    persona: "skeptic",
    reachedSuccess: false,
    moments: [
      { kind: "broken", where: "/", element: { testid: "task-list" }, symptom: "data-lost-on-reload", severity: "blocker",
        evidence: { tier: "consequence", effects: { network: ["POST /api/tasks 201", "GET /api/tasks 200"] } } },
    ],
  },
  {
    persona: "breaker",
    reachedSuccess: true,
    moments: [
      { kind: "broken", where: "/", element: { testid: "task-list" }, symptom: "data-lost-on-reload", severity: "blocker",
        evidence: { tier: "consequence", effects: { navigated: true, domNodeDelta: -7 } } },
      { kind: "broken", where: "/", element: { testid: "add-task" }, symptom: "duplicate-submit", severity: "major",
        evidence: { tier: "signal", effects: { domNodeDelta: 2, silentAction: false } } },
      { kind: "annoyed", where: "/?bug=none", element: { testid: "add-task" }, symptom: "no-validation-message", severity: "minor",
        evidence: { tier: "signal", effects: { silentAction: true } } },
    ],
  },
];

describe("argus personas merge", () => {
  const issues = mergeReports(round1);

  it("ranks by how many users hit an issue, then severity", () => {
    expect(issues.slice(0, 3).map((i) => [i.symptom, i.personas.length, i.severity])).toEqual([
      ["data-lost-on-reload", 2, "blocker"],
      ["no-validation-message", 2, "major"],
      ["unclear-copy", 2, "minor"],
    ]);
  });

  it("counts synonyms and query strings as the same issue", () => {
    expect(issues.find((i) => i.symptom === "unclear-copy")?.personas).toEqual(["literal", "mobile"]);
    expect(issues.find((i) => i.symptom === "missing-label")).toBeDefined();
    expect(issues.find((i) => i.symptom === "no-validation-message")?.personas).toEqual(["literal", "breaker"]);
  });

  it("never lets a user promote evidence by claiming a tier", () => {
    // The round-1 users called silentAction "signal" — it is a DOM read.
    expect(checkedTier(round1[1]!.moments[0]!)).toBe("dom");
    expect(issues.find((i) => i.symptom === "duplicate-submit")?.tier).toBe("dom");
    // Request evidence holds up as consequence.
    expect(checkedTier(round1[3]!.moments[0]!)).toBe("consequence");
    expect(issues.every((i) => i.tier !== "signal")).toBe(true);
  });

  it("pulls the report out of an agent that talked first, and renders the headline", () => {
    const out = `Sure! Here's what I found.\n\`\`\`json\n${JSON.stringify(round1[3])}\n\`\`\`\nLet me know.`;
    expect(extractReport(out)?.persona).toBe("skeptic");
    expect(extractReport("no json")).toBeUndefined();
    const md = renderReport("https://demo", round1, issues);
    expect(md).toContain("Reached first success: **4/5**");
    expect(md).toContain("| 1 | data-lost-on-reload (task-list) | / | 2: skeptic, breaker | blocker | consequence |");
  });
});
