import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    exclude: ["reticle/**", "**/node_modules/**", "**/dist/**"],
    passWithNoTests: false,
  },
});
