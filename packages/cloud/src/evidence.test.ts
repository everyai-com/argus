import { describe, expect, it } from "vitest";
import { signedEvidenceUrl, verifyEvidenceSignature } from "./evidence";

describe("signed evidence links", () => {
  it("accepts an untampered link only before its expiry", async () => {
    const now = Date.UTC(2026, 7, 24, 0, 0, 0);
    const url = new URL(
      await signedEvidenceUrl("secret", "https://argus.example", "gh-123", "run-1", now)
    );
    const resource = "run:gh-123:run-1";
    expect(
      await verifyEvidenceSignature(
        "secret",
        resource,
        url.searchParams.get("expires") ?? undefined,
        url.searchParams.get("sig") ?? undefined,
        now
      )
    ).toBe(true);
    expect(
      await verifyEvidenceSignature(
        "secret",
        "run:gh-123:run-2",
        url.searchParams.get("expires") ?? undefined,
        url.searchParams.get("sig") ?? undefined,
        now
      )
    ).toBe(false);
    expect(
      await verifyEvidenceSignature(
        "secret",
        resource,
        url.searchParams.get("expires") ?? undefined,
        url.searchParams.get("sig") ?? undefined,
        now + 25 * 60 * 60 * 1000
      )
    ).toBe(false);
  });
});
