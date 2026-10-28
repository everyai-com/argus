import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cli = resolve(process.cwd(), "packages/cli/dist/index.js");

describe("CLI executable", () => {
  it("ships a useful zero-configuration help path", () => {
    const output = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    expect(output).toContain("argus — cloud verification platform");
    expect(output).toContain("argus verify [url|port]");
  });

  it("prints help (never hangs) when run bare without a TTY", () => {
    const output = execFileSync(process.execPath, [cli], { encoding: "utf8" });
    expect(output).toContain("guided quickstart");
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

  it("doctor --offline checks the static surface without network or secrets", () => {
    const output = execFileSync(process.execPath, [cli, "doctor", "--offline"], {
      encoding: "utf8",
      env: { ...process.env, ARGUS_API: "https://argus.example", ARGUS_TOKEN: "do-not-print" },
    });
    expect(output).toContain("argus doctor");
    expect(output).toContain("DOCTOR PASS");
    expect(output).toMatch(/flows: \d+ valid/);
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

  it("writes a PR workflow, refuses to clobber, and detects Worker projects", () => {
    const cwd = mkdtempSync(join(tmpdir(), "argus-ci-"));
    const run = (...a: string[]) =>
      execFileSync(process.execPath, [cli, "ci", ...a], { encoding: "utf8", cwd });

    expect(run("https://my-app.example.com")).toContain(".github/workflows/argus.yml written");
    const yml = readFileSync(join(cwd, ".github", "workflows", "argus.yml"), "utf8");
    expect(yml).toContain("secrets.ARGUS_TOKEN");
    expect(yml).toContain('verify "https://my-app.example.com" --json');

    expect(() => run()).toThrow(/already exists/);
    expect(run("--force")).toContain("written");

    const worker = mkdtempSync(join(tmpdir(), "argus-ci-worker-"));
    writeFileSync(join(worker, "wrangler.jsonc"), "{}\n");
    execFileSync(process.execPath, [cli, "ci"], { encoding: "utf8", cwd: worker });
    expect(readFileSync(join(worker, ".github", "workflows", "argus.yml"), "utf8")).toContain(
      "gate --upload"
    );
  }, 20_000); // spawns the CLI several times — slow on a loaded machine
});
