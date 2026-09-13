/**
 * Server-side flow storage — the remote MCP surface keeps a tenant's flows in
 * R2 instead of on a laptop's disk, so an agent can connect to Argus by URL
 * with no checkout. The repo copy stays available for review, and the GitHub
 * App already reads the committed files at the pull request's head SHA.
 *
 * One tenant can never see another's flows: every key is prefixed with the
 * resolved tenant id, never a client-supplied one.
 */
import { FlowSchema, type Flow } from "@argus/shared";
import type { Env } from "./env";

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function flowKey(tenantId: string, name: string): string {
  return `tenants/${tenantId}/flows/${name}.json`;
}

function tenantPrefix(tenantId: string): string {
  return `tenants/${tenantId}/flows/`;
}

export async function listFlows(env: Env, tenantId: string): Promise<Flow[]> {
  const listed = await env.ARTIFACTS.list({ prefix: tenantPrefix(tenantId) });
  const flows: Flow[] = [];
  for (const object of listed.objects) {
    const obj = await env.ARTIFACTS.get(object.key);
    if (!obj) continue;
    const parsed = FlowSchema.safeParse(await obj.json().catch(() => null));
    if (parsed.success) flows.push(parsed.data);
  }
  return flows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getFlow(env: Env, tenantId: string, name: string): Promise<Flow | null> {
  if (!SAFE_NAME.test(name)) return null;
  const obj = await env.ARTIFACTS.get(flowKey(tenantId, name));
  if (!obj) return null;
  const parsed = FlowSchema.safeParse(await obj.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

export async function putFlow(env: Env, tenantId: string, flow: Flow): Promise<void> {
  if (!SAFE_NAME.test(flow.name)) throw new Error("flow name must be a single safe path segment");
  await env.ARTIFACTS.put(flowKey(tenantId, flow.name), JSON.stringify(flow, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
}

export async function deleteFlow(env: Env, tenantId: string, name: string): Promise<boolean> {
  if (!SAFE_NAME.test(name)) return false;
  const key = flowKey(tenantId, name);
  if (!(await env.ARTIFACTS.head(key))) return false;
  await env.ARTIFACTS.delete(key);
  return true;
}
