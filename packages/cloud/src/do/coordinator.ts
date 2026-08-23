/**
 * Coordinator — singleton DO: concurrency cap + fleet tracking + warm pool +
 * multi-tenant fair admission.
 *
 * Scale: the paid Browser Rendering account allows ~120 concurrent browsers, so
 * the cap can be large. To keep `/acquire` cheap at that scale, active sessions
 * are counted with maintained keys (O(#tenants) per acquire) rather than a
 * storage.list scan on every call; a periodic alarm reconciles those counts
 * against the real session records and prunes expired leases, so a missed
 * release can never wedge the cap. Launching is the real throughput ceiling
 * (1 new browser/second), so a released session parks its browser here (warm
 * free-list) and the next lease `connect()`s to it (~100-200ms) instead of
 * cold-launching.
 *
 * Multi-tenant: many projects share one fleet. Each tenant has a RESERVED floor
 * (browsers it can always get) and a burst CEILING. Admission honours every
 * tenant's floor before anyone bursts into shared headroom, so a greedy project
 * can never starve a reserved one. The warm pool and launch limiter stay GLOBAL
 * (a parked Chromium is tenant-agnostic; the launch rate is a physical limit).
 *
 * Concurrency: `count`, `tcounts`, `warm`, `lastLaunchAt` and `stats` are single
 * keys mutated only inside blockConcurrencyWhile, so parallel acquires can't
 * double-count or hand the same warm browser to two leases.
 */
import { DurableObject } from "cloudflare:workers";
import type {
  SessionInfo,
  Tenant,
  TenantUsage,
  CapacityStats,
} from "@argus/shared";
import type { Env } from "../env";

const WARM_KEY = "warm";
const COUNT_KEY = "count";
const TCOUNTS_KEY = "tcounts"; // Record<tenantId, number> — per-tenant active count
const TENANTS_KEY = "tenants"; // Record<tenantId, Tenant> — the registry
const STATS_KEY = "stats";
const RECONCILE_MS = 60_000;
// The default/admin tenant: legacy single-token usage and the admin token all
// resolve here. It has no reserved floor and may use the whole cap.
const ADMIN_TENANT = "_admin";
// CF paid allows 1 new browser/second. Serialize cold launches to just under that
// (a little margin for jitter) so a burst QUEUES instead of failing on the rate limit.
const LAUNCH_INTERVAL_MS = 1_200;
// Beyond this queued wait the burst is too deep — refuse the token so the caller
// backpressures (429) rather than holding a request open for a minute.
const MAX_LAUNCH_WAIT_MS = 30_000;

interface Stats {
  acquires: number;
  rejects: number;
  launches: number;
  releases: number;
  since: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

export class Coordinator extends DurableObject<Env> {
  private maxSessions(): number {
    return Number(this.env.ARGUS_MAX_SESSIONS ?? 8);
  }
  private maxWarm(): number {
    return Number(this.env.ARGUS_MAX_WARM ?? 12);
  }

  private async tenants(): Promise<Record<string, Tenant>> {
    return (await this.ctx.storage.get<Record<string, Tenant>>(TENANTS_KEY)) ?? {};
  }

  /** A tenant's quota — the registry record, or the admin default for `_admin`. */
  private quotaFor(id: string, tenants: Record<string, Tenant>): { reserved: number; maxBurst: number; disabled: boolean } {
    if (id === ADMIN_TENANT || !tenants[id]) {
      return { reserved: 0, maxBurst: this.maxSessions(), disabled: false };
    }
    const t = tenants[id];
    return { reserved: t.reserved, maxBurst: t.maxBurst, disabled: t.disabled };
  }

  private async stats(): Promise<Stats> {
    return (
      (await this.ctx.storage.get<Stats>(STATS_KEY)) ?? {
        acquires: 0,
        rejects: 0,
        launches: 0,
        releases: 0,
        since: new Date().toISOString(),
      }
    );
  }
  private async bumpStat(key: keyof Omit<Stats, "since">, by = 1): Promise<void> {
    const s = await this.stats();
    s[key] += by;
    await this.ctx.storage.put(STATS_KEY, s);
  }

