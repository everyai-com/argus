// Negative controls for the runner itself. Runs tests/negative — every test
// there must FAIL, with the verdict its title starts with — then the two
// run-level refusals: a port that is already taken, and an app that dies.
// A runner that turns any of these green is producing false greens.
//   node tests/check-negative.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "..", "bin", "argus-run.mjs");

function argusRun(cwd, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const problems = [];
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) problems.push(message);
};

// 1. Every negative test fails, each with its predicted verdict.
{
  const out = await argusRun(join(here, "negative"), ["--json"]);
  check(out.code === 1, `negative suite exits 1 (got ${out.code})`);
  let result;
  try {
    result = JSON.parse(out.stdout);
  } catch {
    check(false, `negative suite printed JSON (stderr: ${out.stderr.slice(0, 400)})`);
  }
  for (const t of result?.tests ?? []) {
    const want = /^\[([a-z_]+)\]/.exec(t.title)?.[1];
    const got = t.status === "fail" ? t.failure.verdict : t.status;
    check(want !== undefined && got === want, `${t.title} → ${got}`);
    if (t.status === "fail" && want !== "timeout" && !/console_error|horizontal_overflow/.test(want ?? ""))
      check(/negative\.argus\.ts:\d+:\d+$/.test(t.failure.location ?? ""), `  …and points at its line (${t.failure.location})`);
  }
  check((result?.tests?.length ?? 0) >= 14, `all negative tests ran (${result?.tests?.length ?? 0})`);
  check(!out.stdout.includes("hunter2"), "the password value appears nowhere in the report");
}

// 2. The port is already taken: refuse, say so, and do not test the squatter.
{
  const squatter = createServer().listen(5296, "127.0.0.1");
  await new Promise((r) => squatter.once("listening", r));
  const out = await argusRun(join(here, "negative"), [], { ARGUS_FIXTURE_PORT: "5296" });
  squatter.close();
  check(out.code === 2, `a taken port exits 2 (got ${out.code})`);
  check(/port 5296 is already in use/.test(out.stderr), `…and says the port is in use: ${out.stderr.split("\n")[0]}`);
  check(!/✓|✗/.test(out.stdout), "…and runs no test");
}

// 3. The app dies before it answers: refuse, with its last output.
{
  const out = await argusRun(here, ["--config", "negative/dead-app.config.ts"]);
  check(out.code === 2, `an app that exits early exits 2 (got ${out.code})`);
  check(/exited before it answered/.test(out.stderr) && /fixture: cannot start/.test(out.stderr), "…and shows the app's last output");
}

if (problems.length > 0) {
  console.error(`\nrunner negative controls: ${problems.length} NOT as predicted`);
  process.exit(1);
}
console.log("\nrunner negative controls: all as predicted");
