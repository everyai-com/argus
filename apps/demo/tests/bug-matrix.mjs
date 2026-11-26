// Dogfood negative controls, local edition: every demo `?bug=` variant MUST
// fail tests/task-board.argus.ts, with its predicted signature. A variant the
// suite passes is a hole in the suite — or in the runner.
//
// The cloud twin is scripts/verify-bug-matrix.mjs (on demand: it burns browser
// sessions). This one costs nothing, so it runs with the tests:
//   pnpm --filter @argus/demo test:bugs     (after `vite build`)
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const demo = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(demo, "..", "..", "packages", "cli", "dist", "index.js");

/** Each variant: the verdict that must catch it, and what the evidence must say. */
const variants = [
  { bug: "silent500", verdict: "expectation_failed", evidence: /→ 500/, want: "the POST-201 expectation sees the 500 behind an optimistic render" },
  { bug: "deadbutton", verdict: "expectation_failed", evidence: /no request to "\/api\/tasks" was made at all/, want: "the dead button makes no POST at all" },
  { bug: "wrongstate", verdict: "expectation_failed", evidence: /text is "42 task\(s\)"/, want: "the counter shows the hardcoded 42" },
  { bug: "slowreq", verdict: "expectation_failed", evidence: /text is "Loading…"/, want: "the list is still loading when the budget runs out" },
  // The two a locator-only suite passes straight over — caught by the audit gates.
  { bug: "overflow", verdict: "horizontal_overflow", evidence: /banner/, want: "the audit gate names the 1600px banner" },
  { bug: "consoleerror", verdict: "console_error", evidence: /Injected: something exploded/, want: "the audit gate reports the uncaught error" },
];

function runSuite(bug, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "run", "--json"], {
      cwd: demo,
      env: { ...process.env, ARGUS_DEMO_BUG: bug, ARGUS_DEMO_PORT: String(port) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function probe(variant, port) {
  const t0 = Date.now();
  const out = await runSuite(variant.bug, port);
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  let result;
  try {
    result = JSON.parse(out.stdout);
  } catch {
    return { ok: false, line: `ERROR  ?bug=${variant.bug}: no result (exit ${out.code}): ${out.stderr.slice(0, 300)}` };
  }
  const failures = (result.tests ?? []).filter((t) => t.status === "fail").map((t) => t.failure);
  const caught = failures.some((f) => f.verdict === variant.verdict && variant.evidence.test(f.whatChanged));
  if (out.code === 1 && caught) {
    const verdicts = [...new Set(failures.map((f) => f.verdict))].join(", ");
    return { ok: true, line: `CAUGHT ?bug=${variant.bug}: ${variant.want} (${failures.length}/${result.total} tests fail: ${verdicts}; ${seconds}s)` };
  }
  return {
    ok: false,
    line: `MISSED ?bug=${variant.bug}: expected [${variant.verdict}: ${variant.want}], got exit ${out.code}: ${JSON.stringify(failures).slice(0, 400)}`,
  };
}

// Side by side, each on its own port: most of a failing run is spent waiting
// out an assertion's budget, so the variants overlap almost for free.
const concurrency = Number(process.env.ARGUS_MATRIX_CONCURRENCY ?? variants.length);
const outcomes = new Array(variants.length);
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (let i = next++; i < variants.length; i = next++) {
      outcomes[i] = await probe(variants[i], 5200 + i);
      console.log(outcomes[i].line);
    }
  })
);

const missed = outcomes.filter((o) => !o.ok).length;
if (missed > 0) {
  console.error(`\nbug matrix: ${missed}/${variants.length} variants NOT caught as predicted`);
  process.exit(1);
}
console.log(`\nbug matrix: all ${variants.length} variants caught as predicted`);
