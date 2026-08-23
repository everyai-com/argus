/**
 * Argus cloud API — Hono worker.
 *
 * Every inbound body is zod-parsed against @argus/shared before it touches
 * logic. Session commands are forwarded to the BrowserSession DO named by
 * the sessionId; the Coordinator DO tracks the fleet, enforces the per-tenant
 * cap, and owns the tenant registry.
 *
 * Auth is multi-tenant: the bearer token resolves to a tenant (the legacy
 * global ARGUS_TOKEN is the admin tenant). Tenant lookups are hashed and
 * cached in-isolate so the hot path doesn't hit the Coordinator every request.
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  AuditRequestSchema,
  CreateTenantRequestSchema,
  FlowSchema,
  LeaseRequestSchema,
  SmokeRequestSchema,
  UpdateTenantRequestSchema,
  type SessionInfo,
} from "@argus/shared";
import type { Env } from "./env";
import { deleteAuthProfile, listAuthProfiles } from "./auth-store";
import { fleetView, listRuns, writeRunMeta } from "./runs";
import { runSmoke } from "./smoke";
import { runAudit } from "./audit";
import { replayFlow, verifyFlows } from "./flows";
import { handleGitHubEvent, verifyGitHubWebhook } from "./github-app";

const ADMIN_TENANT = "_admin";

interface ResolvedTenant {
  id: string;
  name: string;
  reserved: number;
  maxBurst: number;
  admin: boolean;
}

type Vars = { tenant: ResolvedTenant };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// --- tenant auth ------------------------------------------------------------
// The token→tenant map is cached per-isolate so the common case is a hash + a
// Map lookup, not a Coordinator round-trip. Revoking a tenant takes effect
// within TENANT_CACHE_TTL_MS across warm isolates; the admin token is resolved
// with no DO call at all.

const TENANT_CACHE_TTL_MS = 60_000;
const tenantCache = new Map<string, { tenant: ResolvedTenant; exp: number }>();

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function coordinator(env: Env) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName("main"));
}

async function canAccessSession(env: Env, tenant: ResolvedTenant, sessionId: string): Promise<boolean> {
  return coordinator(env)
    .fetch("https://do/owns", {
      method: "POST",
      body: JSON.stringify({ sessionId, tenantId: tenant.id, admin: tenant.admin }),
    })
    .then((r) => r.json<{ owns: boolean }>())
    .then((r) => r.owns)
    .catch(() => false);
}

function adminTenant(env: Env): ResolvedTenant {
  return {
    id: ADMIN_TENANT,
    name: "admin / default",
    reserved: 0,
    maxBurst: Number(env.ARGUS_MAX_SESSIONS ?? 8),
    admin: true,
  };
}

/** Resolve a bearer token to a tenant, or null if unknown. */
async function resolveTenant(env: Env, token: string): Promise<ResolvedTenant | null> {
  const admin = env.ARGUS_TOKEN;
  // Fail closed. Local development should set ARGUS_TOKEN in `.dev.vars` too;
  // an accidentally unconfigured production deployment must never expose
  // browser control, saved sessions, or artifacts to the public internet.
  if (!admin) return null;
  if (token && token === admin) return adminTenant(env);
  if (!token) return null;

  const hash = await sha256Hex(token);
  const cached = tenantCache.get(hash);
  if (cached && cached.exp > Date.now()) return cached.tenant;

  const res = await coordinator(env)
    .fetch("https://do/resolve-token", { method: "POST", body: JSON.stringify({ hash }) })
    .then((r) => r.json<{ tenant: { id: string; name: string; reserved: number; maxBurst: number } | null }>())
    .catch(() => ({ tenant: null }));
  if (!res.tenant) return null;
  const tenant: ResolvedTenant = { ...res.tenant, admin: false };
  tenantCache.set(hash, { tenant, exp: Date.now() + TENANT_CACHE_TTL_MS });
  return tenant;
}

app.use("/v1/*", async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const tenant = await resolveTenant(c.env, token);
  if (!tenant) return c.json({ error: "unauthorized" }, 401);
  c.set("tenant", tenant);
  await next();
});

function requireAdmin(c: { get: (k: "tenant") => ResolvedTenant; json: (b: unknown, s?: number) => Response }) {
  const t = c.get("tenant");
  return t.admin ? null : c.json({ error: "forbidden", detail: "admin token required" }, 403);
}

app.get("/health", (c) => c.json({ ok: true, service: "argus-cloud" }));

