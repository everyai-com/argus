# Argus

Argus is a **cloud verification platform**. It runs real Chromium on Cloudflare and exposes it to you as `argus_*` MCP tools: lease a browser, drive the app, read the network / console / route truth, assert with tiered evidence, and save deterministic flows that replay with **no model in the loop**.

Argus is **self-hosted**: you deploy the Worker to your own Cloudflare account (or point at a shared instance) and wire each project with `argus init`. There is no hosted signup.

This file is the critical path and nothing else. Everything it leaves out is in `docs/` and the README.

## Installed means a verdict was produced

Setup is not complete until you have **driven one real flow in the app and returned a verdict**. Writing config files is not installed. Do not tell the user Argus is set up until step 4 below produced a pass/fail.

## SETUP

1. **Get an Argus API.** In an Argus checkout: `pnpm install && pnpm check`, then
   `cd packages/cloud && wrangler secret put ARGUS_TOKEN && wrangler deploy`. Note the
   deployed URL and the token you set.
2. **Wire the project.** The fast path is one command:
   `node <ARGUS_REPO>/packages/cli/dist/index.js onboard <api-url> <token> --url <app-url>`
   (or `--local <port>` for a local app). It writes `.argus/config.json`, registers the MCP server in
   every harness it detects, tunnels a local app, and runs smoke + every saved flow to a verdict.
   Behind it: `init` writes the config and harness files, `--harness all` covers every harness,
   and `--write-global` also updates `~/.codex/config.toml`.
   **Restart the client** so it picks up the new MCP server.
3. **Point it at a running app.** Local → `argus tunnel <port>` (or `test --local <port>`)
   and use the tunnel URL. Deployed → use its URL directly.
4. **Produce a verdict — the gate.** Do not report success before this.

## VERIFY — the loop

Only `argus_assert` and a flow's `expect` / `success` predicates produce a verdict.
`argus_act` moves the app and **proves nothing**.

1. `argus_lease <url>` — each parallel agent or flow holds its **own** session.
2. `argus_query { interactive: true }` — the interactive surface, with refs.
3. Drive with `argus_act_batch`; read `argus_observe` for the network/console truth.
4. `argus_assert` with predicates over `network` / `route` / `console-clean` / `stream` / `storage` /
   `signal` / `state` / `visible` / `text`, composed with `allOf` / `anyOf`. Name the expected
   consequence **before** acting.
5. `argus_screenshot` and actually look — you are the visual judge.
6. `argus_record start` → drive → `stop` → `argus_flow_save` with per-step `expect` and a
   `success` oracle. That is the regression net.
7. Re-verify forever with `argus_flow_verify` — deterministic, no model, no flake.
8. `argus_release` every session when done.

## Rules

- A verdict reports the **weakest** evidence tier it rests on (signal > consequence > dom > visual). Never upgrade a tier.
- Unresolvable or ambiguous anchors are **errors**, not guesses.
- Missing evidence is `coverage: partial` — never a quiet pass.
- Flows may contain `${VAR}` placeholders resolved from the environment at replay time; a missing value means **ask the user**, never invent a secret.
- After any change to UI, routes, or API handlers, run `argus_flow_verify` + `argus_audit` before declaring the work done.

## Read more

- `docs/harness-support.md` — the per-harness wiring matrix.
- `README.md` — flows, auth profiles, the `cf-saas` preset, the deploy gate, the GitHub App.
- `skills/argus-explore/SKILL.md` — the full exploration protocol.
