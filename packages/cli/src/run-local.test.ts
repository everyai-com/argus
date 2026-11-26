import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRunner, runnerBlocker } from "./run-local";

describe("argus run hand-off", () => {
  it("says which Node it needs when TypeScript cannot be loaded natively", () => {
    expect(runnerBlocker({ typescript: false }, "v20.11.0")).toContain("Node >= 22.18");
    expect(runnerBlocker({ typescript: false }, "v20.11.0")).toContain("v20.11.0");
    expect(runnerBlocker({ typescript: "strip" }, "v24.0.0")).toBeUndefined();
  });

  it("resolves the runner from the project under test, not from the CLI", () => {
    expect(resolveRunner(resolve(process.cwd(), "apps/demo"))).toMatch(/packages[/\\]runner[/\\]src[/\\]cli\.ts$/);
  });

  it("says how to get the runner in a project that does not have it — with no token and no API", () => {
    const cli = resolve(process.cwd(), "packages/cli/dist/index.js");
    // pnpm puts its hoisted store on NODE_PATH; a real project has no such thing.
    const env = { ...process.env, ARGUS_API: "", ARGUS_TOKEN: "", NODE_PATH: "" };
    const out = spawnSync(process.execPath, [cli, "run"], {
      cwd: mkdtempSync(join(tmpdir(), "argus-norunner-")),
      encoding: "utf8",
      env,
    });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("@argus/runner is not installed in this project");
  });
});
