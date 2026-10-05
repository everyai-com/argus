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
 * `argus init` twice is safe and unrelated keys are never clobbered. An entry
 * that points somewhere else (a moved checkout, a stale path) is refreshed;
 * a config we can't parse is left alone and reported instead.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export interface McpStdioSpec {
  command: string;
  args: string[];
}

export type HarnessId = "claude" | "cursor" | "vscode" | "gemini" | "agents" | "codex";

export const ALL_HARNESS_IDS: HarnessId[] = ["claude", "cursor", "vscode", "gemini", "agents", "codex"];

/** What one harness writer did. */
interface HarnessWrite {
  /** Absolute paths created or updated. */
  files: string[];
  /** Manual follow-ups (a config we refused to touch, a global file). */
  notes: string[];
}

export interface Harness {
  id: HarnessId;
  label: string;
  /** Whether this harness looks present in the project. */
  detect(cwd: string): boolean;
  /** Wire it up. */
  write(cwd: string, spec: McpStdioSpec): HarnessWrite;
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

export interface InitArgs {
  apiUrl: string;
  token: string;
  harnesses?: string;
  writeGlobal: boolean;
}

export const INIT_USAGE =
  "argus init <api-url> <token> [--harness claude,cursor,vscode,gemini,agents,codex|all] [--write-global]";

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

/** The built argus-mcp entrypoint that ships alongside this CLI build. */
export function mcpServerPath(metaUrl: string = import.meta.url): string {
  return join(dirname(fileURLToPath(metaUrl)), "..", "..", "mcp", "dist", "index.js");
}

// --- args -------------------------------------------------------------------

/** Parse a `--harness` selection: "all" or a comma-separated list of ids. */
export function parseHarnessSelection(selection: string): HarnessId[] {
  if (selection === "all") return [...ALL_HARNESS_IDS];
  const ids = selection
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) {
    throw new Error(`empty --harness selection (expected ${ALL_HARNESS_IDS.join(", ")}, or "all")`);
  }
  const unknown = ids.filter((id) => !ALL_HARNESS_IDS.includes(id as HarnessId));
  if (unknown.length) {
    throw new Error(`unknown harness: ${unknown.join(", ")} (expected ${ALL_HARNESS_IDS.join(", ")})`);
  }
  return ids as HarnessId[];
}

/**
 * Parse `argus init` argv (everything after the command). Flags are consumed
 * with their value wherever they appear, so `argus init <api> <token>` works
 * with or without them.
 */
export function parseInitArgs(argv: string[]): { ok: true; args: InitArgs } | { ok: false; error: string } {
  const positional: string[] = [];
  let harnesses: string | undefined;
  let writeGlobal = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--harness") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) return { ok: false, error: `--harness needs a value — usage: ${INIT_USAGE}` };
      try {
        parseHarnessSelection(value);
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
      harnesses = value;
    } else if (arg === "--write-global") {
      writeGlobal = true;
    } else if (arg.startsWith("-")) {
      return { ok: false, error: `unknown flag: ${arg} — usage: ${INIT_USAGE}` };
    } else {
      positional.push(arg);
    }
  }

  const [apiUrl, token, ...extra] = positional;
  if (!apiUrl || !token || extra.length) return { ok: false, error: `usage: ${INIT_USAGE}` };
  return { ok: true, args: { apiUrl, token, harnesses, writeGlobal } };
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

/** True when `existing` already registers this spec (relative args resolve from `cwd`). */
function sameStdioEntry(existing: unknown, spec: McpStdioSpec, cwd: string): boolean {
  if (!existing || typeof existing !== "object") return false;
  const entry = existing as { command?: unknown; args?: unknown };
  if (entry.command !== spec.command || !Array.isArray(entry.args)) return false;
  const args: unknown[] = entry.args;
  if (args.length !== spec.args.length) return false;
  return spec.args.every((arg, i) => {
    const found = args[i];
    return typeof found === "string" && resolve(cwd, found) === resolve(cwd, arg);
  });
}

interface MergeResult {
  changed: boolean;
  /** Why the file was left alone instead of merged. */
  blocked?: string;
}

/** Returns the value to store at a path, or "current" to leave the file untouched. */
type ValueResolver = (existing: unknown) => unknown | "current";

