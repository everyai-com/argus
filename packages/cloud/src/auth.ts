/**
 * Accounts — better-auth on D1 (email + password).
 *
 * This is what makes Argus self-serve: anyone signs up, and the dashboard mints
 * them a tenant token to paste into their agent. Sessions live in D1
 * (user / session / account / verification); the tenant registry stays in the
 * Coordinator DO, so one account maps to exactly one tenant.
 *
 * Migrations are applied out-of-band: `wrangler d1 execute argus-accounts
 * --remote --file=migrations/0001_auth.sql`. They are NOT run at runtime —
 * Kysely's migration introspection uses PRAGMA statements that D1 rejects with
 * SQLITE_AUTH, which would 500 every auth request.
 */
import { betterAuth, type BetterAuthOptions } from "better-auth";
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
