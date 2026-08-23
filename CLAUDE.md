# Argus — agent notes

Cloud verification platform. Monorepo: `packages/shared` (zod wire contract —
every cross-boundary schema lives here, both sides import it), `packages/cloud`
(CF Worker: Hono API + BrowserSession/Coordinator DOs + replay/audit engines +
dashboard hosting), `packages/cli`, `packages/mcp`, `packages/dashboard`,
`apps/demo` (dogfood app, `?bug=silent500|deadbutton|wrongstate|overflow|consoleerror|slowreq`).

## Commands

- typecheck all: `pnpm -r typecheck` · build CLI/MCP: `pnpm --filter @argus/cli --filter @argus/mcp build`
- dashboard build (into cloud/public): `pnpm --filter @argus/dashboard build`
- deploy: `cd packages/cloud && wrangler deploy` (account already logged in)
- live API: `https://argus-cloud.everyai-com.workers.dev` · token in `.argus/config.json` (gitignored)
- demo: `pnpm --filter @argus/demo build && (cd apps/demo && vite preview --port 5199)`
- tunnel for local testing: `argus tunnel 5199` (or `node packages/cli/dist/index.js ...`)
- fleet ops: `argus capacity [--watch]` (live gauges) · `argus stress <N>` (load) ·
  `argus tenants list|create <id> --reserved R --burst B|update <id>|rm <id>` (admin token only)

## Invariants (do not break)

- Wire contract discipline: new API messages get a zod schema in
  `packages/shared` first; the Worker parses every inbound body against it.
- Evidence tiers: verdicts report the WEAKEST tier they rest on
  (signal > consequence > dom > visual). Never upgrade a tier.
- Verify-or-refuse: unresolvable/ambiguous anchors are errors, never guesses.
- Flows carry semantic anchors only (testid → role+name → text → css) — never
  volatile `eN` refs.
- Coordinator DO: parse request bodies BEFORE storage ops; per-session storage
  keys; cap check inside `blockConcurrencyWhile` (lost-update history here).
- Multi-tenant fairness: `Σ reserved ≤ ARGUS_MAX_SESSIONS` is enforced at tenant
  create/update — never bypass it, or reserved floors stop being satisfiable. A
  tenant below its floor is always admitted; bursting only takes capacity net of
  OTHER tenants' unused reservations (`global + unusedReservations ≥ cap` ⇒ 429
  `fleet_saturated`). The warm pool and the 1/sec launch limiter stay GLOBAL — a
  parked Chromium is tenant-agnostic and the launch rate is a physical account
  limit, not a per-tenant one; don't shard them.
- Tenant tokens: only the SHA-256 hash is stored (`tok:<hash>` → id); the raw
  token is shown once at create. Worker resolves token→tenant via an in-isolate
  cache (60s TTL) → revoking a tenant has up to 60s lag across warm isolates.
  The legacy global `ARGUS_TOKEN` is the admin tenant (unlimited within cap) and
  the only one that may call `/v1/admin/*`. Runs/fleet are tenant-scoped by
  `RunMeta.tenantId`; admin sees all.
- `page.evaluate` closures are typed via `src/dom-shim.d.ts` — don't add
  lib:["DOM"] to cloud tsconfig (conflicts with workers-types).
- PNG work uses `upng-js` (pure JS) — `pngjs` breaks on workerd zlib.
- Browser keep_alive caps at 10 min; lease TTLs stay ≤540s.
- Auth profiles (R2 `tenants/<tenant>/auth/<host>/<name>.json`) are live session cookies: token-gated,
  never written to the repo, saved only when a `saveAuthAs` flow SUCCEEDS.
  `verifyFlows` runs profile-minting flows as a first wave — don't parallelise
  that away or `auth:` flows will race a profile that doesn't exist yet.
- Route probing must render in a browser, never trust HTTP status: a
  client-routed SPA answers 200 for every path, so status-based probing
  generates flows for non-existent routes that then "pass" against the
  not-found page (a false green — this bug was real, see preset.ts).

## Gotchas

- `wrangler dev` needs `--remote` for the browser binding; we test against the
  deployed worker instead.
- Vite apps behind the tunnel need `allowedHosts: [".trycloudflare.com"]`.
- Flow `startUrl`s in `.argus/flows/` currently point at a trycloudflare URL
  from the build session — re-point at the app's real URL before relying on them.
- Fresh trycloudflare hostnames take ~10s to resolve at the edge; local DNS may
  lag longer (the CLI polls, then proceeds).
