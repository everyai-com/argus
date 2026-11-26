import { describe as group, expect, it } from "vitest";
import { parseArgs } from "./cli.ts";
import { resolveConfig, resolveViewport } from "./config.ts";
import { globToRegExp } from "./discover.ts";
import { RunnerError } from "./errors.ts";
import { collect, describe, hooksFor, test, beforeEach } from "./registry.ts";

group("test file globs", () => {
  it("matches the default pattern at any depth, including the top", () => {
    const re = globToRegExp("**/*.argus.ts");
    expect(re.test("home.argus.ts")).toBe(true);
    expect(re.test("tests/deep/home.argus.ts")).toBe(true);
    expect(re.test("tests/home.test.ts")).toBe(false);
    expect(re.test("tests/home.argus.tsx")).toBe(false);
  });

  it("keeps * inside one directory", () => {
    const re = globToRegExp("tests/*.argus.ts");
    expect(re.test("tests/a.argus.ts")).toBe(true);
    expect(re.test("tests/deep/a.argus.ts")).toBe(false);
  });
});

group("config", () => {
  it("defaults to both audit gates on, one worker, the desktop viewport", () => {
    const c = resolveConfig({}, "/project");
    expect(c.audit).toEqual({ consoleErrors: true, horizontalOverflow: true, includeThirdParty: false });
    expect(c.viewport).toEqual({ width: 1280, height: 800 });
    expect(c.workers).toBe(1);
    expect(c.tests).toEqual(["**/*.argus.ts"]);
    expect(c.outputDir).toBe("/project/.argus/runs/local");
    expect(c.app).toBeUndefined();
  });

  it("resolves the app's working directory against the config file", () => {
    const c = resolveConfig({ app: { url: "http://127.0.0.1:5199", command: "vite preview", cwd: "../demo" } }, "/repo/suite");
    expect(c.app?.cwd).toBe("/repo/demo");
    expect(c.app?.startupTimeout).toBe(60_000);
  });

  it("rejects a relative app URL and a nonsense timeout by name", () => {
    expect(() => resolveConfig({ app: { url: "localhost:5199" } }, "/p")).toThrow(RunnerError);
    expect(() => resolveConfig({ app: { url: "/just/a/path" } }, "/p")).toThrow("config.app.url");
    expect(() => resolveConfig({ timeout: -1 }, "/p")).toThrow("config.timeout");
  });

  it("names viewports from the wire contract", () => {
    expect(resolveViewport("mobile")).toEqual({ width: 375, height: 812 });
    expect(resolveViewport({ width: 900, height: 600 })).toEqual({ width: 900, height: 600 });
    expect(() => resolveViewport("phone" as never)).toThrow("unknown viewport");
  });
});

group("argus run arguments", () => {
  it("reads filters and flags", () => {
    const { options, json } = parseArgs(["tests/a", "--grep", "adds", "--workers", "2", "--json", "--headed"]);
    expect(options.filters).toEqual(["tests/a"]);
    expect(options.grep).toBe("adds");
    expect(options.workers).toBe(2);
    expect(options.headed).toBe(true);
    expect(json).toBe(true);
  });

  it("refuses an unknown flag or a missing value instead of ignoring it", () => {
    expect(() => parseArgs(["--nope"])).toThrow("unknown option --nope");
    expect(() => parseArgs(["--config"])).toThrow("--config needs a value");
    expect(() => parseArgs(["--workers", "zero"])).toThrow("positive number");
  });
});

group("test collection", () => {
  it("records describe paths, modes and hooks in order", async () => {
    const calls: string[] = [];
    const tests = await collect("/x/a.argus.ts", async () => {
      beforeEach(async () => void calls.push("file"));
      describe("outer", () => {
        beforeEach(async () => void calls.push("outer"));
        test("one", async () => {});
        describe.skip("off", () => {
          test("two", async () => {});
        });
        test.only("three", { timeout: 5 }, async () => {});
      });
      test.skip("four", async () => {});
    });
    expect(tests.map((t) => [t.path.join("/"), t.title, t.mode])).toEqual([
      ["outer", "one", "run"],
      ["outer/off", "two", "skip"],
      ["outer", "three", "only"],
      ["", "four", "skip"],
    ]);
    expect(tests[2]!.options.timeout).toBe(5);
    for (const hook of hooksFor(tests[0]!).before) await hook({} as never);
    expect(calls).toEqual(["file", "outer"]);
    expect(hooksFor(tests[3]!).before).toHaveLength(1);
  });

  it("refuses test() outside a run, and an async describe", async () => {
    expect(() => test("stray", async () => {})).toThrow("argus run");
    await expect(
      collect("/x/b.argus.ts", async () => {
        describe("late", (async () => {}) as unknown as () => void);
      })
    ).rejects.toThrow("synchronously");
  });
});
