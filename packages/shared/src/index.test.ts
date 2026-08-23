import { describe, expect, it } from "vitest";
import {
  AnchorSchema,
  CreateTenantRequestSchema,
  FlowSchema,
  LeaseRequestSchema,
  MAX_LEASE_TTL_SECONDS,
  TenantIdSchema,
  UpdateTenantRequestSchema,
} from "./index";

describe("wire contract", () => {
  it("rejects anchors that cannot identify an element", () => {
    expect(AnchorSchema.safeParse({}).success).toBe(false);
    expect(AnchorSchema.parse({ testid: "submit" })).toEqual({ testid: "submit" });
  });

  it("applies safe lease defaults and enforces the browser lifetime", () => {
    const lease = LeaseRequestSchema.parse({ url: "https://example.com" });
    expect(lease.viewport).toBe("desktop");
    expect(lease.colorScheme).toBe("light");
    expect(lease.ttlSeconds).toBe(300);
    expect(
      LeaseRequestSchema.safeParse({
        url: "https://example.com",
        ttlSeconds: MAX_LEASE_TTL_SECONDS + 1,
      }).success
    ).toBe(false);
  });

  it("keeps tenant identifiers to one safe storage segment", () => {
    expect(TenantIdSchema.safeParse("team_alpha-2").success).toBe(true);
    expect(TenantIdSchema.safeParse("../../other-team").success).toBe(false);
    expect(TenantIdSchema.safeParse("Team Alpha").success).toBe(false);
  });

  it("requires meaningful and internally valid tenant updates", () => {
    expect(UpdateTenantRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateTenantRequestSchema.safeParse({ maxBurst: 8 }).success).toBe(true);
    expect(
      CreateTenantRequestSchema.safeParse({ id: "team", reserved: 4, maxBurst: 2 }).success
    ).toBe(true);
  });

  it("requires flows to have actions and a verified success condition", () => {
    const base = {
      version: 1 as const,
      name: "loads-clean",
      startUrl: "https://example.com",
      steps: [{ action: { action: "wait" as const, ms: 50 } }],
      success: [{ kind: "console-clean" as const }],
    };
    expect(FlowSchema.safeParse(base).success).toBe(true);
    expect(FlowSchema.safeParse({ ...base, success: [] }).success).toBe(false);
    expect(FlowSchema.safeParse({ ...base, name: "../escape" }).success).toBe(false);
  });
});
