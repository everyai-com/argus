/** The runner's own suite: `argus run` against tests/fixture-server.mjs. */
import { defineConfig } from "../src/index.ts";

const port = Number(process.env.ARGUS_FIXTURE_PORT ?? 5298);

export default defineConfig({
  tests: "*.argus.ts",
  app: {
    url: `http://127.0.0.1:${port}`,
    command: `node fixture-server.mjs ${port}`,
  },
  expectTimeout: 3_000,
  actionTimeout: 3_000,
});
