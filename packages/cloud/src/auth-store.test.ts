import { describe, expect, it } from "vitest";
import { hostOf, loadAuthProfile, saveAuthProfile } from "./auth-store";

describe("authentication profile scoping", () => {
  it("uses the exact URL host, including non-default ports", () => {
    expect(hostOf("https://app.example.com/account")).toBe("app.example.com");
    expect(hostOf("http://localhost:4173/login")).toBe("localhost:4173");
  });

  it("returns an explicit fallback for invalid URLs", () => {
    expect(hostOf("not a URL")).toBe("unknown");
  });

  it("keeps two tenants' login state separate even for the same host and name", async () => {
    const objects = new Map<string, string>();
    const env = {
      ARTIFACTS: {
        put: async (key: string, value: string) => void objects.set(key, value),
        get: async (key: string) => {
          const value = objects.get(key);
          return value === undefined ? null : { json: async () => JSON.parse(value) };
        },
      },
    } as never;

    await saveAuthProfile(env, "team-a", "default", "app.example.com", {
      cookies: [{ name: "session", value: "a" }],
    });
    await saveAuthProfile(env, "team-b", "default", "app.example.com", {
      cookies: [{ name: "session", value: "b" }],
    });

    const a = await loadAuthProfile(env, "team-a", "default", "app.example.com");
    const b = await loadAuthProfile(env, "team-b", "default", "app.example.com");
    expect(a?.state.cookies).toEqual([{ name: "session", value: "a" }]);
    expect(b?.state.cookies).toEqual([{ name: "session", value: "b" }]);
    expect([...objects.keys()]).toEqual([
      "tenants/team-a/auth/app.example.com/default.json",
      "tenants/team-b/auth/app.example.com/default.json",
    ]);
  });
});
