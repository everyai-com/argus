import { describe, expect, it } from "vitest";
import { crawlKey } from "./crawl";
import { newIssues } from "./detectors";
import { applyNetwork, applyViewport, contextOptionsFor, settleBudget, slowRequest, trackInflight, waitForQuiet } from "./flow-utils";

describe("crawl scope", () => {
  const origin = "https://app.dev";
  it("normalises same-origin links to origin+path", () => {
    expect(crawlKey("https://app.dev/orders/?tab=2#top", origin)).toBe("https://app.dev/orders?tab=2");
    expect(crawlKey("https://app.dev/x?b=2&a=1&utm_source=mail", origin)).toBe("https://app.dev/x?a=1&b=2");
    expect(crawlKey("https://app.dev/", origin)).toBe("https://app.dev/");
  });
  it("never leaves the origin, never signs out, never downloads", () => {
    expect(crawlKey("https://evil.dev/x", origin)).toBeUndefined();
    expect(crawlKey("https://app.dev/logout", origin)).toBeUndefined();
    expect(crawlKey("https://app.dev/account/sign-out", origin)).toBeUndefined();
    expect(crawlKey("https://app.dev/report.pdf", origin)).toBeUndefined();
    expect(crawlKey("mailto:a@b.c", origin)).toBeUndefined();
    expect(crawlKey("javascript:void(0)", origin)).toBeUndefined();
  });
  it("respects an include prefix", () => {
    expect(crawlKey("https://app.dev/app/settings", origin, "/app")).toBe("https://app.dev/app/settings");
    expect(crawlKey("https://app.dev/blog/post", origin, "/app")).toBeUndefined();
  });
});

describe("post-action detectors", () => {
  const before = [{ rule: "layout/occluded-control" as const, count: 1, samples: ["a"] }];
  it("blames the action only for what it added", () => {
    const after = [
      { rule: "layout/occluded-control" as const, count: 3, samples: ["a", "b"] },
      { rule: "content/raw-value" as const, count: 1, samples: ['"NaN"'] },
    ];
    expect(newIssues(before, after, false)).toEqual([
      { rule: "layout/occluded-control", count: 2, samples: ["a", "b"] },
      { rule: "content/raw-value", count: 1, samples: ['"NaN"'] },
    ]);
    expect(newIssues(before, before, false)).toEqual([]);
  });
  it("after a navigation, every problem on the new page is new", () => {
    expect(newIssues(before, before, true)).toEqual([{ rule: "layout/occluded-control", count: 1, samples: ["a"] }]);
  });
});

describe("viewport action", () => {
  const fakePage = () => {
    const calls: unknown[] = [];
    return {
      calls,
      page: {
        viewportSize: () => ({ width: 1280, height: 800 }),
        setViewportSize: async (s: unknown) => void calls.push(["size", s]),
        emulateMedia: async (m: unknown) => void calls.push(["media", m]),
      } as never,
    };
  };
  it("applies presets, exact sizes and colour scheme", async () => {
    const a = fakePage();
    await applyViewport(a.page, { action: "viewport", viewport: "mobile", colorScheme: "dark" });
    expect(a.calls).toEqual([["size", { width: 375, height: 812 }], ["media", { colorScheme: "dark" }]]);
    const b = fakePage();
    await applyViewport(b.page, { action: "viewport", width: 900 });
    expect(b.calls).toEqual([["size", { width: 900, height: 800 }]]);
  });
  it("refuses an empty viewport action", async () => {
    await expect(applyViewport(fakePage().page, { action: "viewport" })).rejects.toThrow(/needs/);
  });
});

