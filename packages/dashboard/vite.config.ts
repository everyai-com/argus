import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds straight into the cloud worker's static-assets directory.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../cloud/public",
    emptyOutDir: true,
  },
});
