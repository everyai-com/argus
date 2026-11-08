/**
 * Coordinator — singleton DO: concurrency cap + fleet tracking + warm pool +
 * multi-tenant fair admission.
 *
 * Scale: the paid account allows 200 concurrent browsers (Browser Run limits,
 * Sep-2026), so
 * the cap can be large. To keep `/acquire` cheap at that scale, active sessions
 * are counted with maintained keys (O(#tenants) per acquire) rather than a
 * storage.list scan on every call; a periodic alarm reconciles those counts
 * against the real session records and prunes expired leases, so a missed
 * release can never wedge the cap. Launching is the real throughput ceiling
 * (3 new browsers/second), so a released session parks its browser here (warm
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
import { apiError } from "@argus/shared";
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
// CF paid allows 3 new browsers/second (Browser Run limits, Sep-2026).
// Serialize cold launches to just under that (a little margin for jitter) so a
// burst QUEUES instead of failing on the rate limit.
const LAUNCH_INTERVAL_MS = 400;
// Beyond this queued wait the burst is too deep — refuse the token so the caller
// backpressures (429) rather than holding a request open for a minute.
const MAX_LAUNCH_WAIT_MS = 30_000;
// A parked Chromium dies once its 10-min keep_alive lapses with nobody
// connected. Handing out a dead id costs the borrower a failed connect AND a
// cold launch (observed live: 21 leases on a "13 warm" pool cost 20 launches),
// so entries are dropped a minute before that.
const WARM_MAX_AGE_MS = 540_000;

/** A parked browser and when it was parked. Legacy entries were bare ids. */
interface WarmEntry {
  id: string;
  at: number;
}

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
    if (id === ADMIN_TENANT) {
      return { reserved: 0, maxBurst: this.maxSessions(), disabled: false };
    }
    // Not in the registry = deleted (its token can live on in isolate caches for
    // up to 60s). Refuse — never fall through to the admin's whole-cap quota.
    if (!tenants[id]) return { reserved: 0, maxBurst: 0, disabled: true };
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
    if (path === "/tenant-set-token") return await this.tenantSetToken(body);
    // Platform job idempotency. A single DO serializes competing provider
    // webhooks so duplicate deployment_status deliveries cannot launch two
    // expensive browser suites for the same SHA/target.
    if (path === "/platform-run-claim") return await this.platformRunClaim(body);
    if (path === "/platform-run-complete") return await this.platformRunComplete(body);

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
      // The cap is physical (Browser Run account concurrency), so it binds even a
      // floor. Floors are normally free because bursting leaves room for them;
      // this only bites transiently, e.g. right after a floor is raised while the
      // fleet is busy — and clears as bursters release.
      if (usingGuarantee && global >= cap) {
        verdict = { ok: false, active: global, reason: "fleet_saturated" };
        return;
      }
      if (!usingGuarantee) {
        // Bursting: only take capacity that isn't promised to other tenants'
        // still-unused reservations. reject if the fleet is saturated once every
        // floor is honoured.
        let unusedReservations = 0;
        for (const [tid, t] of Object.entries(tenants)) {
          // A disabled tenant can't use its floor, and a floor above maxBurst is
          // unreachable — neither may hold slots back from everyone else.
          if (t.disabled) continue;
          const floor = Math.min(t.reserved, t.maxBurst);
          const used = tcounts[tid] ?? 0;
          if (floor > used) unusedReservations += floor - used;
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
      const warmSessionId = await this.takeWarm();
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
      return json(apiError(verdict.reason ?? "session_cap_reached", detail), 429);
    }
    await this.bumpStat("acquires");
    return json({ ok: true, active: verdict.active, max: cap, warmSessionId: verdict.warmSessionId });
  }

  private async releaseSession(body: Record<string, unknown>): Promise<Response> {
    const { sessionId, warmSessionId } = body as { sessionId: string; warmSessionId?: string };
    let parked = false;
    let existed = false;
    await this.ctx.blockConcurrencyWhile(async () => {
      const rec = await this.ctx.storage.get<SessionInfo>(`session:${sessionId}`);
      existed = rec !== undefined;
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
    // A repeat release (DELETE after the alarm, a retried DELETE) frees nothing.
    if (existed) await this.bumpStat("releases");
    return json({ ok: true, parked });
  }

  private async list(tenantId?: string): Promise<Response> {
    const all = await this.ctx.storage.list<SessionInfo>({ prefix: "session:" });
    const now = Date.now();
    const live = [...all.values()].filter(
      (s) =>
        !s.released &&
        new Date(s.expiresAt).getTime() > now &&
        (!tenantId || (s.tenantId ?? ADMIN_TENANT) === tenantId)
    );
    // Batch slots hold capacity but aren't addressable — list them as a count,
    // not as sessions an agent would try (and fail) to drive.
    const list = live.filter((s) => s.kind !== "batch");
    const warm = await this.warmEntries();
    return json({ sessions: list, batch: live.length - list.length, warm: warm.length, max: this.maxSessions() });
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
        session?.kind !== "batch" &&
        new Date(session?.expiresAt ?? 0).getTime() > Date.now() &&
        (admin === true || (session?.tenantId ?? ADMIN_TENANT) === tenantId),
    });
  }

  // -------------------------------------------------------------------------
  // Launch limiter — hand out cold-launch slots at <=3/sec so a burst of leases
  // that all miss the warm pool completes (staggered) instead of failing on CF's
  // 3-new-browsers-per-second cap. Each caller reserves the next slot and waits it out.
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
      warmSessionId = await this.takeWarm();
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

  private async platformRunClaim(body: Record<string, unknown>): Promise<Response> {
    const { key, force } = body as { key?: string; force?: boolean };
    if (!key || key.length > 300) return json({ claimed: false, error: "invalid key" }, 400);
    let claimed = false;
    await this.ctx.blockConcurrencyWhile(async () => {
      const storageKey = `platform-run:${key}`;
      const existing = await this.ctx.storage.get<{ expiresAt: number }>(storageKey);
      if (!force && existing && existing.expiresAt > Date.now()) return;
      await this.ctx.storage.put(storageKey, {
        status: "running",
        startedAt: new Date().toISOString(),
        expiresAt: Date.now() + 15 * 60_000,
      });
      claimed = true;
    });
    return json({ claimed });
  }

  private async platformRunComplete(body: Record<string, unknown>): Promise<Response> {
    const { key, conclusion } = body as { key?: string; conclusion?: string };
    if (!key || key.length > 300) return json({ ok: false, error: "invalid key" }, 400);
    await this.ctx.storage.put(`platform-run:${key}`, {
      status: "completed",
      conclusion: String(conclusion ?? "unknown").slice(0, 40),
      completedAt: new Date().toISOString(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60_000,
    });
    return json({ ok: true });
  }

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
    const { id, name, reserved, maxBurst, tokenHash, ownerUserId } = body as {
      id: string;
      name?: string;
      reserved: number;
      maxBurst: number;
      tokenHash: string;
      ownerUserId?: string;
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
        ...(ownerUserId ? { ownerUserId } : {}),
      };
      tenants[id] = tenant;
      await this.ctx.storage.put(TENANTS_KEY, tenants);
      await this.ctx.storage.put(`tok:${tokenHash}`, id);
      await this.ctx.storage.put(`tenanttok:${id}`, tokenHash); // reverse, for delete
      result = { ok: true, tenant };
    });
    if (!result.ok) return json(apiError("tenant_create_failed", result.error), 409);
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
      if (next.maxBurst < next.reserved) {
        result = { ok: false, error: `maxBurst ${next.maxBurst} must be ≥ reserved ${next.reserved}` };
        return;
      }
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
    if (!result.ok) return json(apiError("tenant_update_failed", result.error), 409);
    return json({ tenant: result.tenant });
  }

  /** Point an existing tenant at a new token hash (rotation). */
  private async tenantSetToken(body: Record<string, unknown>): Promise<Response> {
    const { id, tokenHash, ownerUserId, ownerName } = body as {
      id: string;
      tokenHash: string;
      ownerUserId?: string;
      ownerName?: string;
    };
    let result: { ok: boolean; error?: string } = { ok: false };
    await this.ctx.blockConcurrencyWhile(async () => {
      const tenants = await this.tenants();
      const t = tenants[id];
      if (!t) {
        result = { ok: false, error: "no such tenant" };
        return;
      }
      // Self-serve ids are derived from a prefix of the user id: a different
      // account landing on the same id must never be handed this tenant's token.
      if (ownerUserId) {
        const owner = t.ownerUserId;
        const legacyMatch = owner === undefined && ownerName !== undefined && t.name === ownerName;
        if (owner !== ownerUserId && !legacyMatch) {
          result = { ok: false, error: "tenant_owner_mismatch" };
          return;
        }
        if (owner === undefined) {
          tenants[id] = { ...t, ownerUserId }; // backfill legacy self-serve tenants
          await this.ctx.storage.put(TENANTS_KEY, tenants);
        }
      }
      const previous = await this.ctx.storage.get<string>(`tenanttok:${id}`);
      if (previous) await this.ctx.storage.delete(`tok:${previous}`);
      await this.ctx.storage.put(`tok:${tokenHash}`, id);
      await this.ctx.storage.put(`tenanttok:${id}`, tokenHash);
      result = { ok: true };
    });
    if (!result.ok) return json(apiError("tenant_token_failed", result.error), 409);
    return json({ ok: true });
  }

  private async tenantDelete(body: Record<string, unknown>): Promise<Response> {
    const { id } = body as { id: string };
    let live: SessionInfo[] = [];
    await this.ctx.blockConcurrencyWhile(async () => {
      const all = await this.ctx.storage.list<SessionInfo>({ prefix: "session:" });
      live = [...all.values()].filter((s) => (s.tenantId ?? ADMIN_TENANT) === id && s.kind !== "batch");
      const tenants = await this.tenants();
      delete tenants[id];
      await this.ctx.storage.put(TENANTS_KEY, tenants);
      const hash = await this.ctx.storage.get<string>(`tenanttok:${id}`);
      if (hash) {
        await this.ctx.storage.delete(`tok:${hash}`);
        await this.ctx.storage.delete(`tenanttok:${id}`);
      }
    });
    // A deleted tenant keeps no browsers. Each session DO releases itself and
    // calls back into /release, so this must run outside the gate above.
    await Promise.all(
      live.map((s) =>
        this.env.BROWSER_SESSION.get(this.env.BROWSER_SESSION.idFromName(s.sessionId))
          .fetch("https://do/release", { method: "POST" })
          .catch(() => {})
      )
    );
    return json({ ok: true, sessionsEnded: live.length });
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
    const warm = await this.warmEntries();
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
    const warm = await this.warmEntries();
    if (warm.some((w) => w.id === warmSessionId) || warm.length >= this.maxWarm()) return false;
    warm.push({ id: warmSessionId, at: Date.now() });
    await this.ctx.storage.put(WARM_KEY, warm);
    return true;
  }

  /** Parked browsers still inside keep_alive, oldest first. Read-only. */
  private async warmEntries(): Promise<WarmEntry[]> {
    const raw = (await this.ctx.storage.get<Array<WarmEntry | string>>(WARM_KEY)) ?? [];
    const cutoff = Date.now() - WARM_MAX_AGE_MS;
    // Legacy bare ids have no park time — treat them as stale.
    return raw.filter((w): w is WarmEntry => typeof w !== "string" && w.at > cutoff);
  }

  /**
   * Take the most recently parked live browser (the likeliest to still be up),
   * pruning expired entries. Must run inside a blockConcurrencyWhile gate.
   */
  private async takeWarm(): Promise<string | undefined> {
    const warm = await this.warmEntries();
    const taken = warm.pop();
    await this.ctx.storage.put(WARM_KEY, warm);
    return taken?.id;
  }
}
