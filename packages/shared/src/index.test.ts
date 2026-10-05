import { describe, expect, it } from "vitest";
import {
  ActorSchema,
  AnchorSchema,
  apiError,
  ApiErrorSchema,
  CreateTenantRequestSchema,
  FlowActionSchema,
  FlowSchema,
  FlowVerdictSchema,
  LeaseRequestSchema,
  MAX_LEASE_TTL_SECONDS,
  PredicateSchema,
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

  it("parses composable predicates and browser storage", () => {
    const storage = { kind: "storage", key: "token", includes: "tok" };
    expect(PredicateSchema.safeParse(storage).success).toBe(true);
    // area defaults to local
    expect((PredicateSchema.parse(storage) as { area?: string }).area).toBe("local");

    const nested = {
      kind: "allOf",
      predicates: [
        { kind: "route", includes: "/checkout" },
        { kind: "anyOf", predicates: [storage, { kind: "console-clean" }] },
      ],
    };
    expect(PredicateSchema.safeParse(nested).success).toBe(true);
    // an empty group is not a check
    expect(PredicateSchema.safeParse({ kind: "allOf", predicates: [] }).success).toBe(false);

    const flow = {
      version: 1 as const,
      name: "checkout",
      startUrl: "https://example.com",
      steps: [{ action: { action: "wait" as const, ms: 50 } }],
      success: [nested],
    };
    expect(FlowSchema.safeParse(flow).success).toBe(true);
  });

  it("keeps flow verdicts a closed enum agents can switch on", () => {
    for (const v of [
      "drift",
      "ambiguous_anchor",
      "auth_profile_missing",
      "expectation_failed",
      "success_condition_failed",
      "error",
    ]) {
      expect(FlowVerdictSchema.safeParse(v).success).toBe(true);
    }
    expect(FlowVerdictSchema.safeParse("it broke").success).toBe(false);
  });

  it("accepts MCP tool calls and shell commands as executable actions", () => {
    expect(FlowActionSchema.parse({ tool: "argus_flow_heal", args: { name: "x" } })).toEqual({
      tool: "argus_flow_heal",
      args: { name: "x" },
    });
    expect(FlowActionSchema.parse({ tool: "argus_flow_heal" })).toEqual({
      tool: "argus_flow_heal",
      args: {},
    });
    expect(FlowActionSchema.parse({ command: "argus verify https://x" })).toEqual({
      command: "argus verify https://x",
    });
    expect(FlowActionSchema.safeParse({ nope: 1 }).success).toBe(false);
  });

  it("defaults event predicates to step-relative since with a cumulative opt-out", () => {
    for (const p of [
      { kind: "network", urlIncludes: "/api" },
      { kind: "console-clean" },
      { kind: "stream", urlIncludes: "/ws" },
      { kind: "signal", name: "ready" },
    ]) {
      const parsed = PredicateSchema.parse(p) as { since: number; cumulative: boolean };
      expect(parsed.since).toBe(0);
      expect(parsed.cumulative).toBe(false);
    }
    const cumulative = PredicateSchema.parse({ kind: "network", urlIncludes: "/api", cumulative: true }) as {
      cumulative: boolean;
    };
    expect(cumulative.cumulative).toBe(true);
  });

  it("builds typed API errors from the catalogue, failing closed on unknown codes", () => {
    expect(apiError("bad_request", "detail here")).toEqual({
      error: "bad_request",
      detail: "detail here",
      retryable: false,
      remediation: "fix the request body against the schema hint in detail, then retry",
    });
    expect(apiError("fleet_saturated")).toMatchObject({ error: "fleet_saturated", retryable: true });
    expect(apiError("fleet_saturated").remediation).toContain("retry");
    // Unknown codes stay machine-readable but never claim retryability.
    expect(apiError("something_new")).toEqual({ error: "something_new", retryable: false });
    expect(ApiErrorSchema.parse(apiError("unauthorized")).retryable).toBe(false);
    // Callers can override when they know better.
    expect(apiError("bad_request", undefined, { retryable: true }).retryable).toBe(true);
  });

  it("keeps actor tags short free-form attribution", () => {
    expect(ActorSchema.safeParse("agent:explorer-3").success).toBe(true);
    expect(ActorSchema.safeParse("x".repeat(81)).success).toBe(false);
  });
});
