/**
 * One run: collect the tests, start the app, launch the browser, run every
 * test in its own browser context, stop everything.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "playwright-core";
import type { EvidenceTier } from "@argus/shared";
import { createFixtures, unexpectedConsoleErrors, type TestContext } from "./api.ts";
import { startApp, type RunningApp } from "./app-server.ts";
import { installBrowser, launchBrowser } from "./browser.ts";
import { loadConfig, resolveViewport, type ResolvedConfig } from "./config.ts";
import { discover } from "./discover.ts";
import { ArgusTestError, RunnerError, type TestVerdict } from "./errors.ts";
import { consoleErrorDecision, overflowDecision } from "./expect.ts";
import { LocalDriver } from "./local-driver.ts";
import { collect, hooksFor, type TestCase } from "./registry.ts";

export interface RunOptions {
  /** Where to look for argus.config.ts. */
  cwd: string;
  /** Explicit config file. */
  config?: string;
  /** Run only files whose path contains one of these. */
  filters?: string[];
  /** Run only tests whose full title contains this. */
  grep?: string;
  headed?: boolean;
  /** Download Playwright's Chromium first if it is missing. */
  installBrowser?: boolean;
  workers?: number;
  /** Override the per-test budget, ms. */
  timeout?: number;
  onStart?: (info: RunStart) => void;
  onTestEnd?: (result: TestResult) => void;
}

export interface RunStart {
  tests: number;
  files: number;
  browser: string;
  app?: { url: string; started: boolean; readyMs: number };
}

export interface TestFailure {
  verdict: TestVerdict;
  whatChanged: string;
  suggestedFix?: string;
  nextAction?: string;
  evidenceTier?: EvidenceTier;
  /** `file:line:column` of the test line that failed, relative to the run's root. */
  location?: string;
  /** Failure screenshot, relative to the run's root. */
  screenshot?: string;
  /** What the audit signals said at the moment of failure — context, not the verdict. */
  signals?: { consoleErrors?: string[]; horizontalOverflow?: string };
}

export interface TestResult {
  file: string;
  title: string;
  path: string[];
  status: "pass" | "fail" | "skip";
  durationMs: number;
  failure?: TestFailure;
}

