/**
 * Negative controls: every test in this directory MUST fail, with the verdict
 * named in its title. tests/check-negative.mjs runs it and checks each one.
 */
import { defineConfig } from "../../src/index.ts";

const port = Number(process.env.ARGUS_FIXTURE_PORT ?? 5297);

export default defineConfig({
  tests: "*.argus.ts",
  app: {
    url: `http://127.0.0.1:${port}`,
    command: `node ../fixture-server.mjs ${port}`,
  },
  expectTimeout: 800,
  actionTimeout: 800,
});
