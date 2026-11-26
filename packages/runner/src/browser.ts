/**
 * The local browser: Playwright's Chromium, launched on this machine.
 *
 * Resolution order — an explicit binary (config or ARGUS_BROWSER_PATH), a
 * named channel, Playwright's own Chromium build, and finally an installed
 * Google Chrome. When none is there the error says how to get one.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import type { BrowserConfig } from "./config.ts";
import { RunnerError } from "./errors.ts";

export interface LaunchedBrowser {
  browser: Browser;
  /** e.g. "chromium 143.0.7499.4" — printed in the run header. */
  label: string;
}

const missing = (err: unknown) => /Executable doesn't exist|install/i.test(String(err));

export async function launchBrowser(cfg: BrowserConfig, headed: boolean): Promise<LaunchedBrowser> {
  const headless = headed ? false : (cfg.headless ?? true);
  const executablePath = cfg.executablePath ?? process.env.ARGUS_BROWSER_PATH;
  const attempts: Array<{ name: string; options: Parameters<typeof chromium.launch>[0] }> = executablePath
    ? [{ name: executablePath, options: { headless, executablePath } }]
    : cfg.channel
      ? [{ name: cfg.channel, options: { headless, channel: cfg.channel } }]
      : [
          { name: "chromium", options: { headless } },
          { name: "chrome", options: { headless, channel: "chrome" } },
        ];

  let firstError: unknown;
  for (const attempt of attempts) {
    try {
      const browser = await chromium.launch(attempt.options);
      return { browser, label: `${attempt.name} ${browser.version()}` };
    } catch (err) {
      firstError ??= err;
      if (!missing(err)) break;
    }
  }
  if (missing(firstError))
    throw new RunnerError(
      "no_browser",
      "no Chromium to run the tests in",
      "run `argus run --install-browser` once (downloads Playwright's Chromium, ~110 MB), or set ARGUS_BROWSER_PATH to a Chrome/Chromium binary"
    );
  throw new RunnerError("browser_launch_failed", `the browser failed to start: ${String(firstError).split("\n")[0]}`);
}

/**
 * Download Playwright's Chromium if it is not there yet (a no-op when it is).
 * Headless runs need only the headless shell; `--headed` needs the full build.
 */
export function installBrowser(headed: boolean): void {
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("playwright-core/package.json")), "cli.js");
  const args = [cli, "install", "chromium", ...(headed ? [] : ["--only-shell"])];
  const out = spawnSync(process.execPath, args, { stdio: ["ignore", process.stderr, process.stderr] });
  if (out.status !== 0)
    throw new RunnerError(
      "browser_install_failed",
      `playwright-core could not install Chromium (exit ${out.status})`,
      "on a bare Linux box Chromium also needs system libraries: `npx playwright-core install-deps chromium`"
    );
}