  /** Live active count, seeded once from the session records for a clean migration. */
  private async liveCount(): Promise<number> {
    const stored = await this.ctx.storage.get<number>(COUNT_KEY);
    if (typeof stored === "number") return stored;
    return await this.reconcile();
  }

  private async tcounts(): Promise<Record<string, number>> {
    return (await this.ctx.storage.get<Record<string, number>>(TCOUNTS_KEY)) ?? {};
  }

  /**
   * Prune expired/released session records and resync `count` + per-tenant
   * counts to the truth. Self-heals any drift from a missed release.
   */
  private async reconcile(): Promise<number> {
    const all = await this.ctx.storage.list<SessionInfo>({ prefix: "session:" });
    const now = Date.now();
    let live = 0;
    const tcounts: Record<string, number> = {};
    for (const [key, s] of all) {
      if (s.released || new Date(s.expiresAt).getTime() < now) {
        await this.ctx.storage.delete(key);
      } else {
        live++;
        const id = s.tenantId ?? ADMIN_TENANT;
        tcounts[id] = (tcounts[id] ?? 0) + 1;
      }
    }
    await this.ctx.storage.put(COUNT_KEY, live);
    await this.ctx.storage.put(TCOUNTS_KEY, tcounts);
    return live;
  }

  async alarm(): Promise<void> {
    const live = await this.reconcile();
    // Keep reconciling while anything is out; go quiet when idle.
    if (live > 0) await this.ctx.storage.setAlarm(Date.now() + RECONCILE_MS);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const body =
      request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};

    if (path === "/acquire") return await this.acquire(body as unknown as SessionInfo);
    if (path === "/release") return await this.releaseSession(body);
    if (path === "/list") return await this.list(url.searchParams.get("tenantId") ?? undefined);
    if (path === "/owns") return await this.owns(body);
    if (path === "/stats") return json(await this.buildStats());
    if (path === "/launch-token") return await this.launchToken();
    if (path === "/warm-acquire") return await this.warmAcquire();
    if (path === "/warm-release") return await this.warmRelease(body);
    // Tenant registry (admin-gated at the Worker before it reaches here).
    if (path === "/resolve-token") return await this.resolveToken(body);
    if (path === "/tenant-create") return await this.tenantCreate(body);
    if (path === "/tenant-list") return json({ tenants: await this.tenantUsage() });
    if (path === "/tenant-update") return await this.tenantUpdate(body);
    if (path === "/tenant-delete") return await this.tenantDelete(body);

    return json({ error: "unknown coordinator command" }, 404);
  }

  // -------------------------------------------------------------------------
  // Admission — fair per-tenant capping
  // -------------------------------------------------------------------------