/** Read `path` out of a JSON file, or undefined when it's missing/unreadable. */
function readJsonPath(file: string, path: string[]): unknown {
  let node: unknown;
  try {
    node = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  for (const key of path) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * Merge a value at `path` in a JSON file, idempotently: a value the resolver
 * accepts is left as-is, a new one is written, and a config we can't safely
 * edit (not plain JSON, wrong shape) is never clobbered.
 */
function upsertJsonPath(file: string, path: string[], resolve: ValueResolver): MergeResult {
  let data: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { changed: false, blocked: `${file} is not a JSON object` };
      }
      data = parsed as Record<string, unknown>;
    } catch {
      return { changed: false, blocked: `${file} is not plain JSON (comments?)` };
    }
  }

  let node = data;
  for (const key of path.slice(0, -1)) {
    const child = node[key];
    if (child === undefined) {
      node = node[key] = {};
      continue;
    }
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      return { changed: false, blocked: `${file} has a non-object "${key}"` };
    }
    node = child as Record<string, unknown>;
  }

  const leaf = path[path.length - 1]!;
  const value = resolve(node[leaf]);
  if (value === "current") return { changed: false };
  node[leaf] = value;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return { changed: true };
}

/** What the user should paste when we couldn't merge their config for them. */
function manualSnippet(file: string, blocked: string, path: string[], value: unknown): string {
  const nested = path
    .slice(0, -1)
    .reverse()
    .reduce<unknown>((acc, key) => ({ [key]: acc }), { [path[path.length - 1]!]: value });
  return `${file} was left alone (${blocked}) — add this by hand:\n\n${JSON.stringify(nested, null, 2)}`;
}

function stdioEntry(spec: McpStdioSpec): Record<string, unknown> {
  return { command: spec.command, args: spec.args };
}

/** TOML block for Codex CLI (~/.codex/config.toml). */
export function codexSnippet(spec: McpStdioSpec): string {
  const args = spec.args.map((a) => JSON.stringify(a)).join(", ");
  return `[mcp_servers.argus]\ncommand = ${JSON.stringify(spec.command)}\nargs = [${args}]\n`;
}

function mergeWrites(...writes: HarnessWrite[]): HarnessWrite {
  return { files: writes.flatMap((w) => w.files), notes: writes.flatMap((w) => w.notes) };
}

/** Register the MCP server in a harness config file, merging idempotently. */
function wireMcpConfig(
  cwd: string,
  file: string,
  path: string[],
  entry: Record<string, unknown>,
  spec: McpStdioSpec
): HarnessWrite {
  const merged = upsertJsonPath(file, path, (existing) =>
    sameStdioEntry(existing, spec, cwd) ? "current" : entry
  );
  return {
    files: merged.changed ? [file] : [],
    notes: merged.blocked ? [manualSnippet(file, merged.blocked, path, entry)] : [],
  };
}

/** Add the standing verification block to an instruction file. */
function wireSection(file: string, block = VERIFICATION_SECTION): HarnessWrite {
  return { files: upsertSection(file, VERIFICATION_MARKER, block) ? [file] : [], notes: [] };
}

