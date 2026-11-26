/**
 * Local tests for the dogfood task board: `pnpm --filter @argus/demo test:local`.
 *
 * `argus run` serves the production build with `vite preview`, runs
 * tests/*.argus.ts on a local Chromium, and stops the server. No Argus token,
 * no tunnel, no model. Build first (`vite build`; the script does).
 */
import { defineConfig } from "@argus/runner";

// The bug matrix runs several copies side by side, each on its own port.
const port = Number(process.env.ARGUS_DEMO_PORT ?? 5199);

export default defineConfig({
  tests: "tests/**/*.argus.ts",
  app: {
    url: `http://127.0.0.1:${port}`,
    command: `vite preview --host 127.0.0.1 --port ${port} --strictPort`,
  },
});
