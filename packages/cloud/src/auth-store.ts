/**
 * Auth profiles — saved browser storage state (cookies + localStorage) so
 * flows can run *behind the login wall*.
 *
 * The model: one `login` flow signs in for real and persists its resulting
 * session as a named profile (`saveAuthAs`); every other flow starts from that
 * profile (`auth`) instead of re-driving the login form. That makes
 * authenticated pages — dashboards, settings, CRUD — testable at all, and
 * keeps each flow about its own behaviour rather than about signing in.
 *
 * These blobs are live session credentials. They live only in R2 behind the
 * API token, never in the repo, and carry a savedAt stamp so a stale profile
 * reports itself rather than failing mysteriously downstream.
 */
import type { Env } from "./env";

/** Playwright's storageState shape (kept loose — we only ferry it). */
export type StorageState = {
  cookies?: unknown[];
  origins?: unknown[];
};

interface StoredProfile {
  name: string;
  host: string;
  savedAt: string;
  url?: string;
  state: StorageState;
}

/**
 * Profiles are scoped by host. Session cookies only apply to the host that
 * issued them, so a profile minted against production is worthless against a
 * version-preview URL — and reusing one name across both would overwrite the
 * good profile with cookies the other environment rejects. Scoping keeps
 * `auth: "default"` meaning "the default profile *for this environment*".
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

const key = (tenantId: string, name: string, host: string) =>
  `tenants/${tenantId}/auth/${host}/${name}.json`;

export async function saveAuthProfile(
  env: Env,
  tenantId: string,
  name: string,
  host: string,
  state: StorageState,
  url?: string
): Promise<{ name: string; host: string; savedAt: string; cookies: number }> {
  const payload: StoredProfile = {
    name,
    host,
    savedAt: new Date().toISOString(),
    url,
    state,
  };
  await env.ARTIFACTS.put(key(tenantId, name, host), JSON.stringify(payload), {
    httpMetadata: { contentType: "application/json" },
  });
  return {
    name,
    host,
    savedAt: payload.savedAt,
    cookies: Array.isArray(state.cookies) ? state.cookies.length : 0,
  };
}

/** Returns undefined when the profile doesn't exist — callers decide. */
export async function loadAuthProfile(
  env: Env,
  tenantId: string,
  name: string,
  host: string
): Promise<StoredProfile | undefined> {
  const obj = await env.ARTIFACTS.get(key(tenantId, name, host));
  if (!obj) return undefined;
  try {
    return (await obj.json()) as StoredProfile;
  } catch {
    return undefined;
  }
}

export async function listAuthProfiles(
  env: Env,
  tenantId: string
): Promise<Array<{ name: string; host: string; savedAt: string; ageHours: number }>> {
  const prefix = `tenants/${tenantId}/auth/`;
  const listed = await env.ARTIFACTS.list({ prefix });
  const out: Array<{ name: string; host: string; savedAt: string; ageHours: number }> = [];
  for (const o of listed.objects) {
    const rest = o.key.slice(prefix.length).replace(/\.json$/, "");
    const slash = rest.lastIndexOf("/");
    out.push({
      name: slash === -1 ? rest : rest.slice(slash + 1),
      host: slash === -1 ? "unknown" : rest.slice(0, slash),
      savedAt: o.uploaded.toISOString(),
      ageHours: Math.round(((Date.now() - o.uploaded.getTime()) / 3_600_000) * 10) / 10,
    });
  }
  return out;
}

export async function deleteAuthProfile(
  env: Env,
  tenantId: string,
  name: string,
  host: string
): Promise<void> {
  await env.ARTIFACTS.delete(key(tenantId, name, host));
}
