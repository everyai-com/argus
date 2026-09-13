/**
 * Accounts — better-auth on D1 (email + password).
 *
 * This is what makes Argus self-serve: anyone signs up, and the dashboard mints
 * them a tenant token to paste into their agent. Sessions live in D1
 * (user / session / account / verification); the tenant registry stays in the
 * Coordinator DO, so one account maps to exactly one tenant.
 *
 * Migrations run lazily, once per isolate: a Worker has no deploy step that can
 * run the better-auth CLI, and an empty D1 would otherwise 500 every auth call.
 * Concurrent isolates are tolerated — "table already exists" is success.
 */
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import type { Env } from "./env";

export function authOptions(env: Env, origin: string): BetterAuthOptions {
  const db = new Kysely<Record<string, unknown>>({
    dialect: new D1Dialect({ database: env.DB }),
  });
  return {
    database: { db, type: "sqlite" },
    secret: env.BETTER_AUTH_SECRET ?? "",
    baseURL: env.BETTER_AUTH_URL ?? env.ARGUS_PUBLIC_URL ?? origin,
    basePath: "/api/auth",
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      autoSignIn: true,
    },
    trustedOrigins: [origin, env.ARGUS_PUBLIC_URL].filter((v): v is string => Boolean(v)),
  } as BetterAuthOptions;
}

export function createAuth(env: Env, origin: string) {
  return betterAuth(authOptions(env, origin));
}

let ready: Promise<void> | null = null;

export function ensureAuthSchema(env: Env, origin: string): Promise<void> {
  if (!ready) {
    ready = getMigrations(authOptions(env, origin))
      .then(({ runMigrations }) => runMigrations())
      .catch((error: unknown) => {
        if (!/already exists/i.test(String(error))) throw error;
      });
  }
  return ready;
}
