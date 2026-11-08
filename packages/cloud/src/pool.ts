/**
 * Shared warm-browser pool helpers for the batch paths (flow replay, smoke,
 * audit) that run in the Worker rather than in a BrowserSession DO.
 *
 * Launching a browser session is a ~1-2s cold start and the paid launch rate
 * is THREE per second, so a suite of N parallel flows that each
 * launch their own browser serializes on that limit. These helpers borrow a
 * warm browser from the Coordinator's free-list (shared with the lease path)
 * and `connect()` instead — and hand it back on finish instead of closing it.
 *
 * Every batch browser holds a Coordinator slot exactly like an interactive
 * lease, so tenant burst ceilings, reserved floors and ARGUS_MAX_SESSIONS cover
 * ALL browsers. (They used to cover leases only: a burst-2 tenant could run 8
 * browsers per /v1/flows/verify call, and any number of calls, while the
 * Coordinator reported active 0.)
 *
 * Safe by construction: a dead warm id (its keep_alive elapsed) fails the
 * connect and falls through to launch(); a browser the pool won't take is
 * closed here so browsers can't leak toward the 200/account cap.
 */
import { connect, launch, type Browser } from "@cloudflare/playwright";
import type { SessionInfo } from "@argus/shared";
import type { Env } from "./env";

const KEEP_ALIVE_MS = 600_000; // 10 min — the Cloudflare maximum
/** How long a batch browser waits for a slot before giving up (suites queue). */
const SLOT_WAIT_MS = 45_000;
/** A batch slot's accounting lifetime; reconcile frees it if we never release. */
const SLOT_TTL_MS = 600_000;

/** No slot within SLOT_WAIT_MS — map to 429 with the Coordinator's reason. */
export class FleetBusyError extends Error {
  constructor(
    readonly reason: string,
    detail: string
  ) {
    super(detail);
    this.name = "FleetBusyError";
  }
}

export interface PooledBrowser {
  browser: Browser;
  /** The Coordinator slot this browser holds (a `batch` session record). */
  slotId: string;
}

function coordinator(env: Env) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName("main"));
}

/**
 * Cold-launch a browser through the Coordinator's launch limiter so a burst of
 * launches is staggered to <=3/sec (CF's cap) and completes, instead of racing
 * the rate limit and failing. A congested queue (waitMs null) throws so the
 * caller backpressures rather than holding the request open indefinitely.
 */
export async function throttledLaunch(env: Env): Promise<Browser> {
  const { waitMs } = await coordinator(env)
    .fetch("https://do/launch-token", { method: "POST", body: "{}" })
    .then((r) => r.json<{ waitMs: number | null }>())
    // Limiter unreachable: don't fail open into CF's 3/sec cap — a jittered
    // pause spreads a burst out instead of stampeding the launch API.
    .catch(() => ({ waitMs: (1_000 + Math.floor(Math.random() * 1_000)) as number | null }));
  if (waitMs === null) {
    throw new Error("launch queue congested — too many cold launches in flight, retry shortly");
  }
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  return await launch(env.BROWSER, { keep_alive: KEEP_ALIVE_MS });
}

/**
 * Take a Coordinator slot for this tenant, waiting (with backoff) while it is
 * at its burst ceiling or the fleet is saturated — a suite run with more
 * concurrency than the tenant may use simply queues. Returns the warm browser
 * id the Coordinator handed out with the slot, if any.
 */
async function acquireSlot(
  env: Env,
  tenantId: string,
  label: string
): Promise<{ slotId: string; warmSessionId?: string }> {
  const slotId = `b-${crypto.randomUUID().slice(0, 12)}`;
  const deadline = Date.now() + SLOT_WAIT_MS;
  let backoff = 400;
  for (;;) {
    const now = Date.now();
    const info: SessionInfo = {
      sessionId: slotId,
      label,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SLOT_TTL_MS).toISOString(),
      released: false,
      tenantId,
      kind: "batch",
    };
    const res = await coordinator(env).fetch("https://do/acquire", {
      method: "POST",
      body: JSON.stringify(info),
    });
    if (res.ok) {
      const { warmSessionId } = (await res.json()) as { warmSessionId?: string };
      return { slotId, warmSessionId };
    }
    const err = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    const reason = err.error ?? "session_cap_reached";
    const waitable = res.status === 429 && reason !== "tenant_disabled";
    if (!waitable || Date.now() + backoff > deadline) {
      throw new FleetBusyError(reason, err.detail ?? `no browser slot (${res.status})`);
    }
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 3_000);
  }
}

export async function acquirePooledBrowser(
  env: Env,
  tenantId: string,
  label: string
): Promise<PooledBrowser> {
  const { slotId, warmSessionId } = await acquireSlot(env, tenantId, label);
  try {
    if (warmSessionId) {
      try {
        return { browser: await connect(env.BROWSER, warmSessionId), slotId };
      } catch {
        /* the warm session died — fall through to a fresh launch */
      }
    }
    return { browser: await throttledLaunch(env), slotId };
  } catch (err) {
    // No browser — give the slot straight back rather than holding it to TTL.
    await coordinator(env)
      .fetch("https://do/release", { method: "POST", body: JSON.stringify({ sessionId: slotId }) })
      .catch(() => {});
    throw err;
  }
}

export async function releasePooledBrowser(env: Env, pooled: PooledBrowser): Promise<void> {
  const { browser, slotId } = pooled;
  // Leave a clean, context-free browser behind so the next borrower starts fresh.
  // One whose contexts won't close is not safe to hand to another tenant.
  let clean = true;
  try {
    await Promise.all(browser.contexts().map((c) => c.close()));
  } catch {
    clean = false;
  }
  let sid: string | undefined;
  try {
    sid = clean ? browser.sessionId() : undefined;
  } catch {
    /* a sessionless browser cannot be pooled */
  }
  // One call frees the slot and offers the browser to the warm pool.
  const parked = await coordinator(env)
    .fetch("https://do/release", {
      method: "POST",
      body: JSON.stringify({ sessionId: slotId, warmSessionId: sid }),
    })
    .then((r) => r.json<{ parked?: boolean }>())
    .then((r) => true === r.parked)
    .catch(() => false);
  if (!parked) {
    try {
      await browser.close();
    } catch {
      /* already gone */
    }
  }
}
