import { describe, expect, it, vi } from "vitest";
import type { SessionInfo, Tenant } from "@argus/shared";
import { Coordinator } from "./coordinator";

/** In-memory DurableObjectState: just the storage surface the Coordinator uses. */
function fakeCtx() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));
  return {
    data,
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
    storage: {
      get: async (k: string) => clone(data.get(k)),
      put: async (k: string, v: unknown) => void data.set(k, clone(v)),
      delete: async (k: string) => data.delete(k),
      list: async ({ prefix }: { prefix: string }) =>
        new Map([...data].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, clone(v)])),
      getAlarm: async () => alarm,
      setAlarm: async (t: number) => void (alarm = t),
      deleteAlarm: async () => void (alarm = null),
    },
  };
}

function setup(tenants: Record<string, Partial<Tenant>> = {}) {
  const ctx = fakeCtx();
  const registry: Record<string, Tenant> = {};
  for (const [id, t] of Object.entries(tenants)) {
    registry[id] = { id, name: id, reserved: 0, maxBurst: 4, createdAt: "", disabled: false, ...t };
  }
  ctx.data.set("tenants", registry);
  const coord = new Coordinator(ctx as never, { ARGUS_MAX_SESSIONS: "4", ARGUS_MAX_WARM: "4" } as never);
  const call = async (path: string, body?: unknown) => {
    const res = await coord.fetch(
      new Request(`https://do${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) })
    );
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  const lease = (sessionId: string, tenantId: string, extra: Partial<SessionInfo> = {}) =>
    call("/acquire", {
      sessionId,
      tenantId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      released: false,
      ...extra,
    } satisfies SessionInfo);
  return { ctx, call, lease };
}

describe("Coordinator admission", () => {
  it("refuses a tenant missing from the registry instead of granting the admin quota", async () => {
    const { lease } = setup({ team: {} });
    // A deleted tenant's token survives up to 60s in isolate caches.
    const r = await lease("s-1", "deleted-team");
    expect(r.status).toBe(429);
    expect(r.data["error"]).toBe("tenant_disabled");
    expect((await lease("s-2", "_admin")).status).toBe(200);
  });

  it("counts batch slots against the tenant's burst ceiling like leases", async () => {
    const { lease } = setup({ team: { maxBurst: 2 } });
    expect((await lease("s-1", "team")).status).toBe(200);
    expect((await lease("b-1", "team", { kind: "batch" })).status).toBe(200);
    const third = await lease("b-2", "team", { kind: "batch" });
    expect(third.status).toBe(429);
    expect(third.data["error"]).toBe("tenant_burst_reached");
  });

  it("never treats a batch slot as an addressable session", async () => {
    const { call, lease } = setup({ team: {} });
    await lease("b-1", "team", { kind: "batch" });
    await lease("s-1", "team");
    expect((await call("/owns", { sessionId: "b-1", tenantId: "team" })).data["owns"]).toBe(false);
    expect((await call("/owns", { sessionId: "s-1", tenantId: "team" })).data["owns"]).toBe(true);
    const listed = (await call("/list")).data;
    expect((listed["sessions"] as SessionInfo[]).map((s) => s.sessionId)).toEqual(["s-1"]);
    expect(listed["batch"]).toBe(1);
  });

  it("does not let a disabled tenant's reservation withhold burst capacity", async () => {
    const { lease } = setup({ idle: { reserved: 3, disabled: true }, team: { maxBurst: 4 } });
    for (let i = 0; i < 4; i++) expect((await lease(`s-${i}`, "team")).status).toBe(200);
  });

  it("counts a release once, however many times it arrives", async () => {
    const { call, lease } = setup({ team: {} });
    await lease("s-1", "team");
    await call("/release", { sessionId: "s-1" });
    await call("/release", { sessionId: "s-1" });
    const stats = (await call("/stats")).data["cumulative"] as Record<string, number>;
    expect(stats["acquires"]).toBe(1);
    expect(stats["releases"]).toBe(1);
  });
});

describe("Coordinator tenants", () => {
  it("holds even a reserved floor to the physical cap", async () => {
    const { call, lease } = setup({ team: { reserved: 0, maxBurst: 4 } });
    // Bursting leaves room for existing floors (see above)…
    for (let i = 0; i < 4; i++) expect((await lease(`a-${i}`, "_admin")).status).toBe(200);
    // …but a floor raised while the fleet is full can't be honoured past the cap.
    expect((await call("/tenant-update", { id: "team", patch: { reserved: 2 } })).status).toBe(200);
    const r = await lease("t-1", "team");
    expect(r.status).toBe(429);
    expect(r.data["error"]).toBe("fleet_saturated");
  });

  it("rotates a self-serve token only for the account that owns the tenant", async () => {
    const { call, ctx } = setup({ u_abc: { name: "a@x.dev", ownerUserId: "user-1" } });
    const other = await call("/tenant-set-token", { id: "u_abc", tokenHash: "h2", ownerUserId: "user-2", ownerName: "b@x.dev" });
    expect(other.status).toBe(409);
    expect(JSON.stringify(other.data)).toContain("tenant_owner_mismatch");
    expect(ctx.data.has("tok:h2")).toBe(false);
    expect((await call("/tenant-set-token", { id: "u_abc", tokenHash: "h3", ownerUserId: "user-1" })).status).toBe(200);
  });

  it("backfills the owner of a legacy tenant from its matching email", async () => {
    const { call, ctx } = setup({ u_old: { name: "a@x.dev" } });
    const r = await call("/tenant-set-token", { id: "u_old", tokenHash: "h", ownerUserId: "user-1", ownerName: "a@x.dev" });
    expect(r.status).toBe(200);
    expect((ctx.data.get("tenants") as Record<string, Tenant>)["u_old"]?.ownerUserId).toBe("user-1");
    const stranger = await call("/tenant-set-token", { id: "u_old", tokenHash: "h9", ownerUserId: "user-9", ownerName: "a@x.dev" });
    expect(stranger.status).toBe(409);
  });

  it("rejects an update that puts the ceiling under the floor", async () => {
    const { call } = setup({ team: { reserved: 2, maxBurst: 4 } });
    expect((await call("/tenant-update", { id: "team", patch: { maxBurst: 1 } })).status).toBe(409);
    expect((await call("/tenant-update", { id: "team", patch: { maxBurst: 2 } })).status).toBe(200);
  });

  it("ends a deleted tenant's live sessions", async () => {
    const ctx = fakeCtx();
    ctx.data.set("tenants", { team: { id: "team", name: "team", reserved: 0, maxBurst: 4, createdAt: "", disabled: false } });
    const released: string[] = [];
    const env = {
      ARGUS_MAX_SESSIONS: "4",
      BROWSER_SESSION: {
        idFromName: (n: string) => n,
        get: (n: string) => ({ fetch: async () => (released.push(n), new Response("{}")) }),
      },
    };
    const coord = new Coordinator(ctx as never, env as never);
    const post = (path: string, body: unknown) =>
      coord.fetch(new Request(`https://do${path}`, { method: "POST", body: JSON.stringify(body) }));
    const at = { createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), released: false };
    await post("/acquire", { sessionId: "s-1", tenantId: "team", ...at });
    await post("/acquire", { sessionId: "b-1", tenantId: "team", kind: "batch", ...at });
    const res = await post("/tenant-delete", { id: "team" });
    expect(((await res.json()) as Record<string, unknown>)["sessionsEnded"]).toBe(1);
    expect(released).toEqual(["s-1"]);
  });
});

describe("Coordinator warm pool", () => {
  it("hands out the freshest live browser and drops ones past keep_alive", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const { call, lease, ctx } = setup({ team: {} });
      await call("/release", { sessionId: "x", warmSessionId: "old" });
      vi.setSystemTime(300_000);
      await call("/release", { sessionId: "y", warmSessionId: "mid" });
      await call("/release", { sessionId: "z", warmSessionId: "new" });
      // 10 min after "old" was parked its Chromium is gone.
      vi.setSystemTime(600_000);
      expect((await call("/stats")).data["warm"]).toBe(2);
      expect((await lease("s-1", "team")).data["warmSessionId"]).toBe("new");
      expect((await lease("s-2", "team")).data["warmSessionId"]).toBe("mid");
      expect((await lease("s-3", "team")).data["warmSessionId"]).toBeUndefined();
      expect(ctx.data.get("warm")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats legacy bare-id entries as stale", async () => {
    const { lease, ctx } = setup({ team: {} });
    ctx.data.set("warm", ["legacy-1", "legacy-2"]);
    expect((await lease("s-1", "team")).data["warmSessionId"]).toBeUndefined();
  });
});
