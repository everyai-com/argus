import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { argus } from "@argus/sdk/vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleDemoApi } from "./shared/api";

/**
 * Tiny in-process API so the demo has real network truth for Argus to
 * observe. The routing lives in shared/api.ts (also used by the deployed
 * demo worker); this is just the vite middleware transport.
 */
function demoApi(): Plugin {
  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const result = handleDemoApi(
      req.method ?? "GET",
      url.pathname,
      url.searchParams.get("fail") === "1"
    );
    if (!result) return next();
    res.setHeader("content-type", "application/json");
    res.statusCode = result.status;
    res.end(JSON.stringify(result.body));
  };
  return {
    name: "demo-api",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  // The demo exists to be verified, so it ships the runtime in every build.
  plugins: [react(), argus({ includeInProduction: true }), demoApi()],
  server: { port: 5199, allowedHosts: [".trycloudflare.com"] },
  preview: { port: 5199, allowedHosts: [".trycloudflare.com"] },
});
