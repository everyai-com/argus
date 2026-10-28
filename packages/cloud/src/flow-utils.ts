import type { CDPSession, Page } from "@cloudflare/playwright";
import { NETWORK_PROFILES, VIEWPORTS, type Action, type Flow, type NetworkProfile, type Predicate, type ViewportName } from "@argus/shared";

/**
 * Re-home a flow onto another environment without changing its path, query,
 * fragment, anchors, or assertions.
 */
export function rehomeFlow(flow: Flow, baseUrl: string): Flow {
  try {
    const base = new URL(baseUrl);
    const original = new URL(flow.startUrl);
    // Hostname and port separately: assigning `.host` keeps the flow's
    // original port, which transplants e.g. :5199 onto a tunnel URL.
    original.protocol = base.protocol;
    original.hostname = base.hostname;
    original.port = base.port;
    return { ...flow, startUrl: original.toString() };
  } catch {
    return flow;
  }
}

/**
 * The `viewport` action: switch preset/size and/or colour scheme in place.
 * An exact width/height overrides the preset's dimension.
 */
export async function applyViewport(page: Page, action: Extract<Action, { action: "viewport" }>): Promise<void> {
  const preset = action.viewport ? VIEWPORTS[action.viewport] : undefined;
  const current = page.viewportSize() ?? VIEWPORTS.desktop;
  const width = action.width ?? preset?.width;
  const height = action.height ?? preset?.height;
  if (width === undefined && height === undefined && !action.colorScheme) {
    throw new Error("viewport action needs a viewport preset, a width/height, or a colorScheme");
  }
  if (width !== undefined || height !== undefined) {
    await page.setViewportSize({ width: width ?? current.width, height: height ?? current.height });
  }
  if (action.colorScheme) await page.emulateMedia({ colorScheme: action.colorScheme });
}

// One CDP session per page: a second session would carry its own (stale)
// emulation state, and which one Chromium honours is not something to bet on.
const cdpSessions = new WeakMap<Page, CDPSession>();

/**
 * The `network` action (and a lease's `network`): throttle to a DevTools
 * preset, go offline, or lift both with `none`. Offline goes through the
 * context so it also covers workers; throttling needs CDP.
 */
export async function applyNetwork(page: Page, profile: NetworkProfile): Promise<void> {
  await page.context().setOffline(profile === "offline");
  let cdp = cdpSessions.get(page);
  if (!cdp) {
    if (profile === "none" || profile === "offline") return; // never throttled: nothing to lift
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    cdpSessions.set(page, cdp);
  }
  const p = profile === "none" || profile === "offline" ? undefined : NETWORK_PROFILES[profile];
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: p?.latency ?? 0,
    downloadThroughput: p?.downloadThroughput ?? -1,
    uploadThroughput: p?.uploadThroughput ?? -1,
  });
}

/**
 * How long to wait for the network to go idle after an action, given the
 * session's throttling. Too short under slow3g and a POST still in flight
 * reads as `silentAction` — a dead button that isn't dead (a false finding).
 * Too long and every act on a chatty page burns the lease waiting.
 */
export function settleBudget(baseMs: number, network: NetworkProfile | undefined): number {
  // Offline requests fail at once: waiting longer only stalls the lease.
  if (!network || network === "none" || network === "offline") return baseMs;
  // A submit is typically two round trips (the POST, then a refetch/redirect).
  return Math.min(baseMs + 2 * NETWORK_PROFILES[network].latency, 15_000);
}

// Requests in flight per page, with their start time. `waitForLoadState
// ("networkidle")` is a lifecycle event of the DOCUMENT: once the page has been
// idle it resolves at once, so it never waited for a fetch an action started —
// a slow POST read as `silentAction` (a dead button that wasn't dead).
const inflight = new WeakMap<
  Page,
  { pending: Map<unknown, number>; waiting: Map<unknown, { at: number; type: string }>; last: number }
>();

