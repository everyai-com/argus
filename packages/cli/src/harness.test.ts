import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexSnippet,
  parseInitArgs,
  resolveHarnesses,
  VERIFICATION_MARKER,
  wireHarnesses,
} from "./harness";

const spec = { command: "node", args: ["/opt/argus/mcp/dist/index.js"] };
const tmp = () => mkdtempSync(join(tmpdir(), "argus-harness-"));

describe("wireHarnesses", () => {
  it("writes each harness config in its native shape", () => {
    const cwd = tmp();
    wireHarnesses(cwd, spec, { harnesses: "claude,cursor,vscode,agents" });

    const claude = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
    expect(claude.mcpServers.argus).toEqual(spec);

    const cursor = JSON.parse(readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8"));
    expect(cursor.mcpServers.argus).toEqual(spec);

    const vscode = JSON.parse(readFileSync(join(cwd, ".vscode", "mcp.json"), "utf8"));
    expect(vscode.servers.argus).toEqual({ type: "stdio", ...spec });

    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toContain(VERIFICATION_MARKER);
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toContain(VERIFICATION_MARKER);
    expect(readFileSync(join(cwd, ".cursor", "rules", "argus.mdc"), "utf8")).toContain("alwaysApply: true");
    expect(readFileSync(join(cwd, ".github", "copilot-instructions.md"), "utf8")).toContain(VERIFICATION_MARKER);
  });

  it("is idempotent and preserves unrelated JSON keys", () => {
    const cwd = tmp();
    writeFileSync(
      join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } }, note: "keep" }, null, 2)
    );

    const first = wireHarnesses(cwd, spec, { harnesses: "claude,cursor,vscode,agents" });
    const snapshot = readFileSync(join(cwd, ".mcp.json"), "utf8");
    const second = wireHarnesses(cwd, spec, { harnesses: "claude,cursor,vscode,agents" });

    expect(first.written.length).toBeGreaterThan(0);
    expect(second.written).toEqual([]);
    expect(second.unchanged).toHaveLength(4);
    expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toBe(snapshot);

    const merged = JSON.parse(snapshot);
    expect(merged.note).toBe("keep");
    expect(merged.mcpServers.other).toEqual({ command: "x" });
  });

  it("refreshes wiring that points at a moved checkout", () => {
    const cwd = tmp();
    const moved = { command: "node", args: ["/Users/someone-else/argus/packages/mcp/dist/index.js"] };
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { argus: moved } }, null, 2));

    const result = wireHarnesses(cwd, spec, { harnesses: "claude" });

    expect(result.written).toContain(join(cwd, ".mcp.json"));
    expect(JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8")).mcpServers.argus).toEqual(spec);
    expect(wireHarnesses(cwd, spec, { harnesses: "claude" }).written).toEqual([]);
  });

  it("treats a relative path that resolves to the same server as current", () => {
    const cwd = tmp();
    writeFileSync(
      join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { argus: { command: "node", args: ["packages/mcp/dist/index.js"] } } }, null, 2)
    );

    // The committed .mcp.json in this repo uses a relative path — don't churn it.
    const before = readFileSync(join(cwd, ".mcp.json"), "utf8");
    const result = wireHarnesses(
      cwd,
      { command: "node", args: [join(cwd, "packages", "mcp", "dist", "index.js")] },
      { harnesses: "claude" }
    );
    expect(result.written).not.toContain(join(cwd, ".mcp.json"));
    expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toBe(before);
  });

  it("leaves an unparsable config alone and hands over a snippet", () => {
    const cwd = tmp();
    const jsonc = '{\n  // VS Code allows comments in here\n  "servers": {}\n}\n';
    mkdirSync(join(cwd, ".vscode"));
    writeFileSync(join(cwd, ".vscode", "mcp.json"), jsonc);

    const result = wireHarnesses(cwd, spec, { harnesses: "vscode" });

    expect(readFileSync(join(cwd, ".vscode", "mcp.json"), "utf8")).toBe(jsonc);
    expect(result.notes.join("\n")).toContain("add this by hand");
    expect(result.notes.join("\n")).toContain('"type": "stdio"');
  });

  it("never touches the global Codex config unless explicitly asked", () => {
    const cwd = tmp();
    const result = wireHarnesses(cwd, spec, { harnesses: "codex" });

    expect(result.written).toEqual([]);
    expect(result.notes.join("\n")).toContain("[mcp_servers.argus]");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
  });

  it("resolves the harness selection from flags and detection", () => {
    const cwd = tmp();
    expect(resolveHarnesses(cwd)).toEqual(["claude", "agents"]);

    mkdirSync(join(cwd, ".cursor"));
    mkdirSync(join(cwd, ".gemini"));
    expect(resolveHarnesses(cwd)).toEqual(["claude", "agents", "cursor", "gemini"]);

    expect(resolveHarnesses(cwd, "all")).toContain("codex");
    expect(resolveHarnesses(cwd, "vscode")).toEqual(["vscode"]);
    expect(() => resolveHarnesses(cwd, "bogus")).toThrow(/unknown harness/);
  });

  it("renders a Codex TOML snippet with quoted args", () => {
    expect(codexSnippet(spec)).toBe(
      '[mcp_servers.argus]\ncommand = "node"\nargs = ["/opt/argus/mcp/dist/index.js"]\n'
    );
  });
});

