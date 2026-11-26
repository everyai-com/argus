/**
 * Local tests for the Argus console: `pnpm --filter @argus/cloud test:local`.
 *
 * The console (the dashboard bundle promoted into ./public) is served by the
 * REAL Worker under local workerd — see tests/serve-console.mjs. `argus run`
 * starts it, waits for /health, runs tests/*.argus.ts on a local Chromium and
 * stops it again. No Argus token, no tunnel, no model.
 */
import { defineConfig } from "@argus/runner";

const port = Number(process.env.ARGUS_CONSOLE_PORT ?? 8797);

export default defineConfig({
  tests: "tests/**/*.argus.ts",
  app: {
    url: `http://127.0.0.1:${port}`,
    readyUrl: `http://127.0.0.1:${port}/health`,
    command: `node tests/serve-console.mjs ${port}`,
    startupTimeout: 120_000,
  },
});
