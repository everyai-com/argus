/** Terminal output for a run: a line per test, then each failure as a decision. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult, RunStart, TestResult } from "./run.ts";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (tty ? `\u001b[${code}m${s}\u001b[0m` : s);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const dim = paint(2);
const bold = paint(1);

const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);
const name = (t: TestResult) => [...t.path, t.title].join(" › ");

/** The source line a failure points at, so the reader need not open the file. */
function codeLine(rootDir: string, location: string | undefined): string | undefined {
  const m = location && /^(.*):(\d+):\d+$/.exec(location);
  if (!m) return undefined;
  try {
    const line = readFileSync(join(rootDir, m[1]!), "utf8").split("\n")[Number(m[2]) - 1];
    return line?.trim().slice(0, 140);
  } catch {
    return undefined;
  }
}

export function createReporter(rootDir: string, out: (line: string) => void = console.log) {
  let lastFile: string | undefined;
  return {
    onStart(info: RunStart): void {
      const app = info.app
        ? ` · ${info.app.url} ${dim(info.app.started ? `(started in ${ms(info.app.readyMs)})` : "(already running)")}`
        : "";
      out(`${bold("argus run")} · ${info.tests} test(s) in ${info.files} file(s) · ${info.browser}${app}`);
    },
    onTestEnd(t: TestResult): void {
      if (t.file !== lastFile) {
        out(`\n  ${dim(t.file)}`);
        lastFile = t.file;
      }
      const mark = t.status === "pass" ? green("✓") : t.status === "fail" ? red("✗") : yellow("○");
      out(`    ${mark} ${name(t)}${t.status === "skip" ? dim("  skipped") : dim(`  ${ms(t.durationMs)}`)}`);
    },
    onEnd(result: RunResult): void {
      const failures = result.tests.filter((t) => t.failure);
      failures.forEach((t, i) => {
        const f = t.failure!;
        out(`\n  ${red(`${i + 1}) ${name(t)}`)}`);
        if (f.location) out(`     ${dim(f.location)}`);
        const code = codeLine(rootDir, f.location);
        if (code) out(`     ${dim("> " + code)}`);
        out(`     ${bold(f.verdict)}${f.evidenceTier ? dim(` [${f.evidenceTier}]`) : ""}: ${f.whatChanged}`);
        if (f.suggestedFix) out(`     ${dim("fix: ")} ${f.suggestedFix}`);
        if (f.nextAction) out(`     ${dim("next:")} ${f.nextAction}`);
        for (const e of f.signals?.consoleErrors ?? []) out(`     ${dim("also: console error —")} ${e}`);
        if (f.signals?.horizontalOverflow) out(`     ${dim("also: overflow —")} ${f.signals.horizontalOverflow}`);
        if (f.screenshot) out(`     ${dim("screenshot:")} ${f.screenshot}`);
      });
      const parts = [
        result.passed ? green(`${result.passed} passed`) : "",
        result.failed ? red(`${result.failed} failed`) : "",
        result.skipped ? yellow(`${result.skipped} skipped`) : "",
      ].filter(Boolean);
      out(`\n  ${parts.join(", ")} ${dim(`(${ms(result.durationMs)})`)}`);
    },
  };
}
