# Start here

**One link, one question. Give this to your coding agent:**

```
Read https://raw.githubusercontent.com/everyai-com/argus/main/START.md and do exactly what it says.
```

No clone. No install. No config to copy.

---

## If you are the agent reading this

Argus is a **remote MCP service**: a real cloud Chromium plus deterministic flow replay. You connect
to a URL and get `argus_*` tools. Your job is to take this project to a **verdict**, then keep it green.

**Ask the human exactly one question, once:** their **Argus MCP URL and token**. Nothing else.

- The URL is their Argus deployment + `/mcp` (e.g. `https://argus-cloud.<account>.workers.dev/mcp`).
- The token is their Argus tenant token (starts with `argus_` or is the admin token).
- **No token yet?** Tell the human to open their Argus URL, click the **Account** tab, sign up
  (email + password) and press **Create MCP token** — it shows the token once with the exact config
  to paste. Then continue here.

If they don't have one, see "Deploy an Argus once" at the bottom (needs a paid Cloudflare Workers plan).

### 1. Connect (no checkout)

**Claude Code / Cursor** — `.cursor/mcp.json` or `.mcp.json`:

```json
{ "mcpServers": { "argus": {
  "type": "http",
  "url": "<ARGUS_MCP_URL>",
  "headers": { "Authorization": "Bearer <TOKEN>" }
} } }
```

**VS Code / Copilot** — `.vscode/mcp.json`:

```json
{ "servers": { "argus": {
  "type": "http",
  "url": "<ARGUS_MCP_URL>",
  "headers": { "Authorization": "Bearer <TOKEN>" }
} } }
```

**Codex CLI**:

```bash
export ARGUS_TOKEN="<TOKEN>"
codex mcp add argus --url <ARGUS_MCP_URL> --bearer-token-env-var ARGUS_TOKEN
```

Then **restart the client** so it picks the server up, and confirm the `argus_*` tools are listed.
Also write the project's standing rules into `AGENTS.md` (any AGENTS.md-reading harness gets them).

### 2. Drive it to a verdict

1. **See it load.** `argus_smoke { url }` — load, console/network clean, responsive, screenshots.
   For a local app, expose it first (`cloudflared tunnel --url http://localhost:<port>`) and use the
   tunnel URL.
2. **Find what matters.** `argus_sessions`, then `argus_lease { url }`, `argus_query { interactive: true }`,
   `argus_act_batch` to drive, `argus_observe` for the network/console/stream truth.
3. **Assert a consequence.** `argus_assert` with predicates — `network` (status + cardinality),
   `route`, `console-clean`, `stream`, `storage`, and (with the app's SDK) `signal`/`state`.
   Compose with `allOf`/`anyOf`. This is the verdict.
4. **Save it.** `argus_record start` → drive → `argus_record stop` → `argus_flow_save` with per-step
   `expect` and a `success` oracle. Flows are stored **server-side for this tenant** — no files needed.
5. **Re-verify forever.** `argus_flow_verify` replays every saved flow in parallel, deterministically,
   with no model in the loop. Run it after every change.

### 3. The loop — this is the whole product

```
verify (argus_flow_verify / argus_assert)  →  read each failure's → next action  →  fix  →  verify again  →  …  →  green
```

Rules you may never break:
- **Never weaken a check to make it pass.** If an anchor or assertion is wrong, fix the flow or the
  app — not the expectation.
- **Only `argus_assert` and flow `expect`/`success` produce a verdict.** `argus_act` proves nothing.
- A verdict reports the **weakest** tier it rests on (signal > consequence > dom > visual). Missing
  evidence is `coverage: partial` — never a pass.
- `argus_release` every session when the loop ends.

### When it fights you

| You see | Do this |
|---|---|
| `401 unauthorized` | the token is wrong or missing — ask the human |
| `argus_*` tools missing | restart the client; the MCP config is read at startup |
| `Blocked request … host not allowed` | add `server.allowedHosts: [".trycloudflare.com"]` to Vite |
| `missing environment values: FOO` | export `FOO` or ask the human — never hard-code a secret |
| `auth profile … not found` | run the login flow (the one with `saveAuthAs`) first |
| `@argus/sdk is not loaded` | you asserted a `signal`/`state` without the app's SDK — assert `network`/`route` instead, or install it |
| `no saved flows` | record one (`argus_record` → `argus_flow_save`) |
| `anchor did not resolve` | re-record the flow; anchors are errors by design, never guesses |
| `429 fleet_saturated` | release sessions, or lower concurrency |
| `coverage: partial` | report it as partial, never as a pass |

### Optional: local CLI, for CI or repo-committed flows

Only if you want flows reviewed in git or a CI gate:

```bash
git clone https://github.com/everyai-com/argus.git ~/.argus-src
cd ~/.argus-src && pnpm install && pnpm check
node ~/.argus-src/packages/cli/dist/index.js onboard <API_URL> <TOKEN> --url <app-url>
```

### Deploy an Argus once (only if the human has none)

Needs a paid Cloudflare Workers plan (Browser Rendering):

```bash
git clone https://github.com/everyai-com/argus.git ~/.argus-src && cd ~/.argus-src
pnpm install && pnpm check
cd packages/cloud
wrangler secret put ARGUS_TOKEN     # the API fails closed without it
wrangler deploy                     # prints the API URL; the MCP endpoint is <url>/mcp
```

### Definition of done

You drove a real flow through the remote MCP and returned a verdict: green, or a precise statement of
what is still failing and why. A pile of config is not "done".
