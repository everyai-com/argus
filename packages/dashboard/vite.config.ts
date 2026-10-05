import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds into the gitignored dist/. Shipping a new UI is an explicit step:
// `pnpm --filter @argus/dashboard promote` copies dist/ into the cloud
// worker's static-assets directory (and refuses while public/ is vendored).
export default defineConfig({
  plugins: [react()],
});
