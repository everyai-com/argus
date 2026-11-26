/** An app that prints an error and exits: the run must refuse, not hang. */
import { defineConfig } from "../../src/index.ts";

export default defineConfig({
  tests: "*.argus.ts",
  app: {
    url: "http://127.0.0.1:5295",
    command: `node -e "console.error('fixture: cannot start'); process.exit(3)"`,
    startupTimeout: 10_000,
  },
});
