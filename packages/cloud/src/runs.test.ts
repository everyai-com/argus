import { describe, expect, it } from "vitest";
import { fleetView, listRuns, writeRunMeta, type RunMeta } from "./runs";
import type { Env } from "./env";

/** In-memory R2: lexical listing with prefix/delimiter/limit/cursor and custom metadata. */
function fakeR2() {
  const store = new Map<string, { body: string; customMetadata?: Record<string, string>; uploaded: Date }>();
  let gets = 0;
  const bucket = {
    head: async (key: string) => (store.has(key) ? {} : null),
    get: async (key: string) => {
      gets++;
      const o = store.get(key);
      return o ? { json: async () => JSON.parse(o.body) } : null;
    },
    put: async (key: string, body: string, opts?: { customMetadata?: Record<string, string> }) => {
      store.set(key, { body, customMetadata: opts?.customMetadata, uploaded: new Date() });
    },
    list: async (o: { prefix: string; delimiter?: string; limit?: number; cursor?: string }) => {
      const keys = [...store.keys()].filter((k) => k.startsWith(o.prefix)).sort();
      if (o.delimiter) {
        const prefixes = [...new Set(keys.map((k) => o.prefix + k.slice(o.prefix.length).split(o.delimiter!)[0] + o.delimiter))];
        return { objects: [], delimitedPrefixes: prefixes, truncated: false };
      }
      const page = keys.slice(0, o.limit ?? 1000);
      return {
        objects: page.map((key) => ({ key, customMetadata: store.get(key)!.customMetadata, uploaded: store.get(key)!.uploaded })),
        delimitedPrefixes: [],
        truncated: false,
      };
    },
  };
  return { bucket, store, gets: () => gets };
}

const meta = (runId: string, at: string, tenantId?: string, project = "app"): RunMeta => ({
  runId,
  kind: "smoke",
  url: "https://app.dev/",
  status: "pass",
  at,
  tenantId,
  project,
});

describe("run index", () => {
  it("lists newest first, per tenant, from one list call", async () => {
    const r2 = fakeR2();
    const env = { ARTIFACTS: r2.bucket } as unknown as Env;
    await writeRunMeta(env, meta("zzz", "2026-10-01T00:00:00Z", "a"));
    await writeRunMeta(env, meta("aaa", "2026-10-03T00:00:00Z", "a"));
    await writeRunMeta(env, meta("mmm", "2026-10-02T00:00:00Z", "b"));
    await listRuns(env, 1); // first call runs the one-time backfill
    const before = r2.gets();
    const a = await listRuns(env, 10, "a");
    expect(a.map((m) => m.runId)).toEqual(["aaa", "zzz"]); // by time, not by random id
    expect(r2.gets() - before).toBe(0); // no per-run reads
    expect((await listRuns(env, 10)).map((m) => m.runId)).toEqual(["aaa", "mmm", "zzz"]);
    expect((await listRuns(env, 1)).map((m) => m.runId)).toEqual(["aaa"]);
  });

  it("backfills runs written before the index existed, once", async () => {
    const r2 = fakeR2();
    const env = { ARTIFACTS: r2.bucket } as unknown as Env;
    // A legacy run: meta.json only, no index entries.
    await r2.bucket.put("runs/old1/meta.json", JSON.stringify(meta("old1", "2026-09-01T00:00:00Z")));
    await writeRunMeta(env, meta("new1", "2026-10-01T00:00:00Z"));
    expect((await listRuns(env, 10, "_admin")).map((m) => m.runId)).toEqual(["new1", "old1"]);
    const gets = r2.gets();
    await listRuns(env, 10);
    expect(r2.gets()).toBe(gets); // marker set: no second scan
  });

  it("builds the fleet board from the index", async () => {
    const r2 = fakeR2();
    const env = { ARTIFACTS: r2.bucket } as unknown as Env;
    await writeRunMeta(env, { ...meta("r1", "2026-10-01T00:00:00Z", "a", "web"), status: "fail" });
    await writeRunMeta(env, meta("r2", "2026-10-02T00:00:00Z", "a", "web"));
    const fleet = await fleetView(env, "a");
    expect(fleet).toEqual([expect.objectContaining({ project: "web", runs: 2, failing: 1, latest: expect.objectContaining({ runId: "r2" }) })]);
  });
});
