import { describe, expect, it, vi } from "vitest";
import app from "./index";

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
