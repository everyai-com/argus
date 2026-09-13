# Agent setup prompt — wire a project to Argus

Paste everything below into your coding agent (Claude Code, Codex, Cursor, Copilot, Gemini CLI,
Windsurf — anything with a shell and MCP) while its working directory is the project you want
verified. It is self-contained: the agent does not need the Argus repo's docs.

---

## Copy from here

You are setting up **Argus**, a self-hosted cloud verification platform, for this repository. Argus
runs real Chromium on Cloudflare and gives you `argus_*` MCP tools to drive the app, read program
truth (network, console, route, WebSocket/SSE, storage, and — with the SDK — app signals, store
state and React commits), and replay deterministic flows.

**Definition of done — do not report success before this:** you have driven one real user flow in
this app and returned a verdict (pass / fail / `coverage: partial`). Writing config files is not
"installed". If you cannot reach a verdict, say exactly which step failed and why.

Ask me for anything you need (API URL, token, app URL, test credentials) in ONE question, then
continue. Never invent or hard-code secrets, and never put a token in a committed file.

### 0. Prerequisites (confirm, don't assume)

- An **Argus API URL** and **token**. If I haven't given you one, ask; or deploy one from an Argus
  checkout (`<ARGUS_REPO>`):
  ```bash
  cd <ARGUS_REPO> && pnpm install && pnpm check
  cd packages/cloud
  wrangler secret put ARGUS_TOKEN        # required — the API fails closed (401) without it
  wrangler deploy                        # note the printed https://…workers.dev URL
  ```
  Cloudflare **Browser Rendering requires a paid Workers plan**.
- **Node ≥ 20**, and `cloudflared` if the app runs locally (`brew install cloudflared`, or the
  binary from Cloudflare). Without it tunnelling fails with an install hint.
- The Argus CLI/MCP are **not on npm**. Run them from the checkout:
  `node <ARGUS_REPO>/packages/cli/dist/index.js …`

### 1. Wire this project

```bash
node <ARGUS_REPO>/packages/cli/dist/index.js init <API_URL> <TOKEN> --harness all
```