const HARNESSES: Record<HarnessId, Harness> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    detect: (cwd) =>
      existsSync(join(cwd, ".mcp.json")) ||
      existsSync(join(cwd, "CLAUDE.md")) ||
      existsSync(join(cwd, ".claude")),
    write: (cwd, spec) =>
      mergeWrites(
        wireMcpConfig(cwd, join(cwd, ".mcp.json"), ["mcpServers", "argus"], stdioEntry(spec), spec),
        wireSection(join(cwd, "CLAUDE.md"))
      ),
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    detect: (cwd) => existsSync(join(cwd, ".cursor")),
    write: (cwd, spec) => {
      const rule = join(cwd, ".cursor", "rules", "argus.mdc");
      const block = `---\ndescription: Argus cloud verification — verify UI/routes/API changes before declaring done\nalwaysApply: true\n---\n\n${VERIFICATION_SECTION}`;
      return mergeWrites(
        wireMcpConfig(cwd, join(cwd, ".cursor", "mcp.json"), ["mcpServers", "argus"], stdioEntry(spec), spec),
        wireSection(rule, block)
      );
    },
  },
  vscode: {
    id: "vscode",
    label: "VS Code / Copilot",
    detect: (cwd) =>
      existsSync(join(cwd, ".vscode")) || existsSync(join(cwd, ".github", "copilot-instructions.md")),
    write: (cwd, spec) =>
      mergeWrites(
        wireMcpConfig(
          cwd,
          join(cwd, ".vscode", "mcp.json"),
          ["servers", "argus"],
          { type: "stdio", ...stdioEntry(spec) },
          spec
        ),
        wireSection(join(cwd, ".github", "copilot-instructions.md"))
      ),
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    detect: (cwd) => existsSync(join(cwd, ".gemini")),
    // Gemini CLI reads GEMINI.md unless its settings point context.fileName at
    // AGENTS.md, so it shares the canonical file instead of a second copy.
    // A value the project already set is respected, never overwritten.
    write: (cwd) => {
      const file = join(cwd, ".gemini", "settings.json");
      const configured = existsSync(file) ? readJsonPath(file, ["context", "fileName"]) : undefined;
      const merge = upsertJsonPath(file, ["context", "fileName"], (existing) => {
        if (existing === undefined || existing === "") return "AGENTS.md";
        if (existing === "AGENTS.md") return "current";
        if (Array.isArray(existing)) return existing.includes("AGENTS.md") ? "current" : [...existing, "AGENTS.md"];
        return "current";
      });

      const notes: string[] = [];
      if (merge.blocked) {
        notes.push(manualSnippet(file, merge.blocked, ["context", "fileName"], "AGENTS.md"));
      } else if (!merge.changed && typeof configured === "string" && configured !== "AGENTS.md") {
        notes.push(
          `${file} keeps context.fileName "${configured}" — Gemini CLI won't read AGENTS.md until it lists "AGENTS.md" too.`
        );
      }
      return { files: merge.changed ? [file] : [], notes };
    },
  },
  agents: {
    id: "agents",
    label: "Codex / AGENTS.md (any AGENTS.md reader)",
    detect: () => true,
    write: (cwd) => wireSection(join(cwd, "AGENTS.md")),
  },
  codex: {
    id: "codex",
    label: "Codex CLI (~/.codex/config.toml)",
    detect: (cwd) => existsSync(join(cwd, ".codex")) || existsSync(join(homedir(), ".codex")),
    write: (_cwd, spec) => {
      // Codex reads a single GLOBAL config; only touch it when explicitly asked.
      const file = join(homedir(), ".codex", "config.toml");
      const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (existing.includes("[mcp_servers.argus]")) return { files: [], notes: [] };
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${existing.trim() ? "\n" : ""}${codexSnippet(spec)}`);
      return { files: [file], notes: [] };
    },
  },
};

/** Which harnesses to wire, given a selection string and what's detected. */
export function resolveHarnesses(cwd: string, selection?: string): HarnessId[] {
  if (selection) return parseHarnessSelection(selection);
  // Auto: Claude Code + the portable AGENTS.md always; others when detected.
  const detected: HarnessId[] = ["claude", "agents"];
  for (const id of ["cursor", "vscode", "gemini"] as HarnessId[]) {
    if (HARNESSES[id].detect(cwd)) detected.push(id);
  }
  return detected;
}

/**
 * Wire the MCP server + verification instructions into every selected harness.
 * Returns what was written, what was already correct, and any manual follow-up.
 */
export function wireHarnesses(cwd: string, spec: McpStdioSpec, opts: WireOptions = {}): WireResult {
  const ids = resolveHarnesses(cwd, opts.harnesses);
  const result: WireResult = { harnesses: ids, written: [], unchanged: [], notes: [] };
  for (const id of ids) {
    const harness = HARNESSES[id];
    if (id === "codex" && !opts.writeGlobal) {
      result.notes.push(
        `Codex CLI is global — add this to ~/.codex/config.toml (or re-run with --write-global):\n\n${codexSnippet(spec)}`
      );
      continue;
    }
    const before = result.written.length;
    const { files, notes } = harness.write(cwd, spec);
    result.written.push(...files);
    result.notes.push(...notes);
    if (result.written.length === before) result.unchanged.push(harness.label);
  }
  return result;
}
