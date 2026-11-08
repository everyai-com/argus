/**
 * Deterministic capture for visual comparison.
 *
 * A pixel diff is only as honest as the two frames it compares. Rendering noise
 * (a ticking clock, a carousel mid-slide, a blinking caret, an analytics
 * widget) shows up as a "regression" and teaches teams to ignore the red — so
 * the capture is pinned in code rather than tuned with a tolerance knob.
 *
 * Browser Rendering runs a managed Chromium (no launch flags, no pinned image),
 * so everything here works through the page and the context: a frozen clock and
 * seeded randomness, motion killed, third-party noise blocked, fonts awaited,
 * and a STABILITY GATE — two consecutive byte-identical frames, never a sleep.
 * A screen that never settles is reported as untestable, not as a diff.
 *
 * (Approach after bugpatrol's determinism contract, Apache-2.0.)
 */
import type { BrowserContext, Page } from "@cloudflare/playwright";

/** Freeze `Date`/`performance.now` at one instant and seed `Math.random`. */
export function freezeScript(epochMs: number, seed = 0x5eed): string {
  return `(() => {
  const FROZEN = ${Math.floor(epochMs)};
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) { super(...(args.length === 0 ? [FROZEN] : args)); }
    static now() { return FROZEN; }
  }
  globalThis.Date = FrozenDate;
  const perfNow = performance.now();
  performance.now = () => perfNow;
  let seed = ${seed >>> 0};
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();`;
}

/** Kills animation, transition and the caret — motion is never "the page". */
export const STABILITY_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  scroll-behavior: auto !important;
  caret-color: transparent !important;
}`;

/**
 * Analytics, ads, session-replay and chat widgets: non-deterministic by design,
 * and the main path page data leaves through. Blocked during the capture only.
 */
const NOISE_HOSTS = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "facebook.net",
  "connect.facebook.net",
  "hotjar.com",
  "fullstory.com",
  "segment.io",
  "segment.com",
  "mixpanel.com",
  "amplitude.com",
  "heapanalytics.com",
  "intercom.io",
  "intercomcdn.com",
  "crisp.chat",
  "drift.com",
  "zdassets.com",
  "clarity.ms",
  "plausible.io",
  "posthog.com",
  "tiktok.com",
  "linkedin.com/px",
  "bat.bing.com",
];

export function isNoiseRequest(url: string): boolean {
  let host: string;
  try {
    const u = new URL(url);
    host = u.host + u.pathname;
  } catch {
    return false;
  }
  return NOISE_HOSTS.some((h) => host === h || host.includes(`.${h}`) || host.startsWith(h));
}

/** Route third-party noise to an abort; returns a live count of what was blocked. */
export async function blockNoise(context: BrowserContext): Promise<{ count: () => number }> {
  let blocked = 0;
  await context.route("**/*", async (route) => {
    if (isNoiseRequest(route.request().url())) {
      blocked++;
      await route.abort().catch(() => {});
    } else {
      await route.continue().catch(() => {});
    }
  });
  return { count: () => blocked };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface StableFrame {
  png: Uint8Array;
  frames: number;
}

/**
 * Capture until `needed` consecutive frames are byte-identical. Returns
 * undefined when the screen never settles within `timeoutMs` — the caller
 * reports that as untestable, never as a regression.
 */
export async function waitForStableFrame(
  page: Page,
  opts: { mask?: string[]; needed?: number; intervalMs?: number; timeoutMs?: number } = {}
): Promise<StableFrame | undefined> {
  const needed = opts.needed ?? 2;
  const intervalMs = opts.intervalMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const started = Date.now();
  await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});
  const mask = (opts.mask ?? []).map((sel) => page.locator(sel));

  let previous: string | undefined;
  let identical = 1;
  let frames = 0;
  while (Date.now() - started < timeoutMs) {
    const png = await page.screenshot({
      type: "png",
      fullPage: false,
      animations: "disabled",
      caret: "hide",
      ...(mask.length ? { mask, maskColor: "#ff00ff" } : {}),
    });
    frames++;
    const hash = await sha256(png);
    if (hash === previous) {
      identical++;
      if (identical >= needed) return { png, frames };
    } else {
      identical = 1;
      previous = hash;
    }
    await page.waitForTimeout(intervalMs);
  }
  return undefined;
}

/**
 * Share of the viewport (0..1) covered by the masked elements — reported with
 * every diff so a green result can't hide that most of the screen was ignored.
 */
export async function maskedShare(page: Page, selectors: string[]): Promise<number> {
  if (selectors.length === 0) return 0;
  return await page
    .evaluate((sels: string[]) => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      // Rasterise onto a coarse grid so overlapping masks aren't double-counted.
      const cell = 8;
      const cols = Math.ceil(w / cell);
      const rows = Math.ceil(h / cell);
      const hit = new Uint8Array(cols * rows);
      for (const sel of sels) {
        let nodes: any[] = [];
        try {
          nodes = Array.from(document.querySelectorAll(sel)) as any[];
        } catch {
          continue; // invalid selector: masks nothing
        }
        for (const el of nodes) {
          const r = el.getBoundingClientRect();
          const x0 = Math.max(0, Math.floor(r.left / cell));
          const y0 = Math.max(0, Math.floor(r.top / cell));
          const x1 = Math.min(cols, Math.ceil(r.right / cell));
          const y1 = Math.min(rows, Math.ceil(r.bottom / cell));
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hit[y * cols + x] = 1;
        }
      }
      let n = 0;
      for (const v of hit) n += v;
      return n / hit.length;
    }, selectors)
    .catch(() => 0);
}

/** Above this share masked, a visual compare is hollow and says so. */
export const HOLLOW_MASK_SHARE = 0.5;
