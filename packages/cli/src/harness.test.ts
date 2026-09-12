import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexSnippet, resolveHarnesses, VERIFICATION_MARKER, wireHarnesses } from "./harness";

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
    expect(resolveHarnesses(cwd)).toEqual(["claude", "agents", "cursor"]);

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