export interface RunResult {
  status: "pass" | "fail";
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  browser: string;
  app?: { url: string; started: boolean; readyMs: number };
  tests: TestResult[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
const rel = (root: string, file: string) => relative(root, file).split(sep).join("/");

/** The first stack frame inside the test file: where the test itself was. */
function locate(stack: string | undefined, file: string, root: string): string | undefined {
  if (!stack) return undefined;
  const url = pathToFileURL(file).href;
  for (const line of stack.split("\n")) {
    const at = line.indexOf(url) >= 0 ? line.indexOf(url) + url.length : line.indexOf(file) >= 0 ? line.indexOf(file) + file.length : -1;
    if (at < 0) continue;
    const pos = /^:(\d+):(\d+)/.exec(line.slice(at));
    return `${rel(root, file)}${pos ? `:${pos[1]}:${pos[2]}` : ""}`;
  }
  return undefined;
}

function toFailure(err: unknown, test: TestCase, root: string): TestFailure {
  if (err instanceof ArgusTestError)
    return { ...err.decision, location: locate(err.site, test.file, root) ?? locate(err.stack, test.file, root) };
  const e = err instanceof Error ? err : new Error(String(err));
  return {
    verdict: "error",
    whatChanged: `${e.name}: ${e.message}`.slice(0, 500),
    nextAction: "the test threw outside an assertion — see the location",
    location: locate(e.stack, test.file, root),
  };
}

async function runTest(
  test: TestCase,
  browser: Browser,
  config: ResolvedConfig,
  opts: RunOptions
): Promise<TestResult> {
  const t0 = Date.now();
  const base = { file: rel(config.rootDir, test.file), title: test.title, path: test.path };
  const timeout = test.options.timeout ?? opts.timeout ?? config.timeout;
  const viewport = test.options.viewport ? resolveViewport(test.options.viewport) : config.viewport;

  const context = await browser.newContext({ viewport });
  const driver = new LocalDriver(await context.newPage(), { baseURL: config.app?.url });
  const ctx: TestContext = {
    driver,
    actionTimeout: config.actionTimeout,
    expectTimeout: config.expectTimeout,
    gates: { ...config.audit, ...test.options.audit },
    allowedConsole: [],
    calls: [],
  };
  const fixtures = createFixtures(ctx);
  const hooks = hooksFor(test);
  let error: unknown;

  try {
    let timer: NodeJS.Timeout | undefined;
    const body = (async () => {
      for (const hook of hooks.before) await hook(fixtures);
      await test.fn(fixtures);
    })();
    try {
      await Promise.race([
        body,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ArgusTestError({
                  verdict: "timeout",
                  whatChanged: `the test did not finish within ${timeout}ms`,
                  nextAction: "find the step that hangs (the screenshot shows where the page was), or raise `timeout` for this test",
                })
              ),
            timeout
          );
        }),
      ]);
    } catch (err) {
      error = err;
    } finally {
      clearTimeout(timer);
    }
    for (const hook of hooks.after) {
      try {
        await hook(fixtures);
      } catch (err) {
        error ??= err;
      }
    }

    // A runner call nobody awaited could not have failed the test. Refuse the
    // green rather than report one that proves nothing.
    const stray = ctx.calls.filter((c) => !c.observed);
    if (!error && stray.length > 0) {
      const e = new ArgusTestError({
        verdict: "unawaited",
        whatChanged: `${stray.length} runner call(s) were never awaited, so they could not fail this test`,
        suggestedFix: "put `await` in front of the action or `expect` at this location",
      });
      e.site = stray[0]!.site;
      error = e;
    }

    // Audit gates. They judge a test whose own assertions held: a page that
    // threw, or that scrolls sideways, is not green just because the buttons worked.
    let failure: TestFailure | undefined;
    if (!error) {
      try {
        await driver.settle(1_000);
        if (ctx.gates.consoleErrors) {
          const errors = await unexpectedConsoleErrors(ctx);
          if (errors.length > 0) throw new ArgusTestError(consoleErrorDecision(errors.map((e) => e.text)));
        }
        if (ctx.gates.horizontalOverflow) {
          const reading = await driver.overflow();
          if (reading.overflow) throw new ArgusTestError(overflowDecision(reading));
        }
      } catch (err) {
        error = err;
      }
    } else {
      failure = toFailure(error, test, config.rootDir);
      // The body already failed; the signals are context for whoever reads it.
      const signals: NonNullable<TestFailure["signals"]> = {};
      const errors = await unexpectedConsoleErrors(ctx).catch(() => []);
      if (errors.length > 0) signals.consoleErrors = errors.slice(0, 5).map((e) => e.text.slice(0, 200));
      const reading = await driver.overflow().catch(() => undefined);
      if (reading?.overflow) signals.horizontalOverflow = overflowDecision(reading).whatChanged;
      if (signals.consoleErrors || signals.horizontalOverflow) failure.signals = signals;
    }

    if (!error) return { ...base, status: "pass", durationMs: Date.now() - t0 };
    failure ??= toFailure(error, test, config.rootDir);
    try {
      const png = await driver.screenshot();
      const file = join(config.outputDir, `${slug([...test.path, test.title].join(" "))}.png`);
      mkdirSync(config.outputDir, { recursive: true });
      writeFileSync(file, png);
      failure.screenshot = rel(config.rootDir, file);
    } catch {
      /* the page may be gone — the failure stands without a picture */
    }
    return { ...base, status: "fail", durationMs: Date.now() - t0, failure };
  } finally {
    await driver.close();
  }
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const t0 = Date.now();
  const config = await loadConfig(opts.cwd, opts.config);

  let files = discover(config.rootDir, config.tests);
  if (opts.filters?.length)
    files = files.filter((f) => opts.filters!.some((x) => rel(config.rootDir, f).includes(x)));
  if (files.length === 0)
    throw new RunnerError(
      "no_tests",
      `no test files match ${config.tests.join(", ")} under ${config.rootDir}${opts.filters?.length ? ` (filter: ${opts.filters.join(" ")})` : ""}`,
      "name test files *.argus.ts, or set `tests` in argus.config.ts"
    );

  const all: TestCase[] = [];
  for (const file of files) all.push(...(await collect(file, () => import(pathToFileURL(file).href))));

  const only = all.some((t) => t.mode === "only");
  if (only && process.env.CI)
    throw new RunnerError("only_in_ci", "test.only / describe.only is committed", "remove it — on CI it would silently skip the rest of the suite");
  const fullTitle = (t: TestCase) => [...t.path, t.title].join(" › ");
  const selected = all.filter((t) => (only ? t.mode === "only" : true) && (!opts.grep || fullTitle(t).includes(opts.grep)));
  const runnable = selected.filter((t) => t.mode !== "skip");
  if (runnable.length === 0)
    throw new RunnerError("no_tests", `no tests to run in ${files.length} file(s)${opts.grep ? ` matching "${opts.grep}"` : ""}`);

  if (opts.installBrowser) installBrowser(Boolean(opts.headed));

  let app: RunningApp | undefined;
  let browser: Browser | undefined;
  const teardown = async () => {
    await browser?.close().catch(() => {});
    await app?.stop().catch(() => {});
  };
  // Ctrl-C must not leave the app (or a Chromium) running behind the run.
  const onSignal = (signal: NodeJS.Signals) => {
    void teardown().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    // The app boots while the browser launches; either failing fails the run,
    // and `teardown` (below) stops whichever of the two did come up.
    const [appOutcome, browserOutcome] = await Promise.allSettled([
      config.app ? startApp(config.app, join(config.outputDir, "app.log")) : undefined,
      launchBrowser(config.browser, Boolean(opts.headed)),
    ]);
    if (appOutcome.status === "fulfilled") app = appOutcome.value;
    if (browserOutcome.status === "fulfilled") browser = browserOutcome.value.browser;
    if (appOutcome.status === "rejected") throw appOutcome.reason;
    if (browserOutcome.status === "rejected") throw browserOutcome.reason;
    const launched = browserOutcome.value;
    const appInfo = app ? { url: app.url, started: app.started, readyMs: app.readyMs } : undefined;
    opts.onStart?.({ tests: runnable.length, files: files.length, browser: launched.label, app: appInfo });

    const results = new Map<TestCase, TestResult>();
    const byFile = files.map((f) => selected.filter((t) => t.file === f)).filter((g) => g.length > 0);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const group = byFile[next++];
        if (!group) return;
        for (const test of group) {
          const result: TestResult =
            test.mode === "skip"
              ? { file: rel(config.rootDir, test.file), title: test.title, path: test.path, status: "skip", durationMs: 0 }
              : await runTest(test, browser!, config, opts);
          results.set(test, result);
          opts.onTestEnd?.(result);
        }
      }
    };
    const workers = Math.max(1, Math.min(opts.workers ?? config.workers, byFile.length));
    await Promise.all(Array.from({ length: workers }, worker));

    const tests = selected.map((t) => results.get(t)!);
    const count = (s: TestResult["status"]) => tests.filter((t) => t.status === s).length;
    return {
      status: count("fail") === 0 ? "pass" : "fail",
      total: tests.length,
      passed: count("pass"),
      failed: count("fail"),
      skipped: count("skip"),
      durationMs: Date.now() - t0,
      browser: launched.label,
      app: appInfo,
      tests,
    };
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await teardown();
  }
}
