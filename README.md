# 👁 Argus

**Cloud verification platform for your software.** Point it at any web app —
deployed or local — and it tests everything: functional flows, UI, UX, visual
regressions — in parallel, on Cloudflare's edge, with visual feedback that
loops straight back into your coding agent.

Inspired by [Reticle](https://github.com/reticlehq/reticle)'s verification
discipline (assert consequences, not appearances) and
[axstream](https://github.com/milind-soni/axstream)'s resolution-ladder +
verify-or-refuse ideas — rebuilt cloud-native, zero-install, with the AI brain
running on your **Claude subscription** (no API key anywhere).

## What it does

| Check | How | Cost |
|---|---|---|
| **Smoke** | loads · console clean · network clean · responsive, at 3 viewports, screenshots | deterministic, no model |
| **Flows** | record once → deterministic cloud replay with semantic anchors (testid → role → text → css), drift detection, nearest-match self-heal, decision envelopes | deterministic, no model |
| **Audit** | axe-core WCAG A/AA · FCP/LCP/CLS · broken links · horizontal overflow · pixel-diff visual regression vs baselines | deterministic, no model |
| **Exploration** | Claude maps the app, drives journeys in parallel subagents, saves new flows, judges screenshots | your Claude subscription |

Evidence is **tiered** (app signal > network/route consequence > DOM presence)
and every verdict names the weakest tier it rests on. A failing check returns a
**decision envelope** — whatChanged / suggestedFix / nextAction — machine-
actionable feedback your agent can fix from directly.

## Architecture

```
Claude Code (your subscription) ──MCP──► argus-mcp ──HTTPS──► argus-cloud (CF Worker)
                                                              ├─ Browser Rendering (Chromium)
   argus CLI ────────────────────────────HTTPS───────────────►├─ BrowserSession DO (per lease)
   cloudflared quick tunnel ◄── local apps                    ├─ Coordinator DO (cap + fleet)
                                                              ├─ R2 (shots, baselines, reports)
   Dashboard (same worker, /) ◄───────── run history ─────────┘
```

- Deterministic work (replay, diff, audits) runs 100% in the Worker — cron/CI-able.
- AI work (exploration, visual judgment, fixes) runs in Claude Code on your subscription.
- One `Coordinator` caps concurrent browsers; each lease is an isolated context.

## Quick start

```bash
# one-time, in the argus repo
pnpm install && pnpm check
cd packages/cloud
wrangler secret put ARGUS_TOKEN            # required; the API fails closed without it
wrangler deploy

# in any project you want tested
argus init https://argus-cloud.<you>.workers.dev <token>
argus verify https://your-app.example.com  # smoke + audit + every saved flow
argus test https://your-app.example.com    # deployed app
argus test --local 3000                    # local app (auto quick-tunnel)
argus audit https://your-app.example.com   # a11y + perf + links + visual
```

Open the dashboard at your worker URL, paste the token, and watch runs land —
findings, screenshots, and baseline/current/diff triptychs, each with a
**copy fix prompt** button for your agent.

## GitHub platform

Install the Argus GitHub App once and select the repositories it may test. A
signed webhook starts `Argus Verification` automatically for pull requests,
using either a stable `targetUrl` or the HTTPS `environment_url` from a
successful preview deployment:

```jsonc
// .argus/platform.json
{
  "deployment": { "environments": ["Preview"] },
  "checks": ["smoke", "audit", "flows"],
  "viewports": ["mobile", "desktop"],
  "flowConcurrency": 3
}
```

The Check Run contains the verdict and highest-priority findings, links to a
24-hour signed evidence page with screenshots, and exposes a **Rerun** action.
Provider retries for the same commit and preview URL are deduplicated before a
browser starts. No GitHub or Argus bearer token is committed to the repository
or placed in an evidence URL. See [the GitHub App setup](docs/github-app.md).

### With Claude Code

`.mcp.json` registers the `argus` MCP server. Tools:
`argus_lease/release/sessions`, `argus_query`, `argus_act`, `argus_act_batch`,
`argus_observe`, `argus_assert`, `argus_screenshot`, `argus_smoke`,
`argus_audit`, `argus_record`, `argus_flow_save/list/replay/verify/heal`,
`argus_flow_import_reticle`, `argus_runs`, `argus_findings`.

Reticle v1 flows can be imported through the MCP tool, including canonical
testid/role anchors and network, console, element, and state expectations. See
[the compatibility matrix](docs/reticle-compatibility.md) for the deliberate
boundary between Argus cloud execution and Reticle's framework-specific packages.

Say `/argus-explore <url>` to have Claude map the app, generate flows, and
audit everything in parallel.

## Flows are your test suite

`.argus/flows/*.json` is committed, human-readable, PR-reviewable:

```jsonc
{
  "version": 1,
  "name": "add-task",
  "startUrl": "https://…",
  "steps": [
    { "action": { "action": "fill", "value": "Buy milk" }, "anchor": { "testid": "new-task" } },
    { "action": { "action": "click" }, "anchor": { "testid": "add-task" },
      "expect": [{ "kind": "network", "urlIncludes": "/api/tasks", "method": "POST",
                   "status": 201, "minCount": 1, "maxCount": 1, "since": 0 }] }
  ],
  "success": [
    { "kind": "text", "anchor": { "testid": "task-count" }, "includes": "3 task(s)" },
    { "kind": "console-clean", "since": 0 }
  ]
}
```

That `expect` is what catches the **silent 500**: the UI optimistically renders
the task either way, a DOM assertion stays green, and the network predicate
fails the flow. Verified against `apps/demo` (`?bug=silent500` et al).

**Test inputs & logins:** any string in a flow may use `${VAR}` placeholders
(e.g. `"value": "${TEST_USER_EMAIL}"`). They resolve from the environment on
your machine at replay time — never sent in files, never committed. A missing
variable fails loudly naming what to provide, so the agent asks you for it.

## Testing behind the login wall

Most of an app is authenticated, so flows support saved sessions:

```jsonc
// auth-login.json — signs in for real, then mints the profile
{ "saveAuthAs": "default", "success": [ /* password field gone, console clean */ ] }

// authed-area.json — starts already signed in
{ "auth": "default", "startUrl": "https://…/portal" }
```

`saveAuthAs` persists cookies/localStorage to R2 (token-gated, never in the
repo) only when the login flow **succeeds**; `auth` loads it. `argus_flow_verify`
runs profile-minting flows as a first wave, so a suite self-recovers from an
expired session in one pass. A missing profile is a loud error with a fix, not
a silent anonymous run.

## The `cf-saas` preset

For the house stack (CF Workers + Hono + React + Vite + better-auth):

```bash
argus preset cf-saas https://your-app.workers.dev
```

It probes the app **in a real browser** — an SPA returns HTTP 200 for every
path, so status codes would invent flows for routes that don't exist. It
harvests the links the app advertises, fingerprints the not-found page, and
generates only confirmed routes: `landing-loads`, `signin-page`, `auth-login`,
`signup-page`, `authed-area`, `protected-redirect`, `unknown-route`,
`api-health`. Anything unconfirmed is skipped and reported rather than guessed.

Seed a verified test user first (see `scripts/seed-test-user.mjs` in a wired
project: create via the app's own sign-up endpoint, then flip `email_verified`
in D1), then export `ARGUS_TEST_EMAIL` / `ARGUS_TEST_PASSWORD`.

`argus_flow_verify` replays the whole suite in parallel cloud browsers —
measured ~2× faster than sequential at 3 flows, scaling with the session cap.

## Monorepo

```
packages/shared     zod wire contract — every schema crossing a boundary
packages/cloud      CF Worker: API, DOs, replay engine, audits, dashboard hosting
packages/cli        argus init/test/audit/tunnel/sessions/config
packages/mcp        MCP server for Claude Code
packages/dashboard  React dashboard (builds into cloud/public)
apps/demo           dogfood app with injectable bug switchboard (?bug=…)
```

## Limits & notes

- Browser Rendering: paid Workers plan; ~30 concurrent sessions, 10-min
  keep-alive per session (leases auto-expire ≤9 min; DOs warm-reconnect).
- Vite dev/preview servers must allow the tunnel host:
  `server.allowedHosts: [".trycloudflare.com"]`.
- Session ring buffers are in-memory per DO; an evicted DO reconnects but
  events from before eviction are gone (report `coverage: partial`).
- Visual baselines key on the exact URL (override with `baselineKey`).

## Deploy gate

Verify a build *before* it takes traffic:

```bash
argus gate --upload          # wrangler versions upload → verify preview → promote if green
argus gate --url <any-url>   # or gate an existing staging/preview URL
```

One suite, any environment: `baseUrl` re-homes every flow onto the target
origin, so nothing is edited per environment. Auth profiles are **host-scoped**,
so a preview mints its own session rather than reusing (or clobbering)
production's. Exit code is non-zero on failure, so CI can gate on it.

> better-auth apps reject logins from untrusted origins, so authenticated flows
> only gate on a preview if the app trusts its own version-preview origin.
> grandstage does this by deriving `https://*-<host>` from `APP_URL`.

## Tier-1 evidence: the optional SDK

```ts
// vite.config.ts
import { argus } from "@argus/sdk/vite";
plugins: [react(), argus()]   // dev/preview builds only; production ships nothing

// in your app
import { signal, registerStore } from "@argus/sdk";
registerStore("tasks", () => store.getState().tasks);
signal("task:added", { id });
```

Then assert on truth the DOM can't fake:

```jsonc
{ "kind": "signal", "name": "task:added", "minCount": 1, "maxCount": 1 }
{ "kind": "state", "store": "tasks", "path": "2", "equals": "Buy milk" }
```

Measured on the demo's `?bug=silent500` (UI renders the task, the POST 500s):

| Evidence | Verdict |
|---|---|
| DOM — is it on screen? | ✅ pass — **would ship the bug** |
| State — is it in the store? | ✅ pass — optimistic update, **also fooled** |
| **Signal — did the app declare success?** | ❌ **fail — the only tier that caught it** |

## Fleet view

Runs are tagged with the project directory name, and the dashboard's **Fleet**
tab shows the latest verdict per app, so several wired projects are one glance.

## Email, magic links & verification

Signup-verification, password-reset and magic-link sign-in need the mail the app
sent. Apps on this stack queue outgoing mail into their own D1 table, so that
table is the honest source — no inbox, no DNS, no third-party service:

```jsonc
// .argus/config.json
"email": { "source": "d1", "database": "grandstage", "table": "delivery" }
```

```
argus_email_link({ address, contains: "verify-email" }) → the link to drive
```

Verified end to end on grandstage: sign up → `email_verified = 0` → read the
emailed link → visit it in a cloud browser → `email_verified = 1`.

---

## Part of the everyai-com agent stack

Open-source infrastructure for local-first, governed AI agents:

- [distillory](https://github.com/everyai-com/distillory) — local-first memory engine that reasons at ingestion
- [agentprofile](https://github.com/everyai-com/agentprofile) — one agent identity — skills, credentials, memory — across every tool
- [agent-ready](https://github.com/everyai-com/agent-ready) — turn any app into an MCP server + API + CLI, safe by default
- [primer](https://github.com/everyai-com/primer) — live business context injected into any agent
- [plainsync](https://github.com/everyai-com/plainsync) — local-first Markdown workspace for humans + agents
- [mintly-alternative](https://github.com/everyai-com/mintly-alternative) — self-hostable documentation layer for humans + AI agents
- [talltrack](https://github.com/everyai-com/talltrack) — sales calls in, publishable content out

Built by [Phanindra Reddy](https://github.com/everyai-com) · [magicteams.ai](https://magicteams.ai)
