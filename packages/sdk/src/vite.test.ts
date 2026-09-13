import { describe, expect, it } from "vitest";
import { ARGUS_RUNTIME } from "./vite";

interface FakeArgus {
  signals: Array<{ seq: number; name: string; data: unknown }>;
  signal(name: string, data?: unknown): number;
  registerStore(name: string, getter: () => unknown): void;
  readStore(name: string): { ok: boolean; value?: unknown; error?: string };
  capabilities(): { stores: string[]; signalsSeen: string[]; reactCommits: number };
}

/** Boot the inlined runtime against a fake window, as the plugin does in a page. */
function boot(): { window: { __argus: FakeArgus; __REACT_DEVTOOLS_GLOBAL_HOOK__: any } } {
  const fake: any = {};
  // eslint-disable-next-line no-new-func
  new Function("window", ARGUS_RUNTIME)(fake);
  return { window: fake };
}

const wait = () => new Promise((r) => setTimeout(r, 320));

describe("ARGUS_RUNTIME", () => {
  it("records signals and registered stores", () => {
    const { window } = boot();
    window.__argus.signal("order:placed", { id: 1 });
    window.__argus.registerStore("cart", () => ({ items: 2 }));

    expect(window.__argus.signals).toHaveLength(1);
    expect(window.__argus.readStore("cart")).toEqual({ ok: true, value: { items: 2 } });
    expect(window.__argus.capabilities().stores).toEqual(["cart"]);
  });

  it("installs a React devtools hook before app code loads", () => {
    const { window } = boot();
    expect(window.__REACT_DEVTOOLS_GLOBAL_HOOK__?.supportsFiber).toBe(true);

    window.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot();
    expect(window.__argus.capabilities().reactCommits).toBe(1);
  });

  it("coalesces commits and flags a render storm", async () => {
    const { window } = boot();
    for (let i = 0; i < 30; i++) window.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot();
    await wait();

    const names = window.__argus.signals.map((s) => s.name);
    // one coalesced commit signal, plus the storm marker
    expect(names.filter((n) => n === "react:commit")).toHaveLength(1);
    expect(names).toContain("react:storm");
    expect((window.__argus.signals.find((s) => s.name === "react:commit")?.data as { count: number }).count).toBe(30);
  });

  it("does not flag a quiet commit as a storm", async () => {
    const { window } = boot();
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot();
    await wait();
    expect(window.__argus.signals.map((s) => s.name)).not.toContain("react:storm");
  });
});
