/**
 * Run metadata — the index behind run history and the fleet view.
 *
 * Each run writes a tiny `meta.json` alongside its full report (read by
 * /v1/run/:id), plus two INDEX entries whose keys sort newest-first and whose
 * R2 custom metadata carries the meta itself:
 *
 *   runidx/<inverted-ms>-<runId>                    (admin: every tenant)
 *   tenants/<tenant>/runidx/<inverted-ms>-<runId>   (one tenant)
 *
 * Listing recent runs is then ONE list call with `include: customMetadata` —
 * no per-run reads, no cross-tenant scan. (It used to read every run's meta on
 * every dashboard poll: ~27s at 640 runs, growing forever; and past R2's
 * 1000-key page, "recent" became a random subset because run ids are random.)
 */
import type { Env } from "./env";

export interface RunMeta {
  runId: string;
  kind: "smoke" | "audit" | "flows" | "crawl";
  project?: string;
  /** Which tenant owns this run — runs/fleet views are filtered by it (admin sees all). */
  tenantId?: string;
  /** Who/what triggered the run (`cli`, `mcp`, `github-app`, `ci:…`, `agent:…`). */
  actor?: string;
  url: string;
  status: string;
  at: string;
  durationMs?: number;
  findings?: number;
  passed?: number;
  failed?: number;
}

const ADMIN = "_admin";
const BACKFILL_MARKER = "runidx-state/backfilled-v1";

/** Newest-first sortable time key: lexical order of the inverse of epoch ms. */
function invertedTime(iso: string): string {
  const ms = Date.parse(iso);
  return String(9_999_999_999_999 - (Number.isFinite(ms) ? ms : 0)).padStart(13, "0");
}

function indexKeys(meta: RunMeta): string[] {
  const suffix = `${invertedTime(meta.at)}-${meta.runId}`;
  return [`runidx/${suffix}`, `tenants/${meta.tenantId ?? ADMIN}/runidx/${suffix}`];
}

async function writeIndex(env: Env, meta: RunMeta): Promise<void> {
  // Custom metadata is capped (~2KB) — keep the index entry lean.
  const lean: RunMeta = { ...meta, url: meta.url.slice(0, 300), project: meta.project?.slice(0, 60) };
  const customMetadata = { m: JSON.stringify(lean) };
  await Promise.all(indexKeys(meta).map((key) => env.ARTIFACTS.put(key, "", { customMetadata })));
}

export async function writeRunMeta(env: Env, meta: RunMeta): Promise<void> {
  await Promise.all([
    env.ARTIFACTS.put(`runs/${meta.runId}/meta.json`, JSON.stringify(meta), {
      httpMetadata: { contentType: "application/json" },
    }),
    writeIndex(env, meta),
  ]);
}

/**
 * One-time migration: index runs written before the index existed. Idempotent
 * (same keys), so two first requests racing it is harmless.
 */
async function ensureBackfilled(env: Env): Promise<void> {
  if (await env.ARTIFACTS.head(BACKFILL_MARKER)) return;
  let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const page = await env.ARTIFACTS.list({ prefix: "runs/", delimiter: "/", cursor });
    ids.push(...page.delimitedPrefixes.map((p) => p.replace("runs/", "").replace("/", "")));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (let i = 0; i < ids.length; i += 50) {
    await Promise.all(
      ids.slice(i, i + 50).map(async (runId) => {
        const meta = await legacyMeta(env, runId);
        if (meta) await writeIndex(env, meta);
      })
    );
  }
  await env.ARTIFACTS.put(BACKFILL_MARKER, new Date().toISOString());
}

async function legacyMeta(env: Env, runId: string): Promise<RunMeta | undefined> {
  const obj = await env.ARTIFACTS.get(`runs/${runId}/meta.json`);
  if (obj) return (await obj.json().catch(() => undefined)) as RunMeta | undefined;
  // Pre-meta runs: keep them listable rather than hiding them.
  const objects = await env.ARTIFACTS.list({ prefix: `runs/${runId}/` });
  if (objects.objects.length === 0) return undefined;
  const newest = objects.objects.reduce<Date | undefined>(
    (acc, o) => (!acc || o.uploaded > acc ? o.uploaded : acc),
    undefined
  );
  return {
    runId,
    kind: objects.objects.some((o) => o.key.endsWith("audit-report.json"))
      ? "audit"
      : objects.objects.some((o) => o.key.endsWith("flows-verdict.json"))
        ? "flows"
        : "smoke",
    url: "",
    status: "unknown",
    at: newest?.toISOString() ?? "",
  };
}

/**
 * Recent runs, newest first, from the index — one list call. When `tenantId`
 * is given, only that tenant's runs (admin passes undefined to see the fleet).
 * Legacy runs with no tenant tag belong to the admin/default tenant.
 */
export async function listRuns(env: Env, limit = 60, tenantId?: string): Promise<RunMeta[]> {
  await ensureBackfilled(env);
  const listed = await env.ARTIFACTS.list({
    prefix: tenantId ? `tenants/${tenantId}/runidx/` : "runidx/",
    limit: Math.min(Math.max(limit, 1), 1000),
    include: ["customMetadata"],
  });
  const metas: RunMeta[] = [];
  for (const o of listed.objects) {
    try {
      const m = JSON.parse(o.customMetadata?.["m"] ?? "") as RunMeta;
      if (!tenantId || (m.tenantId ?? ADMIN) === tenantId) metas.push(m);
    } catch {
      /* a malformed index entry is skipped, never fatal */
    }
  }
  return metas;
}

/** Latest verdict per project — the fleet board (tenant-scoped when given). */
export async function fleetView(
  env: Env,
  tenantId?: string
): Promise<Array<{ project: string; latest: RunMeta; runs: number; failing: number }>> {
  const runs = await listRuns(env, 200, tenantId);
  const byProject = new Map<string, RunMeta[]>();
  for (const r of runs) {
    if (!r.project) continue;
    const list = byProject.get(r.project) ?? [];
    list.push(r);
    byProject.set(r.project, list);
  }
  return [...byProject.entries()]
    .map(([project, list]) => ({
      project,
      latest: list[0]!,
      runs: list.length,
      failing: list.filter((r) => r.status === "fail" || r.status === "error").length,
    }))
    .sort((a, b) => (a.latest.at < b.latest.at ? 1 : -1));
}