describe("gemini target", () => {
  const settings = (cwd: string) => JSON.parse(readFileSync(join(cwd, ".gemini", "settings.json"), "utf8"));

  it("points context.fileName at AGENTS.md and keeps the rest of the file", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".gemini"));
    writeFileSync(
      join(cwd, ".gemini", "settings.json"),
      JSON.stringify({ theme: "dark", context: { includeDirectories: ["src"] } }, null, 2)
    );

    const first = wireHarnesses(cwd, spec, { harnesses: "gemini,agents" });
    expect(first.written).toContain(join(cwd, ".gemini", "settings.json"));
    expect(settings(cwd).context.fileName).toBe("AGENTS.md");
    expect(settings(cwd).theme).toBe("dark");
    expect(settings(cwd).context.includeDirectories).toEqual(["src"]);

    const second = wireHarnesses(cwd, spec, { harnesses: "gemini,agents" });
    expect(second.written).toEqual([]);
    expect(second.notes).toEqual([]);
  });

  it("appends AGENTS.md instead of dropping a list of context files", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".gemini"));
    writeFileSync(
      join(cwd, ".gemini", "settings.json"),
      JSON.stringify({ context: { fileName: ["GEMINI.md"] } }, null, 2)
    );

    wireHarnesses(cwd, spec, { harnesses: "gemini" });

    expect(settings(cwd).context.fileName).toEqual(["GEMINI.md", "AGENTS.md"]);
  });

  it("respects an explicit GEMINI.md choice and reports it", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".gemini"));
    writeFileSync(
      join(cwd, ".gemini", "settings.json"),
      JSON.stringify({ context: { fileName: "GEMINI.md" } }, null, 2)
    );

    const result = wireHarnesses(cwd, spec, { harnesses: "gemini" });

    expect(result.written).toEqual([]);
    expect(settings(cwd).context.fileName).toBe("GEMINI.md");
    expect(result.notes.join("\n")).toContain("GEMINI.md");
  });
});

describe("parseInitArgs", () => {
  it("parses the credential-only form every harness documents", () => {
    expect(parseInitArgs(["https://argus.example", "tok"])).toEqual({
      ok: true,
      args: { apiUrl: "https://argus.example", token: "tok", harnesses: undefined, writeGlobal: false },
    });
  });

  it("accepts flags before, between, and after the positionals", () => {
    expect(parseInitArgs(["https://argus.example", "--harness", "cursor", "tok"])).toEqual({
      ok: true,
      args: { apiUrl: "https://argus.example", token: "tok", harnesses: "cursor", writeGlobal: false },
    });
    expect(parseInitArgs(["https://argus.example", "tok", "--harness", "all", "--write-global"])).toEqual({
      ok: true,
      args: { apiUrl: "https://argus.example", token: "tok", harnesses: "all", writeGlobal: true },
    });
  });

  it("reports usage instead of dropping a positional", () => {
    for (const argv of [
      ["https://argus.example"],
      ["https://argus.example", "tok", "extra"],
      ["https://argus.example", "tok", "--harness"],
      ["https://argus.example", "tok", "--harness", "bogus"],
      ["https://argus.example", "tok", "--nope"],
    ]) {
      const parsed = parseInitArgs(argv);
      expect(parsed.ok, argv.join(" ")).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/usage|needs a value|unknown harness|unknown flag/);
    }
  });
});
