import { describe, expect, it } from "vitest";
import { FlowVerdictSchema } from "@argus/shared";
import type { Flow } from "@argus/shared";
import { ambiguityDecision } from "./flows";
import { rehomeFlow } from "./flow-utils";

const flow: Flow = {
  version: 1,
  name: "checkout",
  startUrl: "https://production.example.com/cart?coupon=save#total",
  viewport: "desktop",
  steps: [{ action: { action: "wait", ms: 50 }, expect: [] }],
  success: [{ kind: "console-clean", since: 0, cumulative: false, includeThirdParty: false }],
  dynamic: [],
};

describe("flow environment overrides", () => {
  it("changes only the origin", () => {
    const moved = rehomeFlow(flow, "https://preview.example.workers.dev/base");
    expect(moved.startUrl).toBe("https://preview.example.workers.dev/cart?coupon=save#total");
    expect(moved.name).toBe(flow.name);
  });

  it("does not mutate the original flow", () => {
    rehomeFlow(flow, "https://preview.example.com");
    expect(flow.startUrl).toBe("https://production.example.com/cart?coupon=save#total");
  });

  it("drops the flow's port when the base has none (localhost → tunnel)", () => {
    const local: Flow = {
      ...flow,
      name: "add-task",
      startUrl: "http://localhost:5199/?bug=none",
    };
    const moved = rehomeFlow(local, "https://abc-def.trycloudflare.com");
    expect(moved.startUrl).toBe("https://abc-def.trycloudflare.com/?bug=none");
  });

  it("takes the base port when the base has one", () => {
    const moved = rehomeFlow(flow, "http://staging.example.com:8080/base");
    expect(moved.startUrl).toBe("http://staging.example.com:8080/cart?coupon=save#total");
  });

  it("leaves the flow untouched when the base is not a URL", () => {
    expect(rehomeFlow(flow, "not a url").startUrl).toBe(flow.startUrl);
  });
});

describe("ambiguous anchors", () => {
  it("names the candidates instead of guessing", () => {
    const d = ambiguityDecision(2, "Add", "text", 3, ['button "Add"', 'a "Add"']);
    expect(d.verdict).toBe("ambiguous_anchor");
    expect(FlowVerdictSchema.safeParse(d.verdict).success).toBe(true);
    expect(d.whatChanged).toContain('step 2: anchor "Add" (via text) matched 3 elements');
    expect(d.whatChanged).toContain('button "Add"');
    expect(d.suggestedFix).toContain("data-testid");
    expect(d.nextAction).toContain("re-run");
  });

  it("stays legible when candidates cannot be described", () => {
    const d = ambiguityDecision(0, ".btn", "css", 12, []);
    expect(d.whatChanged).toBe('step 0: anchor ".btn" (via css) matched 12 elements');
  });
});
