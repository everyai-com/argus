/**
 * Shared warm-browser pool helpers for the batch paths (flow replay, smoke,
 * audit) that run in the Worker rather than in a BrowserSession DO.
 *
 * Launching a Browser Rendering session is a ~1-2s cold start and the paid
 * launch rate is only ONE per second, so a suite of N parallel flows that each
 * launch their own browser serializes on that limit. These helpers borrow a
 * warm browser from the Coordinator's free-list (shared with the lease path)
 * and `connect()` instead — and hand it back on finish instead of closing it.
 *
 * Safe by construction: a dead warm id (its keep_alive elapsed) fails the
 * connect and falls through to launch(); a browser the pool won't take is
 * closed here so browsers can't leak toward the 120/account cap.
 */
import { connect, launch, type Browser } from "@cloudflare/playwright";
import type { Env } from "./env";

const KEEP_ALIVE_MS = 600_000; // 10 min — the Cloudflare maximum

/**
 * Cold-launch a browser through the Coordinator's launch limiter so a burst of
 * launches is staggered to <=1/sec (CF's cap) and completes, instead of racing
 * the rate limit and failing. A congested queue (waitMs null) throws so the
 * caller backpressures rather than holding the request open indefinitely.
 */
export async function throttledLaunch(env: Env): Promise<Browser> {
  const coord = env.COORDINATOR.get(env.COORDINATOR.idFromName("main"));
  const { waitMs } = await coord
    .fetch("https://do/launch-token", { method: "POST", body: "{}" })
    .then((r) => r.json<{ waitMs: number | null }>())
    .catch(() => ({ waitMs: 0 as number | null }));
  if (waitMs === null) {
    throw new Error("launch queue congested — too many cold launches in flight, retry shortly");
  }
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  return await launch(env.BROWSER, { keep_alive: KEEP_ALIVE_MS });
}

export async function acquirePooledBrowser(env: Env): Promise<Browser> {
  const coord = env.COORDINATOR.get(env.COORDINATOR.idFromName("main"));
  const warm = await coord
    .fetch("https://do/warm-acquire", { method: "POST", body: "{}" })
    .then((r) => r.json<{ warmSessionId?: string }>())
    .catch(() => ({}) as { warmSessionId?: string });
  if (warm.warmSessionId) {
    try {
      return await connect(env.BROWSER, warm.warmSessionId);
    } catch {
      /* the warm session died — fall through to a fresh launch */
    }
  }
  return await throttledLaunch(env);
}

export async function releasePooledBrowser(env: Env, browser: Browser): Promise<void> {
  // Leave a clean, context-free browser behind so the next borrower starts fresh.
  try {
    await Promise.all(browser.contexts().map((c) => c.close().catch(() => {})));
  } catch {
    /* ignore */
  }
  let sid: string | undefined;
  try {
    sid = browser.sessionId();
  } catch {
    /* a sessionless browser cannot be pooled */
  }
  const coord = env.COORDINATOR.get(env.COORDINATOR.idFromName("main"));
  const parked = sid
    ? await coord
        .fetch("https://do/warm-release", {
          method: "POST",
          body: JSON.stringify({ warmSessionId: sid }),
        })
        .then((r) => r.json<{ parked?: boolean }>())
        .then((r) => true === r.parked)
        .catch(() => false)
    : false;
  if (!parked) {
    try {
      await browser.close();
    } catch {
      /* already gone */
    }
  }
}
