/**
 * Run metadata — the index behind run history and the fleet view.
 *
 * Each run writes a tiny `meta.json` alongside its full report. Listing runs
 * then costs one small read per run instead of parsing whole reports (which
 * carry screenshots, findings and network logs), which is what makes a
 * multi-project fleet board cheap enough to poll.
 */
import type { Env } from "./env";

export interface RunMeta {
  runId: string;
  kind: "smoke" | "audit" | "flows";
  project?: string;
  /** Which tenant owns this run — runs/fleet views are filtered by it (admin sees all). */
  tenantId?: string;
  url: string;
  status: string;
  at: string;
  durationMs?: number;
  findings?: number;
  passed?: number;
  failed?: number;
}

export async function writeRunMeta(env: Env, meta: RunMeta): Promise<void> {
  await env.ARTIFACTS.put(`runs/${meta.runId}/meta.json`, JSON.stringify(meta), {
    httpMetadata: { contentType: "application/json" },
  });
}

/**
 * Recent runs, newest first. Bounded so a long history can't blow the request.
 * When `tenantId` is given, only that tenant's runs are returned (admin passes
 * undefined to see the whole fleet). Legacy runs with no tenant tag are treated
 * as the admin/default tenant.
 */
export async function listRuns(
  env: Env,
  limit = 60,
  tenantId?: string
): Promise<RunMeta[]> {
  const listed = await env.ARTIFACTS.list({ prefix: "runs/", delimiter: "/" });
  const ids = listed.delimitedPrefixes.map((p) => p.replace("runs/", "").replace("/", ""));
  const metas = await Promise.all(
    ids.map(async (runId) => {
      const obj = await env.ARTIFACTS.get(`runs/${runId}/meta.json`);
      if (obj) return (await obj.json()) as RunMeta;
      // Pre-index runs: keep them listable rather than hiding them.
      const objects = await env.ARTIFACTS.list({ prefix: `runs/${runId}/` });
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
      } satisfies RunMeta;
    })
  );
  metas.sort((a, b) => (a.at < b.at ? 1 : -1));
  const scoped = tenantId
    ? metas.filter((m) => (m.tenantId ?? "_admin") === tenantId)
    : metas;
  return scoped.slice(0, limit);
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
