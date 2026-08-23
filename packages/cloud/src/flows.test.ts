import { describe, expect, it } from "vitest";
import type { Flow } from "@argus/shared";
import { rehomeFlow } from "./flow-utils";

const flow: Flow = {
  version: 1,
  name: "checkout",
  startUrl: "https://production.example.com/cart?coupon=save#total",
  viewport: "desktop",
  steps: [{ action: { action: "wait", ms: 50 }, expect: [] }],
  success: [{ kind: "console-clean", since: 0, includeThirdParty: false }],
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
});
