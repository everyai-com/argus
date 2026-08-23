import { describe, expect, it } from "vitest";
import { GitHubPlatformConfigSchema } from "@argus/shared";
import { verifyGitHubWebhook } from "./github-app";

async function signature(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

describe("GitHub App security boundary", () => {
  it("accepts only an exact sha256 webhook signature", async () => {
    const body = JSON.stringify({ action: "opened", repository: { name: "argus" } });
    const signed = await signature(body, "webhook-secret");
    expect(await verifyGitHubWebhook(body, "webhook-secret", signed)).toBe(true);
    expect(await verifyGitHubWebhook(`${body} `, "webhook-secret", signed)).toBe(false);
    expect(await verifyGitHubWebhook(body, "wrong-secret", signed)).toBe(false);
    expect(await verifyGitHubWebhook(body, "webhook-secret", "sha1=bad")).toBe(false);
  });

  it("defaults a minimal committed platform config without accepting secrets", () => {
    const config = GitHubPlatformConfigSchema.parse({ targetUrl: "https://preview.example.com" });
    expect(config).toMatchObject({
      targetUrl: "https://preview.example.com",
      checks: ["smoke", "audit", "flows"],
      viewports: ["mobile", "desktop"],
      colorSchemes: ["light"],
      flowConcurrency: 3,
    });
    expect(GitHubPlatformConfigSchema.safeParse({ targetUrl: "not-a-url" }).success).toBe(false);
    expect(
      GitHubPlatformConfigSchema.safeParse({
        targetUrl: "https://preview.example.com",
        token: "must-not-be-accepted",
      }).success
    ).toBe(false);
  });
});
