# Reticle compatibility

Argus carries Reticle's verification discipline into a remote, multi-tenant
Cloudflare execution plane. It does not fork Reticle or duplicate its framework
packages.

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
| App signals and state | `@argus/sdk` | Native Argus protocol |
| React/Next/Vite instrumentation | `@argus/sdk/vite` or Reticle packages | Integration boundary |
| Electron/native desktop capture | Reticle Electron package | Upstream-only |
| Babel and ESLint authoring plugins | Reticle packages | Upstream-only |

`argus verify <url>` is the automatic project-level gate: smoke checks, the
full accessibility/performance/link/visual audit, and every saved flow run
together. CI additionally exercises the real MCP executable, current Reticle
flow import, API authorization, tenant isolation, CLI behavior, and the live
Cloudflare browser fleet.
