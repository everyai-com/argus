/**
 * Vite plugin — one line in vite.config.ts and the app becomes tier-1
 * observable:
 *
 *   import { argus } from "@argus/sdk/vite";
 *   plugins: [react(), argus()]
 *
 * The runtime is injected only outside production builds, so production ships
 * nothing: `signal()` / `registerStore()` calls in your source become inert
 * no-ops rather than dead weight or a data-leak surface.
 */

/**
 * The in-page runtime, inlined as a source string so this plugin entry is
 * self-contained: config files are loaded by Node directly, and a relative
 * import here would have to resolve on disk before the package is built.
 *
 * What it provides, and why it matters: DOM and network tell you what the app
 * *appeared* to do. A signal is the app stating what it actually did
 * (`order:placed`), and a registered store is the app's own source of truth.
 * Neither can be faked by a healed-to-wrong element, which is why they are the
 * strongest evidence Argus can assert on.
 */
export const ARGUS_RUNTIME = /* js */ `
(function () {
  if (window.__argus) return;
  var seq = 0;
  var MAX = 500;
  var signals = [];
  var stores = {};
  window.__argus = {
    version: 1,
    signals: signals,
    /** The app declaring something really happened: argus.signal('order:placed', {id}) */
    signal: function (name, data) {
      signals.push({ seq: ++seq, name: String(name), data: data === undefined ? null : data, at: Date.now() });
      if (signals.length > MAX) signals.shift();
      return seq;
    },
    /** Expose a store's current value: argus.registerStore('cart', () => store.getState()) */
    registerStore: function (name, getter) {
      stores[String(name)] = getter;
    },
    /** Read a registered store — used by Argus, safe to call yourself. */
    readStore: function (name) {
      var getter = stores[name];
      if (!getter) return { ok: false, error: 'no store registered as "' + name + '"' };
      try {
        return { ok: true, value: getter() };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
    /** What this app advertises as testable — a fresh agent can read this. */
    capabilities: function () {
      return { stores: Object.keys(stores), signalsSeen: signals.map(function (s) { return s.name; }).filter(function (v, i, a) { return a.indexOf(v) === i; }) };
    },
  };
})();
`;

export interface ArgusPluginOptions {
  /**
   * Inject even in production builds. Off by default — the runtime exposes
   * app state to anything running in the page, which is fine on a dev/preview
   * origin and not something to ship to real users by accident.
   */
  includeInProduction?: boolean;
}

interface MinimalVitePlugin {
  name: string;
  apply?: "serve" | "build";
  configResolved(config: { mode: string }): void;
  transformIndexHtml: {
    order: "pre";
    handler(html: string): { html: string; tags: Array<Record<string, unknown>> };
  };
}

export function argus(options: ArgusPluginOptions = {}): MinimalVitePlugin {
  // Vite's own `mode` is the right switch: `vite dev` and
  // `vite build --mode staging` get the runtime, a plain production build
  // does not. NODE_ENV would wrongly exclude staging/preview builds, which
  // are exactly the ones worth verifying.
  let inject = true;
  return {
    name: "argus",
    configResolved(config) {
      inject = options.includeInProduction === true || config.mode !== "production";
    },
    transformIndexHtml: {
      order: "pre",
      handler(html: string) {
        if (!inject) return { html, tags: [] };
        return {
          html,
          tags: [
            {
              tag: "script",
              // Must run before app code, so early signals aren't lost.
              injectTo: "head-prepend",
              children: ARGUS_RUNTIME,
            },
          ],
        };
      },
    },
  };
}
