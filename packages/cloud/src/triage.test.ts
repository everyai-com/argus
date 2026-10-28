import { describe, expect, it } from "vitest";
import type { Finding } from "@argus/shared";
import { applyTriage, CLEAN_VISITS_TO_CLOSE, fingerprintOf, loadTriage, normalizePath, setTriage } from "./triage";
import type { Env } from "./env";

/** In-memory R2 with etag preconditions, so conflict retries are exercised. */
function fakeR2(opts: { conflictOnce?: boolean } = {}) {
  const store = new Map<string, { body: string; etag: string }>();
  let version = 0;
  let conflict = opts.conflictOnce ?? false;
  return {
    store,
    bucket: {
      get: async (key: string) => {
        const o = store.get(key);
        return o ? { etag: o.etag, json: async () => JSON.parse(o.body) } : null;
      },
      put: async (key: string, body: string, options?: { onlyIf?: { etagMatches?: string } }) => {
        const cur = store.get(key);
        if (options?.onlyIf?.etagMatches !== undefined) {
          if (conflict) {
            // Another writer got in first: bump the object and refuse this write.
            conflict = false;
            store.set(key, { body: cur!.body, etag: `e${++version}` });
            return null;
          }
          if (cur?.etag !== options.onlyIf.etagMatches) return null;
        }
        store.set(key, { body, etag: `e${++version}` });
        return {};
      },
    },
  };
}

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "f-1",
  severity: "major",
  category: "console-error",
  summary: "Console error at desktop: boom",
  detail: "Uncaught TypeError: x is undefined at https://app.dev/assets/main-3f9a1c2b.js?v=172893:12",
  evidence: { viewport: "desktop" },
  ...over,
});

const scope = (pageUrl = "https://app.dev/orders/8812") => ({
  pageUrl,
  ranFamilies: new Set(["console", "network", "load", "responsive", "a11y"]),
  viewports: ["desktop" as const],
});

describe("finding identity", () => {
  it("normalises ids out of paths", () => {
    expect(normalizePath("/orders/8812/items/3f9a1c2b77")).toBe("/orders/:id/items/:id");
    expect(normalizePath("/")).toBe("/");
  });

  it("keeps a fingerprint across runs when only volatile parts change", async () => {
    const a = await fingerprintOf(finding(), "https://app.dev/orders/8812");
    const b = await fingerprintOf(
      finding({ detail: "Uncaught TypeError: x is undefined at https://app.dev/assets/main-77aa00ff.js?v=999:14" }),
      "https://app.dev/orders/9917?tab=2"
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{16}$/);
  });

  it("separates genuinely different findings", async () => {
    const a = await fingerprintOf(finding(), "https://app.dev/orders/1");
    const otherError = await fingerprintOf(finding({ detail: "Uncaught RangeError: bad length" }), "https://app.dev/orders/1");
    const otherPage = await fingerprintOf(finding(), "https://app.dev/settings");
    expect(new Set([a, otherError, otherPage]).size).toBe(3);
  });
});

describe("triage memory", () => {
  it("walks new → known → dismissed → reopened → auto-closed → regression", async () => {
    const r2 = fakeR2();
    const env = { ARTIFACTS: r2.bucket } as unknown as Env;

    const first = await applyTriage(env, "t1", [finding()], scope());
    expect(first.newFindings).toBe(1);
    const fp = first.findings[0]!.fingerprint!;
    expect(first.findings[0]!.triage?.state).toBe("new");

    const second = await applyTriage(env, "t1", [finding()], scope());
    expect(second.findings[0]!.triage).toMatchObject({ state: "known", occurrences: 2 });

    // A human dismisses it: it leaves findings (and the verdict) but is listed.
    expect(await setTriage(env, "t1", "app.dev", fp, "dismissed", "third-party widget")).toMatchObject({ status: "dismissed" });
    const third = await applyTriage(env, "t1", [finding()], scope());
    expect(third.findings).toHaveLength(0);
    expect(third.suppressed).toEqual([{ fingerprint: fp, summary: finding().summary, reason: "third-party widget" }]);

    // Reopened, then N covering runs without it close it as fixed.
    await setTriage(env, "t1", "app.dev", fp, "open");
    for (let i = 0; i < CLEAN_VISITS_TO_CLOSE; i++) await applyTriage(env, "t1", [], scope());
    expect((await loadTriage(env, "t1", "app.dev"))[fp]?.status).toBe("fixed");

    const back = await applyTriage(env, "t1", [finding()], scope());
    expect(back.regressions).toBe(1);
    expect(back.findings[0]!.triage?.state).toBe("regression");
  });

  it("only counts a clean visit when the run covered the finding's scope", async () => {
    const r2 = fakeR2();
    const env = { ARTIFACTS: r2.bucket } as unknown as Env;
    const fp = (await applyTriage(env, "t1", [finding()], scope())).findings[0]!.fingerprint!;
    const noConsole = { ...scope(), ranFamilies: new Set(["a11y"]) };
    for (let i = 0; i < CLEAN_VISITS_TO_CLOSE + 1; i++) await applyTriage(env, "t1", [], noConsole);
    await applyTriage(env, "t1", [], scope("https://app.dev/settings")); // another page
    expect((await loadTriage(env, "t1", "app.dev"))[fp]?.status).toBe("open");
  });

  it("retries on a concurrent write instead of losing it", async () => {
    const r2 = fakeR2();
    const env = { ARTIFACTS: r2.bucket } as unknown as Env;
    await applyTriage(env, "t1", [finding()], scope());
    const conflicted = fakeR2({ conflictOnce: true });
    conflicted.store.set([...r2.store.keys()][0]!, [...r2.store.values()][0]!);
    const env2 = { ARTIFACTS: conflicted.bucket } as unknown as Env;
    const out = await applyTriage(env2, "t1", [finding()], scope());
    expect(out.findings[0]!.triage).toMatchObject({ state: "known", occurrences: 2 });
  });

  it("never blocks a run when storage fails", async () => {
    const env = { ARTIFACTS: { get: async () => { throw new Error("r2 down"); }, put: async () => null } } as unknown as Env;
    const out = await applyTriage(env, "t1", [finding()], scope());
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.fingerprint).toMatch(/^[a-f0-9]{16}$/);
  });
});
