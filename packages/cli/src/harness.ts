/**
 * Harness wiring — register the argus MCP server (and its standing
 * verification instructions) in whichever agent harness a project uses.
 *
 * The MCP server itself is plain stdio and therefore portable; this module
 * exists because every harness reads a *different* config file:
 *
 *   Claude Code  .mcp.json            { mcpServers: { argus: { command, args } } }
 *   Cursor       .cursor/mcp.json     { mcpServers: { argus: { command, args } } }
 *   VS Code      .vscode/mcp.json     { servers: { argus: { type: "stdio", command, args } } }
 *   Codex CLI    ~/.codex/config.toml [mcp_servers.argus] command / args
 *
 * All writers are idempotent and merge into existing files, so running
 * `argus init` twice is safe and unrelated keys are never clobbered.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export interface McpStdioSpec {
  command: string;
  args: string[];
}

export type HarnessId = "claude" | "cursor" | "vscode" | "agents" | "codex";

export interface Harness {
  id: HarnessId;
  label: string;
  /** Whether this harness looks present in the project. */
  detect(cwd: string): boolean;
  /** Wire it up; returns absolute paths written. */
  write(cwd: string, spec: McpStdioSpec): string[];
}

export interface WireOptions {
  /** "all", a comma-separated list of ids, or undefined for auto-detect. */
  harnesses?: string;
  /** Write global configs (Codex ~/.codex/config.toml) instead of printing. */
  writeGlobal?: boolean;
}

export interface WireResult {
  harnesses: HarnessId[];
  written: string[];
  unchanged: string[];
  notes: string[];
}

/** Standing instructions, shared by every instruction-file writer. */
export const VERIFICATION_MARKER = "## Verification (Argus)";

export const VERIFICATION_SECTION = `## Verification (Argus)

This project is wired to Argus (cloud verification). After ANY change to UI,
routes, API handlers, or user-facing behavior — before declaring the work done:

1. If the app runs locally, ensure a tunnel is up (\`argus tunnel <port>\`).
2. Run \`argus_flow_verify\` (MCP) to replay all saved flows. Fix every failure
   from its decision envelope (whatChanged → nextAction), then re-verify.
3. Run \`argus_audit\` on changed pages — treat critical/major findings
   (a11y, visual diff, perf) as part of the task, not follow-ups.
4. When you build a NEW user-facing feature, drive it once with argus tools
   under \`argus_record\`, then \`argus_flow_save\` with network/route success
   predicates — the test suite must grow with the app.
5. Flows may use \`\${VAR}\` placeholders for test logins/URLs — they resolve
   from the environment at replay time. If a replay reports missing values,
   ASK THE USER for them (never invent or hard-code secrets in flow files).
6. A task is only done when flows pass with consequence-tier evidence.
`;

export const ALL_HARNESS_IDS: HarnessId[] = ["claude", "cursor", "vscode", "agents", "codex"];

/** The built argus-mcp entrypoint that ships alongside this CLI build. */
export function mcpServerPath(metaUrl: string = import.meta.url): string {
  return join(dirname(fileURLToPath(metaUrl)), "..", "..", "mcp", "dist", "index.js");
}

// --- writers ----------------------------------------------------------------

