/**
 * @argus/sdk — the optional, dev-only in-app SDK.
 *
 * Argus works with zero install (DOM, network, console, route). This adds the
 * one thing an outside observer structurally cannot get: the app's own account
 * of what happened. Two calls, ~30 seconds of adoption:
 *
 *   import { signal, registerStore } from "@argus/sdk";
 *   registerStore("tasks", () => store.getState().tasks);
 *   signal("task:added", { id });
 *
 * Then assert on them — `{ kind: "signal", name: "task:added" }` is Tier-1
 * evidence: a wrong-but-visible element can't fake it.
 *
 * In production builds these are inert no-ops (the runtime is never injected),
 * so shipping the calls costs nothing.
 */

interface ArgusGlobal {
  version: number;
  signals: Array<{ seq: number; name: string; data: unknown; at: number }>;
  signal(name: string, data?: unknown): number;
  registerStore(name: string, getter: () => unknown): void;
  readStore(name: string): { ok: boolean; value?: unknown; error?: string };
  capabilities(): { stores: string[]; signalsSeen: string[] };
}

declare global {
  interface Window {
    __argus?: ArgusGlobal;
  }
}

const runtime = (): ArgusGlobal | undefined =>
  typeof window === "undefined" ? undefined : window.__argus;

/** Declare that something actually happened. No-op when Argus isn't loaded. */
export function signal(name: string, data?: unknown): void {
  runtime()?.signal(name, data);
}

/** Expose a store so Argus can assert on the app's own truth. */
export function registerStore(name: string, getter: () => unknown): void {
  runtime()?.registerStore(name, getter);
}

/** True when the dev-only runtime is present (i.e. this is a dev/preview build). */
export function isArgusActive(): boolean {
  return runtime() !== undefined;
}

// ---------------------------------------------------------------------------
// State adapters — the common store libraries, duck-typed.
//
// None of these import the library: each takes the shape it actually needs, so
// adopting an adapter is one line and there is no version coupling. Anything
// not listed here still works via `registerStore(name, () => …)`.
// ---------------------------------------------------------------------------

/** zustand, Redux, or anything exposing `getState()`. */
export function registerObservableStore<T>(
  name: string,
  store: { getState(): T }
): void {
  registerStore(name, () => store.getState());
}

/** Svelte stores: `subscribe` yields the current value immediately. */
export function registerSvelteStore(
  name: string,
  store: { subscribe(listener: (value: unknown) => void): unknown }
): void {
  let value: unknown;
  store.subscribe((next) => {
    value = next;
  });
  registerStore(name, () => value);
}

/** Pinia stores expose a reactive `$state` object directly. */
export function registerPiniaStore(name: string, store: { $state: unknown }): void {
  registerStore(name, () => store.$state);
}

/** TanStack Query: the whole cache, keyed by query hash, so a stale cache is visible. */
export function registerQueryClient(
  name: string,
  client: {
    getQueryCache(): {
      getAll(): Array<{ queryHash: string; state: { data?: unknown } }>;
    };
  }
): void {
  registerStore(name, () => {
    const cache: Record<string, unknown> = {};
    for (const query of client.getQueryCache().getAll()) {
      cache[query.queryHash] = query.state.data;
    }
    return cache;
  });
}

export type { ArgusGlobal };
