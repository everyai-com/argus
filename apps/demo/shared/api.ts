/**
 * Demo API core — the tiny in-process backend the task board talks to, so
 * Argus has real network truth to observe. Shared by the vite dev/preview
 * middleware and the deployed demo worker; implement transports elsewhere.
 */
export interface ApiResult {
  status: number;
  body: unknown;
}

/** Route one API call. Returns undefined for paths this API doesn't serve. */
export function handleDemoApi(method: string, pathname: string, fail: boolean): ApiResult | undefined {
  if (pathname !== "/api/tasks") return undefined;
  if (method === "GET") return { status: 200, body: { tasks: ["Ship Argus", "Test everything"] } };
  if (method === "POST" && fail) return { status: 500, body: { error: "injected server failure" } };
  if (method === "POST") return { status: 201, body: { ok: true } };
  return { status: 405, body: { error: "method not allowed" } };
}
