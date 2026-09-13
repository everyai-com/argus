import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cli = resolve(process.cwd(), "packages/cli/dist/index.js");

describe("CLI executable", () => {
  it("ships a useful zero-configuration help path", () => {
    const output = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    expect(output).toContain("argus — cloud verification platform");
    expect(output).toContain("argus verify <url>");
  });

  it("never prints the resolved token", () => {
    const output = execFileSync(process.execPath, [cli, "config"], {
      encoding: "utf8",
      env: { ...process.env, ARGUS_API: "https://argus.example", ARGUS_TOKEN: "do-not-print" },
    });
    expect(output).toContain("https://argus.example");
    expect(output).toContain("•••set•••");
    expect(output).not.toContain("do-not-print");
  });

  it("wires a project from the credentials alone, and again as a no-op", () => {
    const cwd = mkdtempSync(join(tmpdir(), "argus-init-"));
    const run = () =>
      execFileSync(process.execPath, [cli, "init", "https://argus.example/", "tok-123"], {
        encoding: "utf8",
        cwd,
      });

    const output = run();
    expect(output).toContain(".mcp.json");
    expect(output).toContain("AGENTS.md");

    expect(JSON.parse(readFileSync(join(cwd, ".argus", "config.json"), "utf8"))).toEqual({
      api: "https://argus.example",
      token: "tok-123",
    });
    const mcp = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.argus.args[0]).toMatch(/packages[/\\]mcp[/\\]dist[/\\]index\.js$/);

    expect(run()).toContain("already wired");
  });
});
