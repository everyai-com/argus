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

export type { ArgusGlobal };
