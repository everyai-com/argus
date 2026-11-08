import { describe, expect, it } from "vitest";
import { getPersonaRun, listPersonaRuns, savePersonaRun } from "./personas";
import type { Env } from "./env";

function fakeEnv() {
  const store = new Map<string, { body: string; meta?: Record<string, string> }>();
  const ARTIFACTS = {
    put: async (k: string, body: string, o?: { customMetadata?: Record<string, string> }) => void store.set(k, { body, meta: o?.customMetadata }),
    get: async (k: string) => (store.has(k) ? { json: async () => JSON.parse(store.get(k)!.body) } : null),
    list: async ({ prefix }: { prefix: string }) => ({
      objects: [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, customMetadata: v.meta })),
    }),
  };
  return { env: { ARTIFACTS } as unknown as Env, store };
}

const upload = {
  url: "https://demo.dev/",
  goal: "add my first task",
  reports: [
    { persona: "skeptic", reachedSuccess: false, moments: [] },
    { persona: "impatient", reachedSuccess: true, moments: [] },
  ],
  issues: [
    { key: "/|task-list|data-lost-on-reload", symptom: "data-lost-on-reload", where: "/", element: "task-list", personas: ["skeptic"], severity: "blocker", tier: "consequence" as const, saw: [], expected: [], tried: [], screenshots: [] },
    { key: "/|footer|unclear-copy", symptom: "unclear-copy", where: "/", element: "footer", personas: ["skeptic"], severity: "minor", tier: "dom" as const, saw: [], expected: [], tried: [], screenshots: [] },
  ],
};

describe("persona runs", () => {
  it("stores per tenant, summarises for the list, newest first", async () => {
    const { env } = fakeEnv();
    const a = await savePersonaRun(env, "acme", upload, new Date("2026-10-28T10:00:00Z"));
    await savePersonaRun(env, "acme", { ...upload, goal: "later" }, new Date("2026-10-28T11:00:00Z"));
    await savePersonaRun(env, "other", upload);
    const list = await listPersonaRuns(env, "acme");
    expect(list.map((r) => r.goal)).toEqual(["later", "add my first task"]);
    expect(list[1]).toMatchObject({ id: a.id, reached: 1, personas: 2, issues: 2, worst: "blocker" });
    expect((await getPersonaRun(env, "acme", a.id))?.goal).toBe("add my first task");
  });

  it("never reads outside the tenant's prefix", async () => {
    const { env } = fakeEnv();
    const run = await savePersonaRun(env, "other", upload);
    expect(await getPersonaRun(env, "acme", run.id)).toBeUndefined();
    expect(await getPersonaRun(env, "acme", "../other/personas/x")).toBeUndefined();
  });
});
