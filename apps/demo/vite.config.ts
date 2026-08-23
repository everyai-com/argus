import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { argus } from "@argus/sdk/vite";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Tiny in-process API so the demo has real network truth for Argus to
 * observe: GET /api/tasks → 200 list, POST /api/tasks → 201,
 * POST /api/tasks?fail=1 → 500 (the "silent500" injected bug).
 */
function demoApi(): Plugin {
  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/tasks") return next();
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") {
      res.statusCode = 200;
      res.end(JSON.stringify({ tasks: ["Ship Argus", "Test everything"] }));
    } else if (req.method === "POST" && url.searchParams.get("fail") === "1") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "injected server failure" }));
    } else if (req.method === "POST") {
      res.statusCode = 201;
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "method not allowed" }));
    }
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
