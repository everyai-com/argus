import { describe, expect, it } from "vitest";
import { isLocal, leaseLocal, localApi } from "./local";

describe("local (Electron) sessions", () => {
  it("leaves every cloud call alone", async () => {
    expect(await localApi("POST", "/v1/lease", { url: "https://app.dev" })).toBeUndefined();
    expect(await localApi("POST", "/v1/session/s-abc123/act", { action: "reload" })).toBeUndefined();
    expect(isLocal("s-abc123")).toBe(false);
  });

  it("routes a local session's tools here and refuses what it can't do yet", async () => {
    const page = { on: () => {}, url: () => "app://index", title: async () => "Desk", mainFrame: () => ({}) };
    let closed = false;
    const lease = (await leaseLocal({ electron: { app: "/x" } }, async () => ({ page, close: async () => void (closed = true) }))) as {
      sessionId: string;
    };
    expect(isLocal(lease.sessionId)).toBe(true);
    expect(await localApi("POST", `/v1/session/${lease.sessionId}/observe`, {})).toMatchObject({ cursor: 0, route: { url: "app://index" } });
    await expect(localApi("POST", `/v1/session/${lease.sessionId}/record`, {})).rejects.toThrow(/not available for local/);
    expect(await localApi("DELETE", `/v1/session/${lease.sessionId}`, undefined)).toEqual({ ok: true });
    expect(closed).toBe(true);
    await expect(localApi("POST", `/v1/session/${lease.sessionId}/act`, {})).rejects.toThrow(/no such local session/);
  });
});
