---
name: install-and-verify
description: Set up Argus for a project and produce a first verdict — point at an Argus API, wire every harness, drive one real flow, save it as a replayable flow. Use when asked to install Argus, wire a project for verification, or check an app end-to-end for the first time.
---

# Install and verify with Argus

Follow the critical path in [`SKILL.md`](../../SKILL.md) — it is the whole setup,
and its one hard rule is: **installed means a verdict was produced.** Do not report
success after writing config files.

1. Get an Argus API (deploy the Worker, or use a shared instance) and a token.
2. `argus init <api-url> <token> --harness all` — writes `.argus/config.json`,
   registers the MCP server in every detected harness, and adds the standing
   verification steps to `AGENTS.md` / `CLAUDE.md`. Restart the client.
3. Point at a running app (`argus tunnel <port>` for local, or the deployed URL).
4. Drive one real flow and `argus_assert` the consequence; save it with
   `argus_record` + `argus_flow_save`.
5. Report the verdict — pass, fail, or `coverage: partial`. Never a quiet pass.
