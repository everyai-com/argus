import { describe, expect, it, vi } from "vitest";
import app from "./index";
import { signedEvidenceUrl } from "./evidence";

function env(overrides: Record<string, unknown> = {}) {
  return {
    ARGUS_TOKEN: "admin-secret",
    COORDINATOR: {
      idFromName: () => "main",
      get: () => ({ fetch: vi.fn() }),
    },
    BROWSER_SESSION: {
      idFromName: (id: string) => id,
      get: () => ({ fetch: vi.fn() }),
    },
    ARTIFACTS: { get: vi.fn(), put: vi.fn(), list: vi.fn() },
    ...overrides,
  } as never;
}

function memoryArtifacts() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) =>
      store.has(key)
        ? { json: async () => JSON.parse(store.get(key)!), text: async () => store.get(key)! }
        : null
    ),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    head: vi.fn(async (key: string) => (store.has(key) ? { key } : null)),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({
      objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k })),
    })),
  };
}

describe("worker API boundary", () => {
  it("keeps health public while every v1 route fails closed", async () => {
    expect((await app.request("https://argus.test/health", {}, env())).status).toBe(200);
    expect((await app.request("https://argus.test/v1/sessions", {}, env())).status).toBe(401);
    expect(
      (await app.request("https://argus.test/v1/sessions", {}, env({ ARGUS_TOKEN: undefined })))
        .status
    ).toBe(401);
  });

  it("reports GitHub platform readiness without exposing credentials", async () => {
    const response = await app.request(
      "https://argus.test/platform/github/status",
      {},
      env({
        ARGUS_GITHUB_APP_ID: "123",
        ARGUS_GITHUB_PRIVATE_KEY: "secret-key",
        ARGUS_GITHUB_WEBHOOK_SECRET: "webhook-secret",
        ARGUS_GITHUB_APP_SLUG: "argus-verification",
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      installUrl: "https://github.com/apps/argus-verification/installations/new",
      checkName: "Argus Verification",
    });
  });

  it("rejects unsigned GitHub webhook traffic before storing a delivery", async () => {
    const artifactPut = vi.fn();
    const response = await app.request(
      "https://argus.test/platform/github/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "12345678-abcd",
          "x-github-event": "pull_request",
        },
        body: JSON.stringify({ action: "opened" }),
      },
      env({
        ARGUS_GITHUB_APP_ID: "123",
        ARGUS_GITHUB_PRIVATE_KEY: "secret-key",
        ARGUS_GITHUB_WEBHOOK_SECRET: "webhook-secret",
        ARTIFACTS: { get: vi.fn(), put: artifactPut, list: vi.fn() },
      })
    );
    expect(response.status).toBe(401);
    expect(artifactPut).not.toHaveBeenCalled();
  });

  it("serves run evidence through an expiring signature instead of an API token", async () => {
    const now = Date.now();
    const signed = await signedEvidenceUrl(
      "webhook-secret",
      "https://argus.test",
      "gh-123",
      "run-1",
      now
    );
    const report = {
      runId: "run-1",
      status: "pass",
      url: "https://preview.example.com",
      findings: [],
      screenshots: [],
    };
    const response = await app.request(
      signed,
      {},
      env({
        ARGUS_GITHUB_WEBHOOK_SECRET: "webhook-secret",
        ARTIFACTS: {
          get: vi.fn(async (key: string) =>
            key.endsWith("report.json") ? { json: async () => report } : null
          ),
        },
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toContain("Argus verification evidence");

    const tampered = new URL(signed);
    tampered.pathname = tampered.pathname.replace("run-1", "run-2");
    expect(
      (
        await app.request(
          tampered.toString(),
          {},
          env({ ARGUS_GITHUB_WEBHOOK_SECRET: "webhook-secret" })
        )
      ).status
    ).toBe(403);
  });

  it("validates input before allocating a browser", async () => {
    const response = await app.request(
      "https://argus.test/v1/lease",
      {
        method: "POST",
        headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
        body: "{}",
      },
      env()
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "bad_request" });
  });

  it("prevents a tenant from reading another tenant's artifact", async () => {
    const artifactGet = vi.fn(async () => ({
      body: "image",
      httpMetadata: { contentType: "image/png" },
    }));
    const coordinatorFetch = vi.fn(async (request: Request | string) => {
      if (String(request).includes("resolve-token")) {
        return Response.json({
          tenant: { id: "team-a", name: "Team A", reserved: 0, maxBurst: 4 },
        });
      }
      return Response.json({});
    });
    const testEnv = env({
      COORDINATOR: {
        idFromName: () => "main",
        get: () => ({ fetch: coordinatorFetch }),
      },
      ARTIFACTS: { get: artifactGet },
    });
    const headers = { authorization: "Bearer team-a-token" };

    const denied = await app.request(
      "https://argus.test/v1/artifact/tenants/team-b/shots/x.png",
      { headers },
      testEnv
    );
    expect(denied.status).toBe(404);
    expect(artifactGet).not.toHaveBeenCalled();

    const allowed = await app.request(
      "https://argus.test/v1/artifact/tenants/team-a/shots/x.png",
      { headers },
      testEnv
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe("image");
  });
});

describe("remote MCP endpoint", () => {
  const rpcHeaders = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const rpc = (id: number, method: string, params: unknown = {}) =>
    JSON.stringify({ jsonrpc: "2.0", id, method, params });

  it("refuses an unauthenticated connection", async () => {
    const res = await app.request(
      "https://argus.test/mcp",
      {
        method: "POST",
        headers: rpcHeaders,
        body: rpc(1, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        }),
      },
      env()
    );
    expect(res.status).toBe(401);
  });

  it("initializes and serves the whole tool surface", async () => {
    const e = env({ ARTIFACTS: memoryArtifacts() });
    const headers = { authorization: "Bearer admin-secret", ...rpcHeaders };

    const init = await app.request(
      "https://argus.test/mcp",
      {
        method: "POST",
        headers,
        body: rpc(1, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        }),
      },
      e
    );
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as { result: { serverInfo: { name: string } } };
    expect(initBody.result.serverInfo.name).toBe("argus");

    const tools = await app.request(
      "https://argus.test/mcp",
      { method: "POST", headers, body: rpc(2, "tools/list") },
      e
    );
    const toolsBody = (await tools.json()) as { result: { tools: Array<{ name: string }> } };
    const names = toolsBody.result.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "argus_lease",
        "argus_assert",
        "argus_observe",
        "argus_flow_save",
        "argus_flow_verify",
        "argus_tools",
      ])
    );
  });
});

