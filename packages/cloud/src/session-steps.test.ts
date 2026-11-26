import { describe, expect, it } from "vitest";
import { FlowDraftSchema, FlowSchema, type NetworkEvent } from "@argus/shared";
import { buildFlowDraft, buildStep, placeholderName, scrub } from "./session-steps";

describe("buildStep", () => {
  it("drops the volatile ref and carries the resolved anchor beside the action", () => {
    const built = buildStep({ action: "click", ref: "e7" }, { anchor: { testid: "add-task" }, matched: 1 });
    expect(built).toEqual({
      step: { action: { action: "click" }, anchor: { testid: "add-task" }, expect: [] },
      blocking: false,
    });
  });

  it("never writes what was typed into a password field", () => {
    const built = buildStep(
      { action: "fill", anchor: { testid: "login-password" }, value: "hunter2-secret" },
      { anchor: { testid: "login-password" }, matched: 1, secure: true, hint: "login-password" }
    );
    expect(JSON.stringify(built)).not.toContain("hunter2");
    expect(built.step.action).toEqual({ action: "fill", value: "${LOGIN_PASSWORD}" });
    expect(built.note).toContain("LOGIN_PASSWORD");
    expect(built.blocking).toBe(false);
  });

  it("refuses to pass off an unanchored or ambiguous target as replayable", () => {
    const none = buildStep({ action: "click", ref: "e1" }, {});
    expect(none.blocking).toBe(true);
    expect(none.step.anchor).toBeUndefined();
    const many = buildStep({ action: "click", anchor: { text: "Delete" } }, { anchor: { text: "Delete" }, matched: 3 });
    expect(many.blocking).toBe(true);
    expect(many.note).toContain("matched 3 elements");
    // Actions without a target need no anchor.
    expect(buildStep({ action: "press", key: "Enter" }, {}).blocking).toBe(false);
    expect(buildStep({ action: "goto", url: "https://app.test/x" }, {}).note).toBeUndefined();
  });

  it("names placeholders after the field", () => {
    expect(placeholderName("login-password")).toBe("LOGIN_PASSWORD");
    expect(placeholderName("newPassword")).toBe("NEW_PASSWORD");
    expect(placeholderName("")).toBe("PASSWORD");
    expect(placeholderName("2fa")).toBe("SECRET_2FA");
  });

  it("scrubs a secret out of an error that quotes it", () => {
    expect(scrub('locator.fill("hunter2") timed out', "hunter2")).toBe('locator.fill("[redacted]") timed out');
  });
});

describe("buildFlowDraft", () => {
  const net = (over: Partial<NetworkEvent>): NetworkEvent => ({
    seq: 1,
    method: "GET",
    url: "https://app.test/api/tasks",
    status: 200,
    failed: false,
    ...over,
  });
  const base = {
    name: "add-task",
    startUrl: "https://app.test/",
    viewport: "desktop" as const,
    blockers: [],
    dropped: 0,
    finalUrl: "https://app.test/board",
    consoleErrors: 0,
    network: [],
  };

  it("answers a flow argus_flow_save accepts as it stands", () => {
    const draft = buildFlowDraft({
      ...base,
      steps: [
        { action: { action: "fill", value: "${LOGIN_PASSWORD}" }, anchor: { testid: "login-password" }, expect: [] },
        { action: { action: "click" }, anchor: { testid: "sign-in" }, expect: [] },
      ],
      network: [
        net({ seq: 2 }),
        net({ seq: 3, method: "POST", status: 201 }),
        net({ seq: 4, method: "POST", status: 201 }), // deduplicated
        net({ seq: 5, method: "POST", status: 500, failed: true }),
        net({ seq: 6, method: "POST", url: "https://analytics.example/beacon", status: 204 }),
      ],
    });
    expect(FlowDraftSchema.safeParse(draft).success).toBe(true);
    expect(FlowSchema.safeParse({ version: 1, ...draft.flow }).success).toBe(true);
    expect(draft.ready).toBe(true);
    expect(draft.flow.success).toEqual([
      { kind: "route", includes: "/board" },
      { kind: "console-clean", since: 0, cumulative: false, includeThirdParty: false },
    ]);
    // Only the first-party write that succeeded is worth suggesting.
    expect(draft.suggested).toEqual([
      { kind: "network", urlIncludes: "/api/tasks", method: "POST", status: 201, minCount: 1, since: 0, cumulative: false },
    ]);
    expect(draft.placeholders).toEqual(["LOGIN_PASSWORD"]);
    expect(draft.notes.join(" ")).toContain("LOGIN_PASSWORD");
  });

  it("is not ready with no steps or a blocked step, and does not claim a clean console it did not see", () => {
    const empty = buildFlowDraft({ ...base, steps: [], consoleErrors: 2, finalUrl: "https://app.test/" });
    expect(empty.ready).toBe(false);
    expect(empty.flow.success).toEqual([{ kind: "route", includes: "/" }]);
    const blocked = buildFlowDraft({
      ...base,
      steps: [{ action: { action: "click" }, expect: [] }],
      blockers: ["step 0 (click): no anchor identifies this element uniquely"],
      dropped: 3,
    });
    expect(blocked.ready).toBe(false);
    expect(blocked.notes[0]).toContain("step 0 (click)");
    expect(blocked.dropped).toBe(3);
  });
});
