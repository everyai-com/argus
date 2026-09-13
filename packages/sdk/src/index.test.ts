import { beforeEach, describe, expect, it } from "vitest";
import {
  registerObservableStore,
  registerPiniaStore,
  registerQueryClient,
  registerSvelteStore,
  registerStore,
} from "./index";

/** Capture what the adapters register, standing in for the injected runtime. */
const stores: Record<string, () => unknown> = {};

beforeEach(() => {
  for (const key of Object.keys(stores)) delete stores[key];
  (globalThis as unknown as { window: unknown }).window = {
    __argus: {
      version: 1,
      signals: [],
      signal: () => 0,
      registerStore: (name: string, getter: () => unknown) => {
        stores[name] = getter;
      },
      readStore: () => ({ ok: true }),
      capabilities: () => ({ stores: [], signalsSeen: [] }),
    },
  };
});

describe("state adapters", () => {
  it("reads getState() stores (zustand / Redux)", () => {
    registerObservableStore("cart", { getState: () => ({ items: 2 }) });
    expect(stores.cart?.()).toEqual({ items: 2 });
  });

  it("reads Svelte stores from their subscribe callback", () => {
    const store = {
      subscribe(listener: (value: unknown) => void) {
        listener("current");
        return () => {};
      },
    };
    registerSvelteStore("svelte", store);
    expect(stores.svelte?.()).toBe("current");
  });

  it("reads Pinia $state", () => {
    registerPiniaStore("pinia", { $state: { count: 2 } });
    expect(stores.pinia?.()).toEqual({ count: 2 });
  });

  it("exposes the TanStack Query cache keyed by query hash", () => {
    registerQueryClient("query", {
      getQueryCache: () => ({
        getAll: () => [
          { queryHash: '["todos"]', state: { data: [1, 2] } },
          { queryHash: '["user"]', state: {} },
        ],
      }),
    });
    expect(stores.query?.()).toEqual({ '["todos"]': [1, 2], '["user"]': undefined });
  });

  it("still supports the generic escape hatch", () => {
    registerStore("custom", () => 42);
    expect(stores.custom?.()).toBe(42);
  });
});
