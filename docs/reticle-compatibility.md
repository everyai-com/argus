# Reticle compatibility

Argus carries Reticle's verification discipline into a remote, multi-tenant
Cloudflare execution plane. It does not fork Reticle or duplicate its framework
packages.

## What Argus already matches

| Reticle capability | Argus equivalent | Status |
|---|---|---|
| Semantic element query | `argus_query` | Native |
| Verified actions and sequences | `argus_act`, `argus_act_batch` | Native |
| Network and console observation | `argus_observe` | Native |
| Consequence-tier assertions | `argus_assert` | Native |
| Screenshots and visual evidence | `argus_screenshot`, R2 artifacts | Native |
| Recorded, reviewable flows | `argus_record`, `argus_flow_save` | Native |
| Flow replay and drift diagnosis | `argus_flow_replay`, `argus_flow_heal` | Native |
| Parallel suite verification | `argus_flow_verify` | Native |
| Saved authenticated sessions | Host- and tenant-scoped auth profiles | Native |
| Browser leasing | Cloudflare Browser Rendering + Durable Objects | Native |
| Reticle flow files | `argus_flow_import_reticle` | Import bridge, tested against v1 |
| App signals and state | `@argus/sdk` (`signal()`, `registerStore()`) | Native Argus protocol |
| Install as a skill | `SKILL.md`, `skills/*/SKILL.md`, `.claude-plugin/` | Native |
| Docs for agents | `llms.txt` | Native |

## Deliberately upstream-only

| Reticle capability | Why Argus does not carry it |
|---|---|
| Electron / Tauri / native desktop capture | Argus verifies what a browser can reach; desktop IPC is Reticle's boundary |
| Babel / ESLint authoring plugins | Argus does not instrument the app's build |
| React / Next / Vite instrumentation packages | Argus's `@argus/sdk/vite` plugin is the supported boundary |

## Missing in Argus

Honest gaps against Reticle today — tracked, not hidden:

| Reticle capability | Argus status | Notes |
|---|---|---|
| Source **`file:line`** in a verdict | Missing | `Finding.decision.whereInSource` exists but nothing populates it — no React-fiber→source walk, no source maps |
| **React commit stream** / render-storm detection | Missing | `argus_observe` reads network, console and route only |
| **State-library adapters** (TanStack Query, Jotai, XState, Valtio, MobX, Recoil, Svelte stores, Pinia) | Missing | Only the generic `registerStore()` + `signal()` push API ships |
| **WebSocket / SSE frame** observation | Missing | The network ring buffer holds request/response events |
| **Storage** observation (localStorage / sessionStorage / cookies) as a predicate | Missing | Storage is used for auth profiles, not assertable |
| Predicate **combinators** (`allOf` / `anyOf`) | Partial | `AssertRequest.predicates[]` is already AND; there is no nested OR/AND tree |
| **Meta-tool** to cap the surface (`reticle_tools` / `reticle_run`) | Missing | All 24 `argus_*` tools are always advertised |
| One-command **npm install** of the MCP server | Missing | `@argus/cli` / `@argus/mcp` are not published; `argus init` runs from a checkout |
| Redis/TanStack-style **stale-cache** detection | Missing | No cache-adapter reads |
| **HITL annotate** HUD (click an element, send a note) | Missing | Dashboard is read-only over runs |

`argus verify <url>` is the automatic project-level gate: smoke checks, the
full accessibility/performance/link/visual audit, and every saved flow run
together. CI additionally exercises the real MCP executable, current Reticle
flow import, API authorization, tenant isolation, CLI behavior, and the live
Cloudflare browser fleet.
