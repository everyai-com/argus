// Serves the real Argus Worker locally for tests/console.argus.ts: applies the
// D1 migrations into a throwaway state dir, then runs `wrangler dev --local`
// (Hono API, better-auth on local D1, R2, the Coordinator DO — nothing mocked).
// `argus run` starts this as app.command and stops it when the run ends.
// The admin token and auth secret below are local-only test values.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const port = process.argv[2] ?? "8797";
const cloud = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(cloud, "node_modules", "wrangler", "bin", "wrangler.js");
const state = mkdtempSync(join(tmpdir(), "argus-console-"));
const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" };

const migrate = spawnSync(
  process.execPath,
  [wrangler, "d1", "migrations", "apply", "argus-accounts", "--local", "--persist-to", state],
  { cwd: cloud, env, stdio: "inherit" }
);
if (migrate.status !== 0) {
  rmSync(state, { recursive: true, force: true });
  process.exit(migrate.status ?? 1);
}

const dev = spawn(
  process.execPath,
  [
    wrangler, "dev", "--local", "--ip", "127.0.0.1", "--port", port,
    "--persist-to", state, "--show-interactive-dev-session=false",
    "--var", "ARGUS_TOKEN:local-console-admin-token",
    "--var", "BETTER_AUTH_SECRET:local-console-secret-not-used-anywhere-else",
  ],
  { cwd: cloud, env, stdio: "inherit" }
);
const stop = () => dev.kill("SIGTERM");
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
dev.on("exit", (code) => {
  rmSync(state, { recursive: true, force: true });
  process.exit(code ?? 0);
});