This writes `.argus/config.json` (gitignored), `.argus/flows/`, registers the MCP server for the
harnesses it finds (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`), and appends the standing
verification steps to `AGENTS.md` / `CLAUDE.md`. Commit `.argus/flows/` and those instruction files;
never commit `.argus/config.json`.

**Restart the client so it picks up the new MCP server.** Confirm the `argus_*` tools are listed; if
they aren't, the server list was read at startup and only a restart reloads it.

### 2. Verify with zero app changes (do this first)

- Deployed app: use its URL. Local app: expose it — `argus tunnel <port>` (or
  `argus test --local <port>`), and use the tunnel URL it prints. A fresh `*.trycloudflare.com`
  hostname takes ~10s to resolve at the edge; the CLI polls, so wait rather than retrying.
- If this is a Cloudflare Workers + Hono + React/Vite + better-auth app, generate the baseline
  suite: `argus preset cf-saas <app-url>`. It probes in a real browser (an SPA answers 200 for every
  path, so it refuses to invent routes) and skips anything unconfirmed.
- Otherwise discover flows by driving the app with `argus_lease` → `argus_query {interactive:true}` →
  `argus_act_batch`, then `argus_record start` → drive → `stop` → `argus_flow_save`.
- Then run the whole gate: `node <ARGUS_REPO>/packages/cli/dist/index.js verify <app-url>` — smoke +
  audit + every saved flow, non-zero exit on failure.

Every flow's `expect` must name the network/route consequence the step causes (status + cardinality,
e.g. exactly one `POST 201`). A DOM-only check passes a silent 500.

### 3. Optional: tier-1 evidence (signals, store state, React commits)

Zero-install checks see the outside of the app. To assert on the app's own truth, install the SDK
from the checkout (it is not on npm):

```bash
npm i -D file:<ARGUS_REPO>/packages/sdk
```

```ts
// vite.config.ts
import { argus } from "@argus/sdk/vite";
export default defineConfig({ plugins: [react(), argus()] });
```

```ts
// app entry (dev only — the plugin injects the runtime, these calls are inert in production)
import { signal, registerStore } from "@argus/sdk";
registerStore("tasks", () => store.getState().tasks);   // or an adapter, see below
signal("task:added", { id });                            // declare what actually happened
```

Adapters (duck-typed, no extra deps): `registerObservableStore` (zustand/Redux),
`registerSvelteStore`, `registerPiniaStore`, `registerQueryClient` (TanStack Query cache). A React
commit stream is automatic: assert `{ "kind": "signal", "name": "react:storm", "maxCount": 0 }` to
fail on a render storm. Restart the dev server after editing config, then hard-reload the tab.

Then assert on it: `{ "kind": "signal", "name": "task:added", "minCount": 1 }` or
`{ "kind": "state", "store": "tasks", "path": "2", "equals": "Buy milk" }`. Predicates compose with
`allOf` / `anyOf`.

### 4. CI (optional, makes it automatic)

- GitHub App path: commit `.argus/platform.json` with either a `targetUrl` or
  `deployment.environments` (preview discovery) plus `checks: ["smoke","audit","flows"]`.
- Or a workflow that runs `argus verify <url>` on PRs with `ARGUS_API` + `ARGUS_TOKEN` secrets.

### Error catalogue — match the symptom, apply the fix

| Symptom | Cause | Fix |
|---|---|---|
| `401 Unauthorized` from the API | no/incorrect `ARGUS_TOKEN` | set `ARGUS_TOKEN` on the Worker (`wrangler secret put`); re-run `argus init` with the matching token |
| `argus_*` tools never appear | client read its MCP config at startup | restart the client; in Claude Code `/mcp` alone does not re-read the config |
| `could not start cloudflared … install it with: brew install cloudflared` | cloudflared missing | install cloudflared, or test a deployed URL instead |
| Tunnel URL 404s / connection refused right after starting | fresh `trycloudflare` hostname not resolved yet | wait ~10–30s; the CLI polls before proceeding |
| `Blocked request. This host is not allowed.` from the dev server | Vite host check | add `server.allowedHosts: [".trycloudflare.com"]` (and `preview.allowedHosts`) |
| `missing environment values: FOO — export them … and re-run` | flow uses `${FOO}` and it isn't set | export the value (seeded test user) or ask me — never hard-code it in the flow |
| `auth profile "default" not found for … — run the login flow (saveAuthAs) against this environment first` | authenticated flow ran before the login flow minted the profile | run the login flow (it has `saveAuthAs`) against the same origin first |
| Login fails only on a preview URL | app rejects untrusted origins (e.g. better-auth) | make the app trust its own preview origin, or test a stable environment |
| `@argus/sdk is not loaded in this page — add the Vite plugin` | `signal`/`state` predicate used without the SDK | install `@argus/sdk/vite`, add the plugin, restart the dev server, hard-reload |
| `no .argus/flows — run argus preset cf-saas <url> first` | gating with no flows | generate or record flows first |
| Flow fails on an anchor / `anchor did not resolve` | element moved or anchor is ambiguous | re-record, or run `argus_flow_heal` (propose) and review; anchors are errors by design, never guesses |
| Flow passes locally, fails on the preview | flow `startUrl` is stale | re-home with `argus verify <preview-url>` (`baseUrl` re-homes the suite); keep flows environment-agnostic |
| `429 fleet_saturated` | concurrent browser cap reached | release idle sessions (`argus_release` / `argus sessions`), reduce flow concurrency, or raise the tenant's `reserved`/`burst` |
| Lease expires mid-flow | lease TTL | keep leases ≤ 540s; stopwatches over 10 min exceed the browser keep-alive |
| `wrangler dev` never connects a browser | local runtime lacks the Browser Rendering binding | test against the deployed Worker (`--remote`), not local `wrangler dev` |
| Verdict says `coverage: partial` | evidence missing (evicted DO, blocked storage, out-of-band frame) | report it as partial; do not treat it as a pass |

### Rules you must keep

- A verdict reports the **weakest** evidence tier it rests on (signal > consequence > dom > visual).
  Never upgrade a tier. Missing evidence is `coverage: partial`, never a quiet pass.
- Unresolvable or ambiguous anchors are errors. Fix the anchor or re-record; never weaken a check to
  make it pass.
- Only `argus_assert` and a flow's `expect`/`success` produce a verdict — `argus_act` proves nothing.
- Release every session (`argus_release`) when done; one session per concurrent journey.
- Never commit `.argus/config.json`, tokens, or browser storage state.

## Copy to here