describe("server-side flows", () => {
  it("saves, lists, reads and deletes a tenant's flows", async () => {
    const e = env({ ARTIFACTS: memoryArtifacts() });
    const headers = { authorization: "Bearer admin-secret", "content-type": "application/json" };
    const flow = {
      version: 1,
      name: "loads",
      startUrl: "https://example.com",
      steps: [{ action: { action: "wait", ms: 50 } }],
      success: [{ kind: "console-clean" }],
    };

    const put = await app.request(
      "https://argus.test/v1/flows/loads",
      { method: "PUT", headers, body: JSON.stringify(flow) },
      e
    );
    expect(put.status).toBe(200);

    const list = await app.request("https://argus.test/v1/flows", { headers }, e);
    const listBody = (await list.json()) as { flows: Array<{ name: string }> };
    expect(listBody.flows.map((f) => f.name)).toEqual(["loads"]);

    const one = await app.request("https://argus.test/v1/flows/loads", { headers }, e);
    expect(one.status).toBe(200);

    const del = await app.request(
      "https://argus.test/v1/flows/loads",
      { method: "DELETE", headers },
      e
    );
    expect(del.status).toBe(200);
    expect((await app.request("https://argus.test/v1/flows/loads", { headers }, e)).status).toBe(404);
  });
});
