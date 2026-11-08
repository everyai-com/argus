/**
 * Persona launch-QA runs: uploaded by `argus personas`, stored per tenant in
 * R2, read by the dashboard's Launch QA view. Ids sort by time, so the newest
 * runs are the last keys of a prefix listing.
 */
import type { PersonaRun, PersonaRunSummary, PersonaRunUpload } from "@argus/shared";
import type { Env } from "./env";

const SEVERITY = ["minor", "major", "blocker"];
const prefixOf = (tenantId: string) => `tenants/${tenantId}/personas/`;

export function summarize(run: PersonaRun): PersonaRunSummary {
  const worst = run.issues.reduce<string | undefined>(
    (w, i) => (SEVERITY.indexOf(i.severity) > SEVERITY.indexOf(w ?? "") ? i.severity : w),
    undefined
  );
  return {
    id: run.id,
    url: run.url,
    goal: run.goal,
    createdAt: run.createdAt,
    reached: run.reports.filter((r) => r.reachedSuccess).length,
    personas: run.reports.length,
    issues: run.issues.length,
    ...(worst ? { worst } : {}),
  };
}

export async function savePersonaRun(env: Env, tenantId: string, upload: PersonaRunUpload, now = new Date()): Promise<PersonaRun> {
  const id = `p-${now.toISOString().replace(/\D/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 6)}`;
  const run: PersonaRun = { ...upload, id, createdAt: now.toISOString() };
  await env.ARTIFACTS.put(`${prefixOf(tenantId)}${id}.json`, JSON.stringify(run), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { summary: JSON.stringify(summarize(run)) },
  });
  return run;
}

export async function listPersonaRuns(env: Env, tenantId: string, limit = 30): Promise<PersonaRunSummary[]> {
  const listed = await env.ARTIFACTS.list({ prefix: prefixOf(tenantId), include: ["customMetadata"] } as R2ListOptions);
  return listed.objects
    .map((o) => o.customMetadata?.summary)
    .filter((s): s is string => typeof s === "string")
    .map((s) => JSON.parse(s) as PersonaRunSummary)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export async function getPersonaRun(env: Env, tenantId: string, id: string): Promise<PersonaRun | undefined> {
  if (!/^p-\d{14}-[0-9a-f]{6}$/.test(id)) return undefined;
  const obj = await env.ARTIFACTS.get(`${prefixOf(tenantId)}${id}.json`);
  return obj ? ((await obj.json()) as PersonaRun) : undefined;
}
