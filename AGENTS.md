# Argus — agent notes

Canonical agent file for this repo. Harnesses that read `AGENTS.md` natively
(Codex, Cursor, Copilot, Zed, Amp, opencode, Windsurf, Aider — the list lives at
[agents.md](https://agents.md)) get it directly; Claude Code imports it through
`CLAUDE.md` (`@AGENTS.md`), and Gemini CLI reads it once `.gemini/settings.json`
sets `context.fileName` (what `argus init` writes).

Cloud verification platform. Monorepo: `packages/shared` (zod wire contract —
every cross-boundary schema lives here, both sides import it), `packages/cloud`
(CF Worker: Hono API + BrowserSession/Coordinator DOs + replay/audit engines +
dashboard hosting), `packages/cli`, `packages/mcp`, `packages/dashboard`,
`apps/demo` (dogfood app, `?bug=silent500|deadbutton|wrongstate|overflow|consoleerror|slowreq`).

## Commands

- typecheck all: `pnpm -r typecheck` · build CLI/MCP: `pnpm --filter @argus/cli --filter @argus/mcp build`
- dashboard: `pnpm --filter @argus/dashboard build` (into gitignored `dist/`) + `promote` to ship into `cloud/public` (refuses while vendored)
- deploy: `cd packages/cloud && wrangler deploy` (account already logged in)
- live API: `https://argus-cloud.everyai-com.workers.dev` · token in `.argus/config.json` (gitignored)
- demo: `pnpm --filter @argus/demo build && (cd apps/demo && pnpm preview)` (port 5199 is in vite.config; bare `vite` is not on PATH)
- demo worker (live dogfood target): https://argus-demo.everyai-com.workers.dev · deploy with `pnpm --filter @argus/demo deploy` (builds + ships `worker.ts` + `./dist`); API logic is shared in `apps/demo/shared/api.ts` so preview and prod can't drift
- tunnel for local testing: `argus tunnel 5199` (or `node packages/cli/dist/index.js ...`)
- wire a project to Argus (MCP + verification steps): `argus init [--token <t>] [--harness all]` (bare init uses hosted cloud + prompts; `verify` auto-generates a flow suite when none exists)
- launch QA / self-healing: `argus personas <url> --goal "…"` (five users via your agent
  CLI, merged + ranked) · `argus fix [url] --preview "<cmd>" [--pr]` (confirmed failure →
  worktree fix → proven on a preview → draft PR) · `argus patrol <url> [--fix]` (re-verify
  on every new commit to main)
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
  tenant below its floor is admitted whenever the fleet is under the cap (the cap
  is physical, so it binds floors too); bursting only takes capacity net of
  OTHER enabled tenants' unused reservations (`global + unusedReservations ≥ cap`
  ⇒ 429 `fleet_saturated`). `maxBurst ≥ reserved` always. EVERY browser holds a
  Coordinator slot — interactive leases AND batch runs (smoke/audit/flow replay,
  `kind: "batch"` via `acquirePooledBrowser`); a browser outside admission is
  invisible to fairness and the cap. Unknown (deleted) tenant ids are refused,
  never treated as admin. The warm pool and the 3/sec launch limiter stay GLOBAL — a
  parked Chromium is tenant-agnostic and the launch rate is a physical account
  limit, not a per-tenant one; don't shard them. Warm entries expire before the
  10-min keep_alive and the newest is handed out first.
- Session release is single-flight (DELETE can race the TTL alarm): a second
  release must never re-park or close a browser the first already handed back.
  A parked browser holds no contexts; one whose contexts won't close is closed,
  not parked.
- Absence claims need complete evidence: buffers track `lostThrough` (ring
  eviction, DO restart) and `console-clean` / `maxCount` / unmet-count
  predicates over a gap fail as unverifiable — never pass. Seqs come from
  per-instance blocks so cursors survive a DO restart.
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
- The two MCP surfaces must not drift: `packages/cloud/src/mcp.ts` (remote, by URL)
  and `packages/mcp/src/index.ts` (stdio) expose the same tools — same required
  params and same JSON shape per shared param (a param only one side offers must be
  optional; descriptions may differ). Never wrap a `packages/shared` schema in an
  extra object on one side: `argus_act` shipped as `action: ActionSchema` (double
  `action.action`) so the only input MCP accepted was one `/v1` rejects — every call
  failed. `packages/cloud/src/mcp-parity.e2e.test.ts` enforces this.
- Only a repeated failure counts: `verifyFlows` re-runs every product failure
  once (no judge); agreement (same status/verdict/step/evidence, 4+ digit
  numbers normalised) = `confirmed`, disagreement = `flaky`. Flaky and
  `untested` (fleet_busy, missing auth profile, crash before step 0) never
  fail a suite; confirmed failures save a `repro-*` flow. CLI exit codes:
  0 pass · 1 confirmed regression · 2 usage · 4 could not test. The GitHub
  check fails only on deterministic evidence (visual/perf alone → neutral).
- Visual diffs compare a STABLE capture, never the live load: own context,
  frozen clock + seeded `Math.random`, motion killed, analytics/ads/chat
  blocked, masks painted, two byte-identical frames (`stability.ts`). A screen
  that never settles is `unstable` (untested), not a diff. Baselines live
  under `baselines/v2/`. Masked share is reported on every diff; >50% is a
  `visual/hollow` finding. No global tolerance knob.
- Findings carry a stable `fingerprint` (`triage.ts`); per-host triage memory
  in R2 marks new/known/regression, keeps dismissed findings out of the
  verdict but always lists them under `suppressed`, and auto-closes after 3
  covering clean runs. Automation never overwrites a human decision.
- Only http(s) URLs reach a browser (`HttpUrlSchema`) — browsers are reused
  across tenants. The recorder writes secret fields (password/OTP/card/token)
  as `${VAR}` placeholders, never the typed value.
- Every `act` measures the page in ONE in-page read before and ONE after
  (`pageState` in `detectors.ts`) — never add per-signal evaluates: each is a
  ~180ms hop to the remote Chromium (measured; a DO location hint doesn't
  help — the hop is the Browser Rendering relay). The one exception is
  conditional: `pendingFeedback` reads the page mid-request ONLY for an
  interaction (`isInteraction`: click, Enter/Space) whose own fetch/XHR has
  waited ≥150ms with NO response yet (`slowRequest`),
  so fast acts pay nothing. Document loads (reload/goto) and answered
  requests are excluded — sampling them reported "no loading state" for
  pages that were simply done (both false positives came from the first real
  `argus personas` run). Settling waits for the requests the act STARTED (`waitForQuiet`),
  never `waitForLoadState("networkidle")` — that resolves at once on a page
  that was idle before, which read slow saves as dead buttons.
- Network emulation (`network` on a lease, the `network` action) rides ONE
  CDP session per page; a throttled recording saves the throttle as step 0.
  `phone` is a real touch device (isMobile/hasTouch, mobile Chrome UA, 2x);
  `mobile` stays a plain 375px window so existing baselines still compare.
- A dropped browser connection reattaches the live page (else reopens the
  LAST url) and the act carries `recovered` — never a silent new context:
  that wiped storage and read as the app losing data.
- `persists` on a flow re-checks state predicates after one reload
  (`not_persisted` verdict) — the optimistic-UI-never-saved class.
- Electron sessions (`argus_lease { electron }`, ids `local-*`) run in the
  stdio MCP server with the cloud's own engine modules — keep
  `detectors.ts`, `flow-utils.ts` and `verify.ts` free of Worker-only
  imports (types only from `@cloudflare/playwright`), or desktop breaks.
  Effects come from the pure `actEffects`, shared by both backends.
- `argus fix` ships a fix only when the flow passes on `--preview` of the
  fixed branch and nothing else breaks; edits under `.argus/` are refused;
  a PR a human closed unmerged is never reopened. `argus patrol` advances
  its tested sha only after a run that actually tested. Effects carry `silentAction`,
  `failureShownAsSuccess` (own-origin request failed + page changed + no error
  shown), `newLayoutIssues` (detector rules the action added) and
  `newHorizontalOverflow`, plus per-phase `timings`.
- `viewport` is an action (preset/size/colorScheme mid-session); flows replay it.
- `/v1/crawl` is read-only by construction: links only, never clicks/submits,
  skips sign-out links and non-HTML documents, decides not-found from the
  RENDERED page, holds one admission slot per worker, and dedupes findings
  by fingerprint across URLs of the same page.
- Vision decision layer (`judge.ts`, Clef via the Workers AI binding):
  judgments refine heuristic severities and attach additive triage — never
  predicate verdicts. Every judge call degrades to `undefined` (no binding,
  timeout, malformed response, low confidence) and the deterministic result
  stands; raw signals (diffRatio, predicate evidence) are always preserved
  beside the judgment. Confidence gates live in `judge.ts` (noise suppression
  0.85 / grade apply 0.5 / inconclusive 0.35) — recalibrate from production
  traffic, don't guess. Audit judging runs after browser release, in parallel;
  replay triage runs on failures only (passes pay zero).

## Harness support

The MCP server (`packages/mcp`) is plain stdio and works with any MCP client. The
per-harness wiring lives in `packages/cli/src/harness.ts` — it is the single source
of truth for `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`,
`.gemini/settings.json`, `AGENTS.md` and the Codex TOML snippet. Add a new harness
there, not inline in `init`. See `docs/harness-support.md` for the full matrix.

## Gotchas

- `wrangler dev` needs `--remote` for the browser binding; we test against the
  deployed worker instead.
- Vite apps behind the tunnel need `allowedHosts: [".trycloudflare.com"]`.
- Flow `startUrl`s in `.argus/flows/` point at the local demo
  (`http://localhost:5199/`). `argus verify` / `test --local` re-home them onto
  the target/tunnel URL, so the committed host only matters for local replay.
- Fresh trycloudflare hostnames take ~10s to resolve at the edge; local DNS may
  lag longer (the CLI polls, then proceeds).
- Quick tunnels are edge bot-managed: since ~Oct-2026 the headless cloud
  browsers get 403 "Your request was blocked" on `*.trycloudflare.com` hosts
  (observed on fresh hosts, not transient). For local testing use a named
  tunnel on your own domain until this clears.
- `packages/cloud/public/` is the PROMOTED dashboard bundle: build, then
  `promote` to ship. Never hand-edit it; change `packages/dashboard/src/`.
