/**
 * `argus run` — hand off to the local runner (`@argus/runner`).
 *
 * The runner is resolved from the project being tested, not bundled into this
 * CLI: the test files import `@argus/runner` themselves, and the copy that
 * collects their `test()` calls has to be that same copy. It also keeps
 * Playwright out of a CLI most people only use against the cloud.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface LocalRunner {
  main(argv: string[]): Promise<number>;
}

/** Why the runner cannot run here, as a message for the terminal — or undefined. */
export function runnerBlocker(features: { typescript?: unknown }, version: string): string | undefined {
  if (features.typescript) return undefined;
  return `argus run needs Node >= 22.18 (it loads TypeScript test files natively); this is ${version}`;
}

/** Path of the project's `@argus/runner` CLI entry, or undefined when it is not installed. */
export function resolveRunner(cwd: string): string | undefined {
  try {
    return createRequire(join(cwd, "package.json")).resolve("@argus/runner/cli");
  } catch {
    return undefined;
  }
}

export async function runLocal(argv: string[], cwd: string): Promise<number> {
  const blocker = runnerBlocker(process.features as { typescript?: unknown }, process.version);
  if (blocker) {
    console.error(blocker);
    return 2;
  }
  const entry = resolveRunner(cwd);
  if (!entry) {
    console.error(
      "argus run: @argus/runner is not installed in this project\n" +
        "  → add it as a devDependency (your test files import { test, expect } from it), then re-run"
    );
    return 2;
  }
  const runner = (await import(pathToFileURL(entry).href)) as LocalRunner;
  return await runner.main(argv);
}
