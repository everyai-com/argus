/**
 * argus-demo worker: serves /api/tasks from the shared demo core, and every
 * other path falls through to the statically built app in ./dist.
 */
import { handleDemoApi } from "./shared/api";

interface Env {
  ASSETS: { fetch: (input: Request, init?: RequestInit) => Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const result = handleDemoApi(request.method, url.pathname, url.searchParams.get("fail") === "1");
    if (result) return Response.json(result.body, { status: result.status });
    return env.ASSETS.fetch(request);
  },
};