  private async acquire(info: SessionInfo): Promise<Response> {
    const cap = this.maxSessions();
    const id = info.tenantId ?? ADMIN_TENANT;
    let verdict: { ok: boolean; active: number; warmSessionId?: string; reason?: string } = {
      ok: false,
      active: -1,
    };
    await this.ctx.blockConcurrencyWhile(async () => {
      const tenants = await this.tenants();
      const quota = this.quotaFor(id, tenants);
      if (quota.disabled) {
        verdict = { ok: false, active: 0, reason: "tenant_disabled" };
        return;
      }
      const global = await this.liveCount();
      const tcounts = await this.tcounts();
      const mine = tcounts[id] ?? 0;

      if (mine >= quota.maxBurst) {
        verdict = { ok: false, active: mine, reason: "tenant_burst_reached" };
        return;
      }
      // A tenant below its reserved floor is always admitted: Σreserved ≤ cap is
      // enforced at registration, so its guaranteed slots are physically free.
      const usingGuarantee = mine < quota.reserved;
      if (!usingGuarantee) {
        // Bursting: only take capacity that isn't promised to other tenants'
        // still-unused reservations. reject if the fleet is saturated once every
        // floor is honoured.
        let unusedReservations = 0;
        for (const [tid, t] of Object.entries(tenants)) {
          const used = tcounts[tid] ?? 0;
          if (t.reserved > used) unusedReservations += t.reserved - used;
        }
        if (global + unusedReservations >= cap) {
          verdict = { ok: false, active: global, reason: "fleet_saturated" };
          return;
        }
      }

      // Admit.
      await this.ctx.storage.put(`session:${info.sessionId}`, info);
      tcounts[id] = mine + 1;
      await this.ctx.storage.put(TCOUNTS_KEY, tcounts);
      await this.ctx.storage.put(COUNT_KEY, global + 1);
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now() + RECONCILE_MS);
      }
      const warm = (await this.ctx.storage.get<string[]>(WARM_KEY)) ?? [];
      const warmSessionId = warm.shift();
      if (warmSessionId !== undefined) await this.ctx.storage.put(WARM_KEY, warm);
      verdict = { ok: true, active: global + 1, warmSessionId };
    });

    if (!verdict.ok) {
      await this.bumpStat("rejects");
      const detail =
        verdict.reason === "tenant_burst_reached"
          ? `tenant at its burst ceiling (${verdict.active} browsers) — release one or raise maxBurst`
          : verdict.reason === "tenant_disabled"
            ? "tenant is disabled"
            : `fleet saturated (${verdict.active}/${cap}) after honouring every tenant's reserved floor — retry shortly`;
      return json({ error: verdict.reason ?? "session_cap_reached", detail }, 429);
    }
    await this.bumpStat("acquires");
    return json({ ok: true, active: verdict.active, max: cap, warmSessionId: verdict.warmSessionId });
  }

  private async releaseSession(body: Record<string, unknown>): Promise<Response> {
    const { sessionId, warmSessionId } = body as { sessionId: string; warmSessionId?: string };
    let parked = false;
    await this.ctx.blockConcurrencyWhile(async () => {
      const rec = await this.ctx.storage.get<SessionInfo>(`session:${sessionId}`);
      await this.ctx.storage.delete(`session:${sessionId}`);
      if (rec) {
        const count = (await this.ctx.storage.get<number>(COUNT_KEY)) ?? 1;
        await this.ctx.storage.put(COUNT_KEY, Math.max(0, count - 1));
        const id = rec.tenantId ?? ADMIN_TENANT;
        const tcounts = await this.tcounts();
        tcounts[id] = Math.max(0, (tcounts[id] ?? 1) - 1);
        await this.ctx.storage.put(TCOUNTS_KEY, tcounts);
      }
      parked = await this.parkWarm(warmSessionId);
    });
    await this.bumpStat("releases");
    return json({ ok: true, parked });
  }

  private async list(tenantId?: string): Promise<Response> {
    const all = await this.ctx.storage.list<SessionInfo>({ prefix: "session:" });
    const now = Date.now();
    const list = [...all.values()].filter(
      (s) =>
        !s.released &&
        new Date(s.expiresAt).getTime() > now &&
        (!tenantId || (s.tenantId ?? ADMIN_TENANT) === tenantId)
    );
    const warm = (await this.ctx.storage.get<string[]>(WARM_KEY)) ?? [];
    return json({ sessions: list, warm: warm.length, max: this.maxSessions() });
  }

  private async owns(body: Record<string, unknown>): Promise<Response> {
    const { sessionId, tenantId, admin } = body as {
      sessionId?: string;
      tenantId?: string;
      admin?: boolean;
    };
    if (!sessionId || !tenantId) return json({ owns: false });
    const session = await this.ctx.storage.get<SessionInfo>(`session:${sessionId}`);
    return json({
      owns:
        Boolean(session) &&
        !session?.released &&
        (admin === true || (session?.tenantId ?? ADMIN_TENANT) === tenantId),
    });
  }

  // -------------------------------------------------------------------------
  // Launch limiter — hand out cold-launch slots at <=1/sec so a burst of leases
  // that all miss the warm pool completes (staggered) instead of failing on CF's
  // 1-new-browser-per-second cap. Each caller reserves the next slot and waits it out.
  // -------------------------------------------------------------------------

  private async launchToken(): Promise<Response> {
    let waitMs: number | null = 0;
    await this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const last = (await this.ctx.storage.get<number>("lastLaunchAt")) ?? 0;
      const slot = Math.max(now, last + LAUNCH_INTERVAL_MS);
      if (slot - now > MAX_LAUNCH_WAIT_MS) {
        waitMs = null; // too congested — tell the caller to back off
        return;
      }
      await this.ctx.storage.put("lastLaunchAt", slot);
      waitMs = slot - now;
    });
    if (waitMs !== null) await this.bumpStat("launches");
    return json({ waitMs });
  }

  private async warmAcquire(): Promise<Response> {
    let warmSessionId: string | undefined;
    await this.ctx.blockConcurrencyWhile(async () => {
      const warm = (await this.ctx.storage.get<string[]>(WARM_KEY)) ?? [];
      warmSessionId = warm.shift();
      if (warmSessionId !== undefined) await this.ctx.storage.put(WARM_KEY, warm);
    });
    return json({ warmSessionId });
  }

  private async warmRelease(body: Record<string, unknown>): Promise<Response> {
    const { warmSessionId } = body as { warmSessionId?: string };
    let parked = false;
    await this.ctx.blockConcurrencyWhile(async () => {
      parked = await this.parkWarm(warmSessionId);
    });
    return json({ parked });
  }

  // -------------------------------------------------------------------------
  // Tenant registry
  // -------------------------------------------------------------------------

  private async resolveToken(body: Record<string, unknown>): Promise<Response> {
    const { hash } = body as { hash: string };
    const id = await this.ctx.storage.get<string>(`tok:${hash}`);
    if (!id) return json({ tenant: null });
    const tenants = await this.tenants();
    const t = tenants[id];
    if (!t || t.disabled) return json({ tenant: null });
    return json({ tenant: t });
  }

  private async tenantCreate(body: Record<string, unknown>): Promise<Response> {
    const { id, name, reserved, maxBurst, tokenHash } = body as {
      id: string;
      name?: string;
      reserved: number;
      maxBurst: number;
      tokenHash: string;
    };
    let result: { ok: boolean; tenant?: Tenant; error?: string } = { ok: false };
    await this.ctx.blockConcurrencyWhile(async () => {
      const tenants = await this.tenants();
      if (tenants[id]) {
        result = { ok: false, error: "tenant already exists" };
        return;
      }
      // Enforce Σreserved ≤ cap so every floor stays physically satisfiable.
      const reservedTotal =
        Object.values(tenants).reduce((n, t) => n + t.reserved, 0) + reserved;
      if (reservedTotal > this.maxSessions()) {
        result = {
          ok: false,
          error: `reserved total ${reservedTotal} would exceed cap ${this.maxSessions()}`,
        };
        return;
      }
      const tenant: Tenant = {
        id,
        name: name ?? id,
        reserved,
        maxBurst,
        createdAt: new Date().toISOString(),
        disabled: false,
      };
      tenants[id] = tenant;
      await this.ctx.storage.put(TENANTS_KEY, tenants);
      await this.ctx.storage.put(`tok:${tokenHash}`, id);
      await this.ctx.storage.put(`tenanttok:${id}`, tokenHash); // reverse, for delete
      result = { ok: true, tenant };
    });
    if (!result.ok) return json({ error: "tenant_create_failed", detail: result.error }, 409);
    return json({ tenant: result.tenant });
  }

  private async tenantUpdate(body: Record<string, unknown>): Promise<Response> {
    const { id, patch } = body as {
      id: string;
      patch: Partial<Pick<Tenant, "name" | "reserved" | "maxBurst" | "disabled">>;
    };
    let result: { ok: boolean; tenant?: Tenant; error?: string } = { ok: false };
    await this.ctx.blockConcurrencyWhile(async () => {
      const tenants = await this.tenants();
      const t = tenants[id];
      if (!t) {
        result = { ok: false, error: "no such tenant" };
        return;
      }
      const next: Tenant = { ...t, ...patch };
      if (patch.reserved !== undefined) {
        const reservedTotal =
          Object.values(tenants).reduce((n, o) => n + (o.id === id ? 0 : o.reserved), 0) +
          next.reserved;
        if (reservedTotal > this.maxSessions()) {
          result = {
            ok: false,
            error: `reserved total ${reservedTotal} would exceed cap ${this.maxSessions()}`,
          };
          return;
        }
      }
      tenants[id] = next;
      await this.ctx.storage.put(TENANTS_KEY, tenants);
      result = { ok: true, tenant: next };
    });
    if (!result.ok) return json({ error: "tenant_update_failed", detail: result.error }, 409);
    return json({ tenant: result.tenant });
  }

  private async tenantDelete(body: Record<string, unknown>): Promise<Response> {
    const { id } = body as { id: string };
    await this.ctx.blockConcurrencyWhile(async () => {
      const tenants = await this.tenants();
      delete tenants[id];
      await this.ctx.storage.put(TENANTS_KEY, tenants);
      const hash = await this.ctx.storage.get<string>(`tenanttok:${id}`);
      if (hash) {
        await this.ctx.storage.delete(`tok:${hash}`);
        await this.ctx.storage.delete(`tenanttok:${id}`);
      }
    });
    return json({ ok: true });
  }

  private async tenantUsage(): Promise<TenantUsage[]> {
    const tenants = await this.tenants();
    const tcounts = await this.tcounts();
    return Object.values(tenants).map((t) => ({
      id: t.id,
      name: t.name,
      active: tcounts[t.id] ?? 0,
      reserved: t.reserved,
      maxBurst: t.maxBurst,
      disabled: t.disabled,
    }));
  }

  private async buildStats(): Promise<CapacityStats> {
    const active = await this.liveCount();
    const warm = (await this.ctx.storage.get<string[]>(WARM_KEY)) ?? [];
    const last = (await this.ctx.storage.get<number>("lastLaunchAt")) ?? 0;
    const stats = await this.stats();
    const tenants = await this.tenants();
    const tenantList = await this.tenantUsage();
    const adminActive = (await this.tcounts())[ADMIN_TENANT] ?? 0;
    // Surface the admin/default tenant too when it holds leases, so the board
    // accounts for every browser.
    if (adminActive > 0) {
      tenantList.unshift({
        id: ADMIN_TENANT,
        name: "admin / default",
        active: adminActive,
        reserved: 0,
        maxBurst: this.maxSessions(),
        disabled: false,
      });
    }
    return {
      active,
      cap: this.maxSessions(),
      warm: warm.length,
      warmCap: this.maxWarm(),
      launchQueueMs: Math.max(0, last - Date.now()),
      reservedTotal: Object.values(tenants).reduce((n, t) => n + t.reserved, 0),
      cumulative: {
        acquires: stats.acquires,
        rejects: stats.rejects,
        launches: stats.launches,
        releases: stats.releases,
      },
      since: stats.since,
      tenants: tenantList,
    };
  }

  /**
   * Park a browser for reuse, capped at ARGUS_MAX_WARM (NOT the concurrency cap)
   * so a large cap can't leave a large pool of idle browsers billing. A browser
   * not parked here is closed by the caller, so it can't leak toward the account
   * cap. Must run inside a blockConcurrencyWhile gate.
   */
  private async parkWarm(warmSessionId: string | undefined): Promise<boolean> {
    if (!warmSessionId) return false;
    const warm = (await this.ctx.storage.get<string[]>(WARM_KEY)) ?? [];
    if (warm.includes(warmSessionId) || warm.length >= this.maxWarm()) return false;
    warm.push(warmSessionId);
    await this.ctx.storage.put(WARM_KEY, warm);
    return true;
  }
}