// --- GitHub platform -------------------------------------------------------
// This surface is intentionally outside /v1: it authenticates with GitHub's
// webhook HMAC rather than an Argus bearer token. The handler acknowledges
// quickly and performs the browser run in waitUntil.

app.get("/platform/github/status", (c) => {
  const configured = Boolean(
    c.env.ARGUS_GITHUB_APP_ID &&
      c.env.ARGUS_GITHUB_PRIVATE_KEY &&
      c.env.ARGUS_GITHUB_WEBHOOK_SECRET
  );
  return c.json({
    configured,
    installUrl: c.env.ARGUS_GITHUB_APP_SLUG
      ? `https://github.com/apps/${c.env.ARGUS_GITHUB_APP_SLUG}/installations/new`
      : undefined,
    checkName: "Argus Verification",
  });
});

app.post("/platform/github/webhook", async (c) => {
  const secret = c.env.ARGUS_GITHUB_WEBHOOK_SECRET;
  if (!secret || !c.env.ARGUS_GITHUB_APP_ID || !c.env.ARGUS_GITHUB_PRIVATE_KEY) {
    return c.json({ error: "github_app_not_configured" }, 503);
  }
  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") ?? "";
  if (!(await verifyGitHubWebhook(rawBody, secret, signature))) {
    return c.json({ error: "invalid_signature" }, 401);
  }
  const event = c.req.header("x-github-event") ?? "";
  const delivery = c.req.header("x-github-delivery") ?? "";
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(delivery)) {
    return c.json({ error: "invalid_delivery" }, 400);
  }
  const deliveryKey = `platform/github/deliveries/${delivery}.json`;
  if (await c.env.ARTIFACTS.get(deliveryKey)) {
    return c.json({ accepted: true, duplicate: true });
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  await c.env.ARTIFACTS.put(
    deliveryKey,
    JSON.stringify({ event, receivedAt: new Date().toISOString() }),
    { httpMetadata: { contentType: "application/json" } }
  );
  const publicUrl = (c.env.ARGUS_PUBLIC_URL ?? new URL(c.req.url).origin).replace(/\/$/, "");
  c.executionCtx.waitUntil(
    handleGitHubEvent(c.env, event, payload, publicUrl).catch(async (error) => {
      await c.env.ARTIFACTS.put(
        `platform/github/errors/${delivery}.json`,
        JSON.stringify({ event, at: new Date().toISOString(), error: String(error).slice(0, 1_000) }),
        { httpMetadata: { contentType: "application/json" } }
      );
    })
  );
  return c.json({ accepted: true }, 202);
});

// --- sessions ---------------------------------------------------------------