describe("network action", () => {
  const fakePage = () => {
    const calls: unknown[] = [];
    const cdp = { send: async (m: string, p?: unknown) => void calls.push([m, p]) };
    const context = {
      setOffline: async (o: boolean) => void calls.push(["offline", o]),
      newCDPSession: async () => (calls.push(["attach"]), cdp),
    };
    return { calls, page: { context: () => context } as never };
  };
  it("throttles over ONE CDP session and lifts it on none", async () => {
    const a = fakePage();
    await applyNetwork(a.page, "slow3g");
    await applyNetwork(a.page, "none");
    expect(a.calls.filter((c) => (c as unknown[])[0] === "attach")).toHaveLength(1);
    expect(a.calls).toContainEqual([
      "Network.emulateNetworkConditions",
      { offline: false, latency: 2000, downloadThroughput: 50_000, uploadThroughput: 50_000 },
    ]);
    expect(a.calls.at(-1)).toEqual([
      "Network.emulateNetworkConditions",
      { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
    ]);
  });
  it("goes offline through the context without attaching CDP", async () => {
    const a = fakePage();
    await applyNetwork(a.page, "offline");
    expect(a.calls).toEqual([["offline", true]]);
  });
});

describe("settle budget", () => {
  it("waits out two throttled round trips, capped, and never waits longer offline", () => {
    expect(settleBudget(2_000, undefined)).toBe(2_000);
    expect(settleBudget(2_000, "offline")).toBe(2_000);
    expect(settleBudget(2_000, "slow3g")).toBe(6_000);
    expect(settleBudget(12_000, "slow3g")).toBe(15_000);
  });
});

describe("post-action settle", () => {
  const fakePage = () => {
    const handlers: Record<string, ((r: unknown) => void)[]> = {};
    const page = { on: (e: string, h: (r: unknown) => void) => void (handlers[e] ??= []).push(h) } as never;
    const emit = (e: string, r: unknown) => handlers[e]?.forEach((h) => h(r));
    return { page, emit };
  };
  const req = (type = "fetch") => ({ resourceType: () => type });

  it("waits for a request the action started, even after the page was idle", async () => {
    const { page, emit } = fakePage();
    trackInflight(page);
    const since = Date.now();
    const r = req();
    emit("request", r);
    setTimeout(() => emit("requestfinished", r), 300);
    const t0 = Date.now();
    await waitForQuiet(page, since, 5_000, 100);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(380);
  });

  it("ignores requests older than the action and streams that never end", async () => {
    const { page, emit } = fakePage();
    trackInflight(page);
    emit("request", req()); // hung beacon from page load
    await new Promise((r) => setTimeout(r, 5));
    const since = Date.now();
    emit("request", req("eventsource"));
    const t0 = Date.now();
    await waitForQuiet(page, since, 5_000, 100);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe("mid-request sampling", () => {
  const fakePage = () => {
    const handlers: Record<string, ((r: unknown) => void)[]> = {};
    const page = { on: (e: string, h: (r: unknown) => void) => void (handlers[e] ??= []).push(h) } as never;
    const emit = (e: string, r: unknown) => handlers[e]?.forEach((h) => h(r));
    return { page, emit };
  };
  const req = () => ({ resourceType: () => "fetch" });

  it("reports a request the action started once it has been pending long enough", async () => {
    const { page, emit } = fakePage();
    trackInflight(page);
    const since = Date.now();
    emit("request", req());
    expect(await slowRequest(page, since, 100)).toBe(1);
  });

  it("stays out of the way when the request finishes fast or never starts", async () => {
    const { page, emit } = fakePage();
    trackInflight(page);
    const since = Date.now();
    const r = req();
    emit("request", r);
    setTimeout(() => emit("requestfinished", r), 20);
    expect(await slowRequest(page, since, 150)).toBe(0);
    expect(await slowRequest(page, Date.now(), 150)).toBe(0);
  });
});

describe("phone preset", () => {
  it("is a touch device with a mobile Chrome identity on the real engine version", () => {
    const o = contextOptionsFor("phone", "HeadlessChrome/133.0.6943.16") as Record<string, unknown>;
    expect(o).toMatchObject({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    expect(o.userAgent).toContain("Chrome/133.0.6943.16 Mobile");
  });
  it("leaves mobile a plain small window, so its baselines still compare", () => {
    expect(contextOptionsFor("mobile")).toEqual({ viewport: { width: 375, height: 812 } });
  });
});