/** Append `block` to `file` unless `marker` is already present. */
function upsertSection(file: string, marker: string, block: string): boolean {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (existing.includes(marker)) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, existing.trim() ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`);
  return true;
}

/** Merge `{ [key]: entry }` into `obj[group]` in a JSON file, idempotently. */
function upsertJsonGroup(file: string, group: string, key: string, entry: unknown): boolean {
  const data: Record<string, Record<string, unknown>> = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : {};
  data[group] = data[group] ?? {};
  if (data[group]![key]) return false;
  data[group]![key] = entry;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return true;
}

function stdioEntry(spec: McpStdioSpec): Record<string, unknown> {
  return { command: spec.command, args: spec.args };
}

/** TOML block for Codex CLI (~/.codex/config.toml). */
export function codexSnippet(spec: McpStdioSpec): string {
  const args = spec.args.map((a) => JSON.stringify(a)).join(", ");
  return `[mcp_servers.argus]\ncommand = ${JSON.stringify(spec.command)}\nargs = [${args}]\n`;
}

const HARNESSES: Record<HarnessId, Harness> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    detect: (cwd) =>
      existsSync(join(cwd, ".mcp.json")) ||
      existsSync(join(cwd, "CLAUDE.md")) ||
      existsSync(join(cwd, ".claude")),
    write: (cwd, spec) => {
      const files: string[] = [];
      const config = join(cwd, ".mcp.json");
      if (upsertJsonGroup(config, "mcpServers", "argus", stdioEntry(spec))) files.push(config);
      const instructions = join(cwd, "CLAUDE.md");
      if (upsertSection(instructions, VERIFICATION_MARKER, VERIFICATION_SECTION)) files.push(instructions);
      return files;
    },
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    detect: (cwd) => existsSync(join(cwd, ".cursor")),
    write: (cwd, spec) => {
      const files: string[] = [];
      const config = join(cwd, ".cursor", "mcp.json");
      if (upsertJsonGroup(config, "mcpServers", "argus", stdioEntry(spec))) files.push(config);
      const rule = join(cwd, ".cursor", "rules", "argus.mdc");
      const block = `---\ndescription: Argus cloud verification — verify UI/routes/API changes before declaring done\nalwaysApply: true\n---\n\n${VERIFICATION_SECTION}`;
      if (upsertSection(rule, VERIFICATION_MARKER, block)) files.push(rule);
      return files;
    },
  },
  vscode: {
    id: "vscode",
    label: "VS Code / Copilot",
    detect: (cwd) =>
      existsSync(join(cwd, ".vscode")) || existsSync(join(cwd, ".github", "copilot-instructions.md")),
    write: (cwd, spec) => {
      const files: string[] = [];
      const config = join(cwd, ".vscode", "mcp.json");
      const entry = { type: "stdio", ...stdioEntry(spec) };
      if (upsertJsonGroup(config, "servers", "argus", entry)) files.push(config);
      const instructions = join(cwd, ".github", "copilot-instructions.md");
      if (upsertSection(instructions, VERIFICATION_MARKER, VERIFICATION_SECTION)) files.push(instructions);
      return files;
    },
  },
  agents: {
    id: "agents",
    label: "Codex / AGENTS.md (any AGENTS.md reader)",
    detect: () => true,
    write: (cwd, _spec) => {
      const file = join(cwd, "AGENTS.md");
      return upsertSection(file, VERIFICATION_MARKER, VERIFICATION_SECTION) ? [file] : [];
    },
  },
  codex: {
    id: "codex",
    label: "Codex CLI (~/.codex/config.toml)",
    detect: (cwd) => existsSync(join(cwd, ".codex")) || existsSync(join(homedir(), ".codex")),
    write: (cwd, spec) => {
      // Codex reads a single GLOBAL config; only touch it when explicitly asked.
      const file = join(homedir(), ".codex", "config.toml");
      const block = codexSnippet(spec);
      if (existsSync(file) && readFileSync(file, "utf8").includes("[mcp_servers.argus]")) return [];
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${existsSync(file) && readFileSync(file, "utf8").trim() ? "\n" : ""}${block}`);
      return [file];
    },
  },
};

/** Which harnesses to wire, given a selection string and what's detected. */
export function resolveHarnesses(cwd: string, selection?: string): HarnessId[] {
  if (selection === "all") return [...ALL_HARNESS_IDS];
  if (selection) {
    const ids = selection
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const unknown = ids.filter((id) => !(id in HARNESSES));
    if (unknown.length) {
      throw new Error(`unknown harness: ${unknown.join(", ")} (expected ${ALL_HARNESS_IDS.join(", ")})`);
    }
    return ids as HarnessId[];
  }
  // Auto: Claude Code + the portable AGENTS.md always; others when detected.
  const detected: HarnessId[] = ["claude", "agents"];
  for (const id of ["cursor", "vscode"] as HarnessId[]) {
    if (HARNESSES[id].detect(cwd)) detected.push(id);
  }
  return detected;
}

/**
 * Wire the MCP server + verification instructions into every selected harness.
 * Returns what was written, what was already present, and any snippet to show.
 */
export function wireHarnesses(cwd: string, spec: McpStdioSpec, opts: WireOptions = {}): WireResult {
  const ids = resolveHarnesses(cwd, opts.harnesses);
  const result: WireResult = { harnesses: ids, written: [], unchanged: [], notes: [] };
  for (const id of ids) {
    const harness = HARNESSES[id];
    if (id === "codex" && !opts.writeGlobal) {
      result.notes.push(`Codex CLI is global — add this to ~/.codex/config.toml (or re-run with --write-global):\n\n${codexSnippet(spec)}`);
      continue;
    }
    const before = result.written.length;
    const files = harness.write(cwd, spec);
    result.written.push(...files);
    if (result.written.length === before) result.unchanged.push(harness.label);
  }
  return result;
}
