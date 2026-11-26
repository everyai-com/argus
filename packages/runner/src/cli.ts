/**
 * `argus run` — the command line of the local runner.
 *
 * Exit codes: 0 every test passed · 1 a test failed · 2 the run could not
 * happen (bad config, port taken, app did not start, no browser).
 */
import process from "node:process";
import { RunnerError } from "./errors.ts";
import { createReporter } from "./reporter.ts";
import { run, type RunOptions } from "./run.ts";

export const USAGE = `usage: argus run [file-filter...] [options]

  Runs *.argus.ts tests on a local Chromium. No cloud, no tunnel, no token.
  Reads argus.config.ts from the current directory; starts app.command, waits
  for app.url, runs the tests, stops the app.

  --config <file>      config file (default: ./argus.config.ts)
  --grep <text>        only tests whose title contains <text>
  --headed             show the browser
  --workers <n>        test files run side by side (default 1)
  --timeout <ms>       per-test budget (default 30000)
  --install-browser    download Playwright's Chromium first if it is missing
  --json               print the result as JSON instead of the report
`;

export function parseArgs(argv: string[]): { options: RunOptions; json: boolean; help: boolean } {
  const options: RunOptions = { cwd: process.cwd(), filters: [] };
  let json = false;
  let help = false;
  const value = (flag: string, i: number): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new RunnerError("usage", `${flag} needs a value`);
    return v;
  };
  const number = (flag: string, i: number): number => {
    const n = Number(value(flag, i));
    if (!Number.isFinite(n) || n <= 0) throw new RunnerError("usage", `${flag} needs a positive number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--config":
        options.config = value(arg, ++i);
        break;
      case "--grep":
        options.grep = value(arg, ++i);
        break;
      case "--workers":
        options.workers = number(arg, ++i);
        break;
      case "--timeout":
        options.timeout = number(arg, ++i);
        break;
      case "--headed":
        options.headed = true;
        break;
      case "--install-browser":
        options.installBrowser = true;
        break;
      case "--json":
        json = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        if (arg.startsWith("-")) throw new RunnerError("usage", `unknown option ${arg}`);
        options.filters!.push(arg);
    }
  }
  return { options, json, help };
}

export async function main(argv: string[]): Promise<number> {
  let json = false;
  try {
    const parsed = parseArgs(argv);
    json = parsed.json;
    if (parsed.help) {
      console.log(USAGE);
      return 0;
    }
    const options = parsed.options;
    // With --json, stdout carries the result and nothing else.
    const reporter = createReporter(options.cwd, json ? () => {} : console.log);
    const result = await run({ ...options, onStart: reporter.onStart, onTestEnd: reporter.onTestEnd });
    if (json) console.log(JSON.stringify(result, null, 2));
    else reporter.onEnd(result);
    return result.status === "pass" ? 0 : 1;
  } catch (err) {
    if (err instanceof RunnerError) {
      if (json) console.log(JSON.stringify({ status: "error", error: { code: err.code, message: err.message, hint: err.hint } }, null, 2));
      console.error(`argus run: ${err.message}`);
      if (err.hint) console.error(`  → ${err.hint}`);
      if (err.code === "usage") console.error(`\n${USAGE}`);
      return 2;
    }
    console.error(`argus run: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return 2;
  }
}
