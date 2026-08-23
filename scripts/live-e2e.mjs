import assert from "node:assert/strict";

const api = (process.env.ARGUS_API_URL ?? "https://argus-cloud.everyai-com.workers.dev").replace(/\/$/, "");
const target = process.env.ARGUS_E2E_TARGET ?? api;
const token = process.env.ARGUS_E2E_TOKEN ?? process.env.ARGUS_TOKEN;

if (!token) throw new Error("ARGUS_E2E_TOKEN is required");

async function request(method, path, body, authenticated = true) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { response, data };
}

const health = await request("GET", "/health", undefined, false);
assert.equal(health.response.status, 200);
assert.equal(health.data.ok, true);

const unauthenticated = await request("GET", "/v1/sessions", undefined, false);
assert.equal(unauthenticated.response.status, 401, "v1 API must reject missing credentials");

const smoke = await request("POST", "/v1/smoke", {
  url: target,
  viewports: ["mobile", "desktop"],
  colorSchemes: ["light"],
  project: "argus-live-e2e",
});
assert.equal(smoke.response.status, 200, JSON.stringify(smoke.data));
assert.equal(smoke.data.status, "pass", JSON.stringify(smoke.data.findings));
assert.equal(smoke.data.screenshots.length, 2);

const audit = await request("POST", "/v1/audit", {
  url: target,
  viewports: ["desktop"],
  colorSchemes: ["light"],
  checks: ["a11y", "perf", "links", "visual"],
  project: "argus-live-e2e",
});
assert.equal(audit.response.status, 200, JSON.stringify(audit.data));
assert.notEqual(audit.data.status, "error", JSON.stringify(audit.data.findings));

const flow = (name) => ({
  version: 1,
  name,
  startUrl: target,
  viewport: "desktop",
  steps: [{ action: { action: "wait", ms: 50 }, expect: [] }],
  success: [
    { kind: "text", anchor: { css: "h1" }, includes: "Argus" },
    { kind: "console-clean", since: 0 },
  ],
  dynamic: [],
});
const suite = await request("POST", "/v1/flows/verify", {
  flows: [flow("argus-home-a"), flow("argus-home-b")],
  concurrency: 2,
  project: "argus-live-e2e",
});
assert.equal(suite.response.status, 200, JSON.stringify(suite.data));
assert.equal(suite.data.status, "pass", JSON.stringify(suite.data.results));
assert.equal(suite.data.passed, 2);

const leases = await Promise.all(
  ["parallel-a", "parallel-b", "parallel-c"].map(async (label) => {
    const leased = await request("POST", "/v1/lease", {
      url: target,
      viewport: "desktop",
      colorScheme: "light",
      ttlSeconds: 120,
      label,
    });
    assert.equal(leased.response.status, 200, JSON.stringify(leased.data));
    return leased.data.sessionId;
  })
);

try {
  const observations = await Promise.all(
    leases.map(async (sessionId) => {
      const query = await request("POST", `/v1/session/${sessionId}/query`, {
        anchor: { text: "Argus" },
      });
      assert.equal(query.response.status, 200, JSON.stringify(query.data));
      assert.ok(query.data.elements.length > 0);
      return query.data;
    })
  );
  assert.equal(observations.length, 3);

  const screenshot = await request("POST", `/v1/session/${leases[0]}/screenshot`, {
    fullPage: true,
    label: "live-e2e",
  });
  assert.equal(screenshot.response.status, 200, JSON.stringify(screenshot.data));
  const artifact = await request("GET", screenshot.data.url);
  assert.equal(artifact.response.status, 200);
  assert.match(artifact.response.headers.get("content-type") ?? "", /^image\/png/);
} finally {
  await Promise.all(leases.map((sessionId) => request("DELETE", `/v1/session/${sessionId}`)));
}

const sessions = await request("GET", "/v1/sessions");
assert.equal(sessions.response.status, 200);
assert.equal(sessions.data.sessions.length, 0, "live test must release every browser lease");

console.log(
  JSON.stringify({
    ok: true,
    api,
    target,
    smoke: smoke.data.status,
    audit: audit.data.status,
    flows: suite.data.status,
    parallelSessions: leases.length,
  })
);
