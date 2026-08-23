import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
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
});
