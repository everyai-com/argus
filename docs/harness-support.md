# Harness support

Argus ships **two** MCP servers over the same tool surface: a **remote**
streamable-HTTP endpoint on the Worker at `<origin>/mcp` (recommended — connect by
URL, no checkout; flows live server-side per tenant), and a **local stdio** server
(`packages/mcp`) for harnesses that want a local process or repo-committed flows.
`packages/cli/src/harness.ts` is the single source of truth for the stdio wiring;
`argus init` drives it.

## Matrix

| Harness | MCP config file | Config shape | Instruction file | Auto-wired by `argus init` |
|---|---|---|---|---|
| **Any remote MCP client** | harness-specific | `{"type":"http","url":"<origin>/mcp","headers":{"Authorization":"Bearer <token>"}}` | `AGENTS.md` (the agent writes it) | connect by URL — nothing to wire |
| Claude Code | `.mcp.json` (project) | `mcpServers` | `CLAUDE.md` | always |
| Cursor | `.cursor/mcp.json` | `mcpServers` | `.cursor/rules/argus.mdc` | when `.cursor/` exists, or `--harness all` |
| VS Code / Copilot | `.vscode/mcp.json` | `servers` + `type: stdio` | `.github/copilot-instructions.md` | when `.vscode/` exists, or `--harness all` |
| Codex CLI | `~/.codex/config.toml` (global) | TOML `[mcp_servers.argus]` | `AGENTS.md` | snippet printed; written with `--write-global` |
| Any `AGENTS.md` reader (Codex, Cursor, Copilot, Gemini CLI, Zed, Amp, Cline, Windsurf) | — | — | `AGENTS.md` | always |
| Remote MCP clients | provider-specific | `url` / `type: http` | — | this is the canonical deployment shape |

`argus init <api-url> <token> [--harness claude,cursor,vscode,agents,codex|all] [--write-global]`

- Default: `claude` + `agents`, plus `cursor`/`vscode` when their dirs exist.
- `--harness all`: every harness above.
- All writers are idempotent and merge into existing files — a second run is a
  no-op and unrelated keys are preserved.
- Global configs (Codex `~/.codex/config.toml`) are only touched with
  `--write-global`; otherwise the ready snippet is printed.

## Snippets

Replace `<repo>` with the path to this checkout; the built server lives at
`packages/mcp/dist/index.js`.

**stdio server** — Claude Code `.mcp.json`, Cursor `.cursor/mcp.json`:

```json
{ "mcpServers": { "argus": { "command": "node", "args": ["<repo>/packages/mcp/dist/index.js"] } } }
```

VS Code / Copilot `.vscode/mcp.json`:

```json
{ "servers": { "argus": { "type": "stdio", "command": "node", "args": ["<repo>/packages/mcp/dist/index.js"] } } }
```

Codex CLI `~/.codex/config.toml`:

```toml
[mcp_servers.argus]
command = "node"
args = ["<repo>/packages/mcp/dist/index.js"]
```

**Remote (streamable-http) server** — used by hosted servers like agentprofile
and talltrack:

```json
{ "mcpServers": { "name": { "type": "http", "url": "https://…/mcp" } } }
```

## Three layers of portability

1. **Config** — the snippets above (written by `argus init`).
2. **Instructions** — the MCP server returns a lifecycle summary as
   `instructions` on `initialize` (`packages/mcp/src/index.ts`), so any client
   that surfaces it needs no file at all. Harnesses that read `AGENTS.md` get the
   fuller standing-verification block.
3. **Skill** — the exploration protocol is harness-neutral in
   `skills/argus-explore/SKILL.md`; Claude Code loads it through the shim at
   `.claude/skills/argus-explore/SKILL.md`.

## AGENTS.md

Every repo in the stack carries a root `AGENTS.md` as its canonical agent file.
Where a repo also has a `CLAUDE.md`, that file imports the same content
(`@AGENTS.md`) rather than duplicating it, so the two can't drift.
