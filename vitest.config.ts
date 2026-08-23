import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@cloudflare/playwright": fileURLToPath(
        new URL("./test/cloudflare-playwright-stub.ts", import.meta.url)
      ),
      "cloudflare:workers": fileURLToPath(
        new URL("./test/cloudflare-workers-stub.ts", import.meta.url)
      ),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    exclude: ["reticle/**", "**/node_modules/**", "**/dist/**"],
    passWithNoTests: false,
  },
});