app.post("/v1/lease", async (c) => {
  const parsed = LeaseRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "bad_request", detail: parsed.error.message }, 400);
  const req = parsed.data;
  const tenant = c.get("tenant");

  const sessionId = `s-${crypto.randomUUID().slice(0, 12)}`;
  const now = Date.now();
  const info: SessionInfo = {
    sessionId,
    url: req.url,
    label: req.label,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + req.ttlSeconds * 1000).toISOString(),
    released: false,
    tenantId: tenant.id,
  };

  // Coordinator gates the slot (per-tenant fair admission) before we touch a
  // browser, and hands back a warm browser to reconnect to (if one is parked).
  const coord = coordinator(c.env);
  const gate = await coord.fetch("https://do/acquire", {
    method: "POST",
    body: JSON.stringify(info),
  });
  if (!gate.ok) return new Response(gate.body, { status: gate.status, headers: { "content-type": "application/json" } });
  const { warmSessionId } = (await gate.json()) as { warmSessionId?: string };

  const stub = c.env.BROWSER_SESSION.get(c.env.BROWSER_SESSION.idFromName(sessionId));
  const res = await stub.fetch("https://do/init", {
    method: "POST",
    body: JSON.stringify({ sessionId, tenantId: tenant.id, ...req, warmSessionId }),
  });
  if (!res.ok) {
    // Failed launch — free the slot immediately.
    await coord.fetch("https://do/release", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});
  }
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.get("/v1/sessions", async (c) => {
  const tenant = c.get("tenant");
  const query = tenant.admin ? "" : `?tenantId=${encodeURIComponent(tenant.id)}`;
  const res = await coordinator(c.env).fetch(`https://do/list${query}`);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

const SESSION_COMMANDS = new Set([
  "query",
  "act",
  "act-batch",
  "observe",
  "assert",
  "screenshot",
  "auth-save",
  "record-start",
  "record-stop",
  "info",
]);

app.post("/v1/session/:id/:command", async (c) => {
  const command = c.req.param("command");
  if (!SESSION_COMMANDS.has(command)) return c.json({ error: `unknown command ${command}` }, 404);
  if (!(await canAccessSession(c.env, c.get("tenant"), c.req.param("id")))) {
    return c.json({ error: "not_found" }, 404);
  }
  const stub = c.env.BROWSER_SESSION.get(
    c.env.BROWSER_SESSION.idFromName(c.req.param("id"))
  );
  const res = await stub.fetch(`https://do/${command}`, {
    method: "POST",
    body: await c.req.raw.text(),
  });
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.delete("/v1/session/:id", async (c) => {
  if (!(await canAccessSession(c.env, c.get("tenant"), c.req.param("id")))) {
    return c.json({ error: "not_found" }, 404);
  }
  const stub = c.env.BROWSER_SESSION.get(
    c.env.BROWSER_SESSION.idFromName(c.req.param("id"))
  );
  const res = await stub.fetch("https://do/release", { method: "POST" });
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// --- smoke ------------------------------------------------------------------

app.post("/v1/smoke", async (c) => {
  const parsed = SmokeRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "bad_request", detail: parsed.error.message }, 400);
  try {
    const report = await runSmoke(c.env, parsed.data, c.get("tenant").id);
    return c.json(report);
  } catch (err) {
    return c.json({ error: "smoke_failed", detail: String(err).slice(0, 500) }, 500);
  }
});

// --- auth profiles (saved sessions for behind-the-login-wall flows) ---------

app.get("/v1/auth/profiles", async (c) =>
  c.json({ profiles: await listAuthProfiles(c.env, c.get("tenant").id) })
);

app.delete("/v1/auth/profile/:name", async (c) => {
  const host = c.req.query("host");
  if (!host) return c.json({ error: "host query param required (profiles are host-scoped)" }, 400);
  await deleteAuthProfile(c.env, c.get("tenant").id, c.req.param("name"), host);
  return c.json({ ok: true });
});

// --- audit: a11y + perf + links + visual regression -------------------------

app.post("/v1/audit", async (c) => {
  const parsed = AuditRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "bad_request", detail: parsed.error.message }, 400);
  try {
    const report = await runAudit(c.env, parsed.data, c.get("tenant").id);
    return c.json(report);
  } catch (err) {
    return c.json({ error: "audit_failed", detail: String(err).slice(0, 500) }, 500);
  }
});

// --- flows: deterministic replay, suite verify, heal preview ----------------

const ReplayRequestSchema = z.object({
  flow: FlowSchema,
  heal: z.boolean().default(false),
});

app.post("/v1/flow/replay", async (c) => {
  const parsed = ReplayRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "bad_request", detail: parsed.error.message }, 400);
  try {
    const result = await replayFlow(c.env, parsed.data.flow, {
      heal: parsed.data.heal,
      tenantId: c.get("tenant").id,
    });
    return c.json(result);
  } catch (err) {
    return c.json({ error: "replay_failed", detail: String(err).slice(0, 500) }, 500);
  }
});

const VerifyRequestSchema = z.object({
  flows: z.array(FlowSchema).min(1).max(50),
  concurrency: z.number().int().min(1).max(8).default(4),
  /** Re-home the whole suite onto another environment (deploy gating). */
  baseUrl: z.string().url().optional(),
  /** Tag the run so the dashboard can group verdicts per app. */
  project: z.string().max(60).optional(),
});

app.post("/v1/flows/verify", async (c) => {
  const parsed = VerifyRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "bad_request", detail: parsed.error.message }, 400);
  try {
    const verdict = await verifyFlows(
      c.env,
      parsed.data.flows,
      parsed.data.concurrency,
      parsed.data.baseUrl,
      c.get("tenant").id
    );
    // Persist the consolidated verdict for the dashboard's run history.
    const runId = crypto.randomUUID().slice(0, 8);
    await c.env.ARTIFACTS.put(
      `tenants/${c.get("tenant").id}/runs/${runId}/flows-verdict.json`,
      JSON.stringify({
        runId,
        at: new Date().toISOString(),
        project: parsed.data.project,
        baseUrl: parsed.data.baseUrl,
        ...verdict,
      }),
      { httpMetadata: { contentType: "application/json" } }
    );
    await writeRunMeta(c.env, {
      runId,
      kind: "flows",
      project: parsed.data.project,
      tenantId: c.get("tenant").id,
      url: parsed.data.baseUrl ?? parsed.data.flows[0]?.startUrl ?? "",
      status: verdict.status,
      at: new Date().toISOString(),
      passed: verdict.passed,
      failed: verdict.failed,
    });
    return c.json({ runId, ...verdict });
  } catch (err) {
    return c.json({ error: "verify_failed", detail: String(err).slice(0, 500) }, 500);
  }
});