/** Start counting requests on a page. Call before the first action. */
export function trackInflight(page: Page): void {
  if (inflight.has(page)) return;
  const s = { pending: new Map<unknown, number>(), waiting: new Map<unknown, { at: number; type: string }>(), last: 0 };
  inflight.set(page, s);
  page.on("request", (req) => {
    // Streams never finish; counting them would stall every settle to its timeout.
    const type = req.resourceType();
    if (type === "eventsource" || type === "websocket") return;
    s.pending.set(req, Date.now());
    s.waiting.set(req, { at: Date.now(), type });
    s.last = Date.now();
  });
  // A response means the app has its answer — from here the UI may already be
  // done even though the body (and "requestfinished") is still arriving.
  page.on("response", (res) => void s.waiting.delete(res.request()));
  const done = (req: unknown) => {
    s.waiting.delete(req);
    if (s.pending.delete(req)) s.last = Date.now();
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
}

/**
 * Wait until every request started at or after `since` has finished and the
 * network has been quiet for `quietMs`, or `timeoutMs` passes. Requests older
 * than `since` (a hung beacon from page load) don't hold the action hostage.
 */
export async function waitForQuiet(page: Page, since: number, timeoutMs: number, quietMs = 250): Promise<void> {
  const s = inflight.get(page);
  if (!s) {
    await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});
    return;
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let busy = false;
    for (const t of s.pending.values()) if (t >= since) busy = true;
    if (!busy && Date.now() - Math.max(s.last, start) >= quietMs) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Is the app still WAITING on a fetch/XHR the action started, `slowMs` after
 * it went out? Polls briefly (a click's fetch reaches us a few ms after the
 * click returns) and returns how many are waiting — 0 when nothing started or
 * everything answered fast. Only the app's own data requests count: a
 * document load shows the browser's own progress, and a request that already
 * has its response may have a UI that is (rightly) back to normal — sampling
 * then reported "no feedback" for pages that had simply finished.
 */
export async function slowRequest(page: Page, since: number, slowMs = 150, windowMs = 600): Promise<number> {
  const s = inflight.get(page);
  if (!s) return 0;
  const start = Date.now();
  while (Date.now() - start < windowMs) {
    const now = Date.now();
    let pending = 0;
    let slow = false;
    for (const w of s.waiting.values()) {
      if (w.at < since || (w.type !== "fetch" && w.type !== "xhr")) continue;
      pending++;
      if (now - w.at >= slowMs) slow = true;
    }
    if (slow) return pending;
    if (pending === 0 && now - start >= 100) return 0;
    await new Promise((r) => setTimeout(r, 25));
  }
  return 0;
}

const EVENT_WINDOW = new Set(["network", "console-clean", "stream", "signal"]);

/** Does this predicate describe the page's state (so it can be re-checked after a reload)? */
export function describesState(p: Predicate): boolean {
  if (p.kind === "allOf" || p.kind === "anyOf") return p.predicates.every(describesState);
  return !EVENT_WINDOW.has(p.kind);
}

/** The predicates a flow's `persists` asks to re-check after a reload. */
export function persistPredicates(flow: Flow): Predicate[] {
  if (!flow.persists) return [];
  return flow.persists === "success" ? flow.success.filter(describesState) : flow.persists;
}

/**
 * Browser-context options for a viewport preset. `phone` is a touch device
 * with a mobile Chrome identity built from the real browser version (the
 * engine IS Chromium, so claiming iOS Safari would send sites down WebKit
 * paths this browser can't run). Touch and identity are per-context: a
 * mid-session `viewport` action can resize, but only a `phone` lease taps.
 */
export function contextOptionsFor(name: ViewportName, browserVersion?: string) {
  const viewport = VIEWPORTS[name];
  if (name !== "phone") return { viewport };
  const chrome = (browserVersion ?? "").match(/\d+\.\d+\.\d+\.\d+/)?.[0] ?? "131.0.0.0";
  return {
    viewport,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    userAgent: `Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Mobile Safari/537.36`,
  };
}