// --- run history (powers the dashboard, tenant-scoped) ----------------------

app.get("/v1/runs", async (c) => {
  const t = c.get("tenant");
  return c.json({ runs: await listRuns(c.env, 60, t.admin ? undefined : t.id) });
});

/** Latest verdict per project — the fleet board across every wired app. */
app.get("/v1/fleet", async (c) => {
  const t = c.get("tenant");
  return c.json({ projects: await fleetView(c.env, t.admin ? undefined : t.id) });
});

app.get("/v1/run/:id", async (c) => {
  const runId = c.req.param("id");
  const metaObj = await c.env.ARTIFACTS.get(`runs/${runId}/meta.json`);
  if (!metaObj) return c.json({ error: "not_found" }, 404);
  const meta = (await metaObj.json()) as { tenantId?: string };
  const owner = meta.tenantId ?? "_admin";
  const tenant = c.get("tenant");
  if (!tenant.admin && owner !== tenant.id) return c.json({ error: "not_found" }, 404);
  const prefix = `tenants/${owner}/runs/${runId}/`;
  const objects = await c.env.ARTIFACTS.list({ prefix });
  const result: Record<string, unknown> = { runId, files: objects.objects.map((o) => o.key) };
  for (const name of ["report.json", "audit-report.json", "flows-verdict.json"]) {
    const obj = await c.env.ARTIFACTS.get(`${prefix}${name}`);
    if (obj) result[name.replace(".json", "").replace("-", "_")] = await obj.json();
  }
  return c.json(result);
});

// --- capacity: live fleet telemetry (any authenticated tenant) --------------

app.get("/v1/capacity", async (c) => {
  const t = c.get("tenant");
  const stats = await coordinator(c.env)
    .fetch("https://do/stats")
    .then((r) => r.json<import("@argus/shared").CapacityStats>());
  // A tenant sees the shared fleet totals but only its own per-tenant row;
  // the admin sees every tenant.
  if (!t.admin) {
    stats.tenants = stats.tenants.filter((row) => row.id === t.id);
  }
  return c.json(stats);
});

// --- admin: tenant registry -------------------------------------------------

app.get("/v1/admin/tenants", async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;
  const res = await coordinator(c.env).fetch("https://do/tenant-list");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.post("/v1/admin/tenants", async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;
  const parsed = CreateTenantRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "bad_request", detail: parsed.error.message }, 400);
  if (parsed.data.id === ADMIN_TENANT) return c.json({ error: "reserved_id", detail: `${ADMIN_TENANT} is reserved` }, 400);

  // Mint the token here; only its hash leaves the Worker. Shown to the admin once.
  const token = `argus_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const tokenHash = await sha256Hex(token);
  const res = await coordinator(c.env).fetch("https://do/tenant-create", {
    method: "POST",
    body: JSON.stringify({ ...parsed.data, tokenHash }),
  });
  if (!res.ok) return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
  const { tenant } = (await res.json()) as { tenant: unknown };
  return c.json({ tenant, token });
});

app.patch("/v1/admin/tenant/:id", async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;
  const parsed = UpdateTenantRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "bad_request", detail: parsed.error.message }, 400);
  const res = await coordinator(c.env).fetch("https://do/tenant-update", {
    method: "POST",
    body: JSON.stringify({ id: c.req.param("id"), patch: parsed.data }),
  });
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.delete("/v1/admin/tenant/:id", async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;
  const res = await coordinator(c.env).fetch("https://do/tenant-delete", {
    method: "POST",
    body: JSON.stringify({ id: c.req.param("id") }),
  });
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// --- artifacts (screenshots, reports) ---------------------------------------

app.get("/v1/artifact/*", async (c) => {
  const key = c.req.path.replace("/v1/artifact/", "");
  const tenant = c.get("tenant");
  if (!tenant.admin && !key.startsWith(`tenants/${tenant.id}/`)) {
    return c.json({ error: "not_found" }, 404);
  }
  const obj = await c.env.ARTIFACTS.get(key);
  if (!obj) return c.json({ error: "not_found" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "private, max-age=3600",
    },
  });
});

export default app;
