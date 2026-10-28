/**
 * BrowserSession — one Durable Object per leased browser session.
 *
 * Holds a live @cloudflare/playwright connection to a Browser Rendering
 * session, instruments the page (network / console / route ring buffers),
 * and executes the wire-contract commands: query, act, act-batch, observe,
 * assert, screenshot, smoke.
 *
 * Lifecycle: /init leases + launches, an alarm auto-releases at TTL, and a
 * crashed/evicted DO reconnects to the same Chromium via its stored CF
 * session id (warm reconnect ~100-200ms).
 */
import { DurableObject } from "cloudflare:workers";
import { launch, connect, type Browser, type Page, type Locator } from "@cloudflare/playwright";
import { ZodError } from "zod";
import {
  type Action,
  type ActEffects,
  type ActResult,
  type Anchor,
  type AnchorResolution,
  type ConsoleEvent,
  type FlowStep,
  type NetworkEvent,
  type PredicateResult,
  type StreamEvent,
  ActBatchRequestSchema,
  AssertRequestSchema,
  ActionSchema,
  ObserveRequestSchema,
  QueryRequestSchema,
  ScreenshotRequestSchema,
  AuthProfileNameSchema,
  RING_BUFFER_LIMIT,
  VIEWPORTS,
  apiError,
  type ViewportName,
  type LeaseNetwork,
  type Recovered,
  type NetworkProfile,
} from "@argus/shared";
import { evalPredicate, resolveAnchor, weakestTier, type LostThrough } from "../verify";
import { actEffects, isInteraction, pageState, pendingFeedback } from "../detectors";
import { applyNetwork, applyViewport, contextOptionsFor, settleBudget, slowRequest, trackInflight, waitForQuiet } from "../flow-utils";
import { hostOf, loadAuthProfile, saveAuthProfile } from "../auth-store";
import { throttledLaunch } from "../pool";
import type { Env } from "../env";

interface SessionMeta {
  sessionId: string; // argus session id (DO name)
  tenantId: string;
  cfSessionId?: string; // Browser Rendering session id, for warm reconnect
  url: string;
  viewport: ViewportName;
  colorScheme: "light" | "dark";
  label?: string;
  authProfile?: string; // saved storage state to start signed in with
  network?: NetworkProfile; // current throttling; re-applied after a DO restart
  createdAt: string;
  expiresAt: string;
  released: boolean;
}

/**
 * Each DO instance issues seqs from its own block: a restart (deploy, eviction)
 * starts above every seq the previous instance handed out, so an agent's cursor
 * stays meaningful instead of silently outrunning the new counter.
 */
const SEQ_BLOCK = 1_000_000_000;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A Playwright WebSocket frame payload, stringified and capped. */
function framePayload(frame: unknown): string {
  const payload = (frame as { payload?: unknown })?.payload;
  if (payload === undefined || payload === null) return "";
  return (typeof payload === "string" ? payload : String(payload)).slice(0, 500);
}

export class BrowserSession extends DurableObject<Env> {
  private browser?: Browser;
  private page?: Page;
  private meta?: SessionMeta;
  private releasing?: Promise<void>;

  // Ring buffers — in-memory, rebound on reconnect. seq is monotonic.
  private seq = 0;
  private netBuf: NetworkEvent[] = [];
  private conBuf: ConsoleEvent[] = [];
  private streamBuf: StreamEvent[] = [];
  /** Per buffer, the highest seq that may be missing (evicted, or lost in a restart). */
  private lost: LostThrough = {};
  private seqReady = false;
  private recovered?: Recovered;
  /** Main-frame navigations — `navigated` must catch reloads and same-URL posts. */
  private navCount = 0;
  /** Monotonic across documents so a stale ref can't hit an element on a new page. */
  private refCounter = 0;
  private pageInFlight?: Promise<Page>;
  // Lease-phase timings from the last openPage (reported once, at init).
  private openedWarm = false;
  private browserMs = 0;

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      switch (path) {
        case "/init":
          return await this.handleInit(request);
        case "/query":
          return await this.handleQuery(request);
        case "/act":
          return await this.handleAct(request);
        case "/act-batch":
          return await this.handleActBatch(request);
        case "/observe":
          return await this.handleObserve(request);
        case "/assert":
          return await this.handleAssert(request);
        case "/screenshot":
          return await this.handleScreenshot(request);
        case "/auth-save":
          return await this.handleAuthSave(request);
        case "/record-start":
          return await this.handleRecordStart(request);
        case "/record-stop":
          return await this.handleRecordStop();
        case "/release":
          return await this.handleRelease();
        case "/info":
          return json((await this.loadMeta()) ?? { error: "no such session" });
        default:
          return json(apiError("unknown_command", path), 404);
      }
    } catch (err) {
      // A malformed body is the caller's to fix — say so, don't blame the fleet.
      if (err instanceof ZodError || err instanceof SyntaxError) {
        return json(apiError("bad_request", String(err).slice(0, 500)), 400);
      }
      return json(apiError("session_command_failed", String(err).slice(0, 500)), 500);
    }
  }

  /** TTL expiry — release the browser so the slot frees even if a client crashed. */
  async alarm(): Promise<void> {
    await this.release("ttl-expired");
  }

  // -------------------------------------------------------------------------
  // Init / lifecycle
  // -------------------------------------------------------------------------

  private async handleInit(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      sessionId: string;
      tenantId: string;
      url: string;
      viewport: ViewportName;
      colorScheme: "light" | "dark";
      ttlSeconds: number;
      label?: string;
      authProfile?: string;
      network?: LeaseNetwork;
      warmSessionId?: string;
    };

    const now = Date.now();
    const meta: SessionMeta = {
      sessionId: body.sessionId,
      tenantId: body.tenantId,
      // Seed the browser id from the warm pool: ensurePage() connects to
      // cfSessionId before it launches, so a parked browser is reused (~100-200ms)
      // instead of cold-launched (~1-2s, capped at 3/sec). A dead id just falls
      // through to launch().
      cfSessionId: body.warmSessionId,
      url: body.url,
      viewport: body.viewport,
      colorScheme: body.colorScheme,
      label: body.label,
      authProfile: body.authProfile,
      network: body.network,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + body.ttlSeconds * 1000).toISOString(),
      released: false,
    };
    this.meta = meta;
    await this.ctx.storage.put("meta", meta);
    await this.ctx.storage.setAlarm(now + body.ttlSeconds * 1000);

    let page: Page;
    const t = { start: Date.now(), page: 0, goto: 0, settle: 0 };
    try {
      page = await this.ensurePage();
      t.page = Date.now();
      await page.goto(body.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      t.goto = Date.now();
      await this.settle(page, 3_000);
      t.settle = Date.now();
    } catch (err) {
      // The Worker frees the Coordinator slot on a failed init; without this the
      // browser stayed connected (and uncounted) until the TTL alarm — a client
      // retrying a dead URL could pile up hundreds toward the account cap.
      await this.release("init-failed");
      throw err;
    }

    return json({
      sessionId: meta.sessionId,
      ready: true,
      url: page.url(),
      title: await page.title().catch(() => ""),
      expiresAt: meta.expiresAt,
      timings: {
        warm: this.openedWarm,
        browserMs: this.browserMs,
        contextMs: Math.max(0, t.page - t.start - this.browserMs),
        gotoMs: t.goto - t.page,
        settleMs: t.settle - t.goto,
      },
    });
  }

  private async handleRelease(): Promise<Response> {
    await this.release("released");
    return json({ ok: true });
  }

  /**
   * One release per session. A DELETE racing the TTL alarm (or two agents both
   * releasing) used to run this twice: the second pass either re-parked a browser
   * another lease had already taken — two tenants on one Chromium — or closed it
   * under them. Later callers now await the first release.
   */
  private release(reason: string): Promise<void> {
    this.releasing ??= this.releaseOnce(reason);
    return this.releasing;
  }

  private async releaseOnce(reason: string): Promise<void> {
    // Let an in-flight connect/launch land first: otherwise it would see the
    // release, close its browser — the very one this release is about to park.
    await this.pageInFlight?.catch(() => {});
    const meta = await this.loadMeta();
    if (meta?.released) return;
    // Claim the browser synchronously so nothing else can act on or park it.
    let browser = this.browser;
    this.browser = undefined;
    this.page = undefined;
    if (meta) meta.released = true;
    // After a DO restart the handle is gone but the Chromium is not — reattach
    // so it is parked or closed instead of lingering untracked until keep_alive.
    if (!browser?.isConnected() && meta?.cfSessionId) {
      try {
        browser = await connect(this.env.BROWSER, meta.cfSessionId);
      } catch {
        browser = undefined; // already gone
      }
    }
    // Park the browser warm instead of closing it, so the NEXT lease reconnects
    // (~100-200ms) rather than cold-launching (~1-2s, capped at 3/sec). Only a
    // still-connected browser is parkable; the coordinator caps the warm pool
    // and tells us whether it took ours. A browser it did NOT take is closed
    // here, so browsers can never leak toward the 120/account cap.
    let warmSessionId =
      browser?.isConnected() && meta?.cfSessionId ? meta.cfSessionId : undefined;
    // Free every context; a parked browser is tenant-agnostic and must hold none.
    // One that won't close cleanly is not safe to hand to the next tenant.
    try {
      await Promise.all((browser?.contexts() ?? []).map((c) => c.close()));
    } catch {
      warmSessionId = undefined;
    }

    let parked = false;
    if (meta) {
      const coord = this.env.COORDINATOR.get(this.env.COORDINATOR.idFromName("main"));
      parked = await coord
        .fetch("https://do/release", {
          method: "POST",
          body: JSON.stringify({ sessionId: meta.sessionId, reason, warmSessionId }),
        })
        .then((r) => r.json<{ parked?: boolean }>())
        .then((r) => true === r.parked)
        .catch(() => false);
    }
    if (!parked) {
      try {
        await browser?.close();
      } catch {
        /* already gone */
      }
    }
    if (meta) await this.ctx.storage.put("meta", meta);
    await this.ctx.storage.deleteAlarm();
  }

  private async loadMeta(): Promise<SessionMeta | undefined> {
    if (!this.meta) this.meta = await this.ctx.storage.get<SessionMeta>("meta");
    return this.meta;
  }

  // -------------------------------------------------------------------------
  // Browser plumbing
  // -------------------------------------------------------------------------

  private ensurePage(): Promise<Page> {
    if (this.page && this.browser?.isConnected()) return Promise.resolve(this.page);
    // Single flight: two parallel commands on a cold DO must not each launch a
    // browser (the loser's would be orphaned) or bind listeners twice.
    this.pageInFlight ??= this.openPage().finally(() => (this.pageInFlight = undefined));
    return this.pageInFlight;
  }

  private async openPage(): Promise<Page> {
    const meta = await this.loadMeta();
    // A DO that was never /init-ed is not a lease — launching here would start a
    // browser no Coordinator slot accounts for.
    if (!meta) throw new Error("no such session");
    if (meta.released) throw new Error("session already released");

    // Warm reconnect to the same Chromium if we have its session id.
    const tBrowser = Date.now();
    this.openedWarm = false;
    if (!this.browser?.isConnected() && meta?.cfSessionId) {
      try {
        this.browser = await connect(this.env.BROWSER, meta.cfSessionId);
        this.openedWarm = true;
      } catch {
        this.browser = undefined; // expired — fall through to a fresh launch
      }
    }
    if (!this.browser?.isConnected()) {
      // Cold launch through the shared limiter so a burst of leases missing the
      // warm pool staggers to <=3/sec (CF's cap) and completes instead of failing.
      this.browser = await throttledLaunch(this.env);
      if (meta) {
        meta.cfSessionId = this.browser.sessionId();
        await this.ctx.storage.put("meta", meta);
      }
    }

    this.browserMs = Date.now() - tBrowser;
    if (meta.released) {
      // Released while we were connecting/launching — don't attach a browser to it.
      await this.browser.close().catch(() => {});
      this.browser = undefined;
      throw new Error("session already released");
    }

    // First page of this DO instance: claim a fresh seq block. A previous
    // instance having existed means this is a restart — its buffers are gone.
    let restarted = false;
    if (!this.seqReady) {
      const next = (await this.ctx.storage.get<number>("seqNext")) ?? 0;
      restarted = next > 0;
      this.seq = Math.max(this.seq, next);
      this.refCounter = this.seq;
      await this.ctx.storage.put("seqNext", this.seq + SEQ_BLOCK);
      this.seqReady = true;
      if (restarted) {
        // Everything the previous instance saw is unrecoverable.
        this.lost = { network: this.seq, console: this.seq, stream: this.seq };
      }
    }
    // A page this session already had, lost either to a DO restart or to the
    // browser connection dropping under a live instance. The second case used
    // to fall through to a NEW context at about:blank with empty storage and no
    // `recovered` — a silent reset that read as the app losing its data.
    const lastUrl = this.page?.url();
    const resuming = restarted || this.page !== undefined;
    if (resuming && !restarted) {
      // Events fired while disconnected were never seen: absence claims over
      // the gap must fail as unverifiable, exactly as after a restart.
      this.lost = { network: this.seq, console: this.seq, stream: this.seq };
    }
    if (resuming) {
      // The Chromium (and its page) usually survives — reattach to it rather
      // than silently handing the agent a blank page.
      const pages = this.browser.contexts().flatMap((c) => c.pages());
      const existing = pages.find((p) => p.url() === lastUrl) ?? pages[0];
      if (existing) {
        this.page = existing;
        this.bindListeners(existing);
        // CDP emulation dies with the old connection's session — restore it.
        if (meta?.network && meta.network !== "none") await applyNetwork(existing, meta.network);
        this.recovered = { at: new Date().toISOString(), pageReattached: true };
        return existing;
      }
    }

    // Start signed in when an auth profile is requested. A missing profile is
    // an error, not a silent anonymous session — otherwise every authenticated
    // assertion would fail later with a confusing "element not found".
    let storageState: unknown;
    if (meta?.authProfile) {
      const scope = hostOf(meta.url);
      const profile = await loadAuthProfile(this.env, meta.tenantId, meta.authProfile, scope);
      if (!profile)
        throw new Error(
          `auth profile "${meta.authProfile}" not found for ${scope} — run the login flow (saveAuthAs) against this environment first`
        );
      storageState = profile.state;
    }
    const context = await this.browser.newContext({
      ...contextOptionsFor(meta.viewport ?? "desktop", this.browser.version()),
      colorScheme: meta?.colorScheme ?? "light",
      ...(storageState ? { storageState: storageState as never } : {}),
    });
    const page = await context.newPage();
    this.bindListeners(page);
    // Throttle before the first navigation, so the start URL loads like the user's would.
    if (meta?.network && meta.network !== "none") await applyNetwork(page, meta.network);
    if (resuming) {
      // Page lost for good: put the agent back where it was (else the start
      // URL) and say so — act/observe/assert carry `recovered`.
      const url = lastUrl && /^https?:/.test(lastUrl) ? lastUrl : meta.url;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      this.recovered = { at: new Date().toISOString(), pageReattached: false, url };
    }
    this.page = page;
    return page;
  }

  private bindListeners(page: Page): void {
    page.on("console", (msg) => {
      const level = (["log", "info", "warn", "error"] as const).includes(
        msg.type() as never
      )
        ? (msg.type() as "log" | "info" | "warn" | "error")
        : "log";
      this.pushConsole({
        seq: ++this.seq,
        level,
        text: msg.text().slice(0, 500),
        sourceUrl: msg.location()?.url || undefined,
      });
    });
    page.on("pageerror", (err) => {
      this.pushConsole({
        seq: ++this.seq,
        level: "error",
        text: `Uncaught: ${String(err).slice(0, 500)}`,
      });
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.navCount++;
    });
    trackInflight(page);
    page.on("response", (res) => {
      const req = res.request();
      this.pushNet({
        seq: ++this.seq,
        method: req.method(),
        url: req.url().slice(0, 300),
        status: res.status(),
        failed: res.status() >= 400,
        resourceType: req.resourceType(),
      });
      // Server-Sent Events never "finish" as a request/response pair, so the
      // connection itself is the observable event.
      if ((res.headers()["content-type"] ?? "").includes("text/event-stream")) {
        this.pushStream({
          seq: ++this.seq,
          stream: "sse",
          url: req.url().slice(0, 300),
          direction: "open",
          at: Date.now(),
        });
      }
    });
    page.on("websocket", (ws) => {
      const url = ws.url().slice(0, 300);
      this.pushStream({ seq: ++this.seq, stream: "websocket", url, direction: "open", at: Date.now() });
      ws.on("framesent", (frame) =>
        this.pushStream({
          seq: ++this.seq,
          stream: "websocket",
          url,
          direction: "sent",
          data: framePayload(frame),
          at: Date.now(),
        })
      );
      ws.on("framereceived", (frame) =>
        this.pushStream({
          seq: ++this.seq,
          stream: "websocket",
          url,
          direction: "received",
          data: framePayload(frame),
          at: Date.now(),
        })
      );
      ws.on("close", () =>
        this.pushStream({ seq: ++this.seq, stream: "websocket", url, direction: "close", at: Date.now() })
      );
    });
    page.on("requestfailed", (req) => {
      this.pushNet({
        seq: ++this.seq,
        method: req.method(),
        url: req.url().slice(0, 300),
        failed: true,
        resourceType: req.resourceType(),
      });
    });
  }

  private pushNet(e: NetworkEvent) {
    this.netBuf.push(e);
    if (this.netBuf.length > RING_BUFFER_LIMIT) this.lost.network = this.netBuf.shift()!.seq;
  }
  private pushConsole(e: ConsoleEvent) {
    this.conBuf.push(e);
    if (this.conBuf.length > RING_BUFFER_LIMIT) this.lost.console = this.conBuf.shift()!.seq;
  }
  private pushStream(e: StreamEvent) {
    this.streamBuf.push(e);
    if (this.streamBuf.length > RING_BUFFER_LIMIT) this.lost.stream = this.streamBuf.shift()!.seq;
  }

  /** The buffers predicates read, with their known gaps. */
  private buffers() {
    return { network: this.netBuf, console: this.conBuf, stream: this.streamBuf, lostThrough: this.lost };
  }

  /** Best-effort quiesce: wait for network idle but never hang. */
  private async settle(page: Page, baseMs = 2_000): Promise<void> {
    const timeout = settleBudget(baseMs, this.meta?.network);
    await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Target resolution (ladder lives in ../verify).
  // Verify-or-refuse: ambiguous or missing anchors are errors, not guesses.
  // -------------------------------------------------------------------------

  private async resolveTarget(
    page: Page,
    ref?: string,
    anchor?: Anchor
  ): Promise<{ locator: Locator; resolution?: AnchorResolution; recAnchor?: Anchor }> {
    if (ref) {
      const locator = page.locator(`[data-argus-ref="${ref}"]`).first();
      if ((await locator.count()) === 0)
        throw new Error(
          `ref ${ref} no longer resolves (page changed?) — re-query to get fresh refs`
        );
      // While recording, derive a durable anchor NOW — after the action the
      // element (or the whole page) may be gone. No unique anchor = refuse the
      // action: a recorded step that can't be found again fails every replay.
      let recAnchor: Anchor | undefined;
      if (await this.isRecording()) {
        recAnchor = await this.deriveAnchor(page, locator);
        if (!recAnchor)
          throw new Error(
            `recording: ref ${ref} has no unique semantic anchor (no testid, role+name or unique text) — add a data-testid, or act via an anchor that matches exactly one element`
          );
      }
      return { locator, recAnchor };
    }
    if (anchor) {
      const { locator, via } = resolveAnchor(page, anchor);
      const matched = await locator.count();
      if (matched === 0) throw new Error(`anchor_not_found via=${via}`);
      // Same rule as flow replay: never act on a guess.
      if (matched > 1)
        throw new Error(
          `ambiguous_anchor via=${via}: ${matched} elements match — narrow it (testid, or role+name) or pass a ref from argus_query`
        );
      return { locator, resolution: { via, matched }, recAnchor: anchor };
    }
    throw new Error("action needs a ref or an anchor");
  }

  private async isRecording(): Promise<boolean> {
    return (await this.ctx.storage.get("recording")) !== undefined;
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  private async handleQuery(request: Request): Promise<Response> {
    const req = QueryRequestSchema.parse(await request.json());
    const page = await this.ensurePage();

    if (req.anchor) {
      const { locator, via } = resolveAnchor(page, req.anchor);
      const matched = await locator.count();
      const elements = [];
      for (let i = 0; i < Math.min(matched, req.limit); i++) {
        elements.push(await this.describeAndTag(page, locator.nth(i)));
      }
      return json({
        elements,
        resolution: { via, matched },
        pageUrl: page.url(),
        pageTitle: await page.title().catch(() => ""),
      });
    }

    // Interactive-surface scan: tag interactive elements with refs in-page,
    // return a compact structured list (the "what can I do here" read).
    const scan = await page.evaluate(({ limit, start }: { limit: number; start: number }) => {
      const sel =
        'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [onclick], [data-testid]';
      const nodes = (Array.from(document.querySelectorAll(sel)) as any[]).slice(0, limit * 3);
      let counter = start;
      const out: Array<Record<string, unknown>> = [];
      for (const el of nodes) {
        if (out.length >= limit) break;
        const rect = el.getBoundingClientRect();
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          getComputedStyle(el).visibility !== "hidden" &&
          getComputedStyle(el).display !== "none";
        if (!visible) continue;
        let ref = el.getAttribute("data-argus-ref");
        if (!ref) {
          ref = "e" + ++counter;
          el.setAttribute("data-argus-ref", ref);
        }
        out.push({
          ref,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") ?? undefined,
          name:
            el.getAttribute("aria-label") ??
            (el as HTMLInputElement).placeholder ??
            undefined,
          testid: el.getAttribute("data-testid") ?? undefined,
          text: (el.innerText || (el as HTMLInputElement).value || "")
            .trim()
            .slice(0, 80) || undefined,
          visible: true,
          enabled: !(el as HTMLButtonElement).disabled,
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          },
        });
      }
      return { out, counter };
    }, { limit: req.limit, start: this.refCounter });
    this.refCounter = scan.counter;

    return json({
      elements: scan.out,
      pageUrl: page.url(),
      pageTitle: await page.title().catch(() => ""),
    });
  }

  /** Describe one located element and give it a stable ref. */
  private async describeAndTag(_page: Page, locator: Locator) {
    const next = this.refCounter + 1;
    const described = await locator.evaluate((el: HTMLElement, next: number) => {
      let ref = el.getAttribute("data-argus-ref");
      const minted = !ref;
      if (!ref) {
        ref = "e" + next;
        el.setAttribute("data-argus-ref", ref);
      }
      const rect = el.getBoundingClientRect();
      return {
        ref,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") ?? undefined,
        name: el.getAttribute("aria-label") ?? undefined,
        testid: el.getAttribute("data-testid") ?? undefined,
        text: (el.innerText ?? "").trim().slice(0, 80) || undefined,
        visible: rect.width > 0 && rect.height > 0,
        enabled: !(el as HTMLButtonElement).disabled,
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
        minted,
      };
    }, next);
    const { minted, ...element } = described;
    if (minted) this.refCounter = next;
    return element;
  }

  // -------------------------------------------------------------------------
  // Act
  // -------------------------------------------------------------------------

  private async handleAct(request: Request): Promise<Response> {
    const action = ActionSchema.parse(await request.json());
    const result = await this.performAction(action);
    return json(result);
  }

  private async handleActBatch(request: Request): Promise<Response> {
    const req = ActBatchRequestSchema.parse(await request.json());
    const results: ActResult[] = [];
    let completed = 0;
    for (const step of req.steps) {
      // A step that throws (e.g. the lease expired mid-batch) must not discard
      // the results of steps whose side effects already happened.
      const result = await this.performAction(step).catch(
        (err): ActResult => ({ ok: false, error: String(err).slice(0, 400) })
      );
      results.push(result);
      if (result.ok) completed++;
      else if (req.stopOnError) break;
    }
    return json({ results, completed });
  }

  private async performAction(action: Action): Promise<ActResult> {
    const recoveredBefore = this.recovered?.at;
    const page = await this.ensurePage();
    const recovered = this.recovered && this.recovered.at !== recoveredBefore ? { recovered: this.recovered } : {};

    // Snapshot "before" so effects are observed, not assumed.
    const urlBefore = page.url();
    const seqBefore = this.seq;
    const navBefore = this.navCount;
    // ONE round-trip: what the page already shows wrong (so the action is only
    // blamed for what it adds), plus a watch on every DOM mutation it causes —
    // node counts alone miss a toggled class or changed text.
    const watch = action.action !== "wait" && action.action !== "scroll" && action.action !== "hover";
    const tStart = Date.now();
    const before = await pageState(page, { detectors: watch, observe: "start" });
    const tAction = Date.now();

    let resolution: AnchorResolution | undefined;
    let recAnchor: Anchor | undefined; // derived pre-action while recording
    let secretVar: string | undefined; // set when a recorded fill is a secret
    try {
      switch (action.action) {
        case "goto":
          await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          break;
        case "back":
          await page.goBack({ timeout: 10_000 });
          break;
        case "reload":
          await page.reload({ timeout: 30_000 });
          break;
        case "wait":
          await page.waitForTimeout(action.ms);
          break;
        case "viewport":
          await applyViewport(page, action);
          break;
        case "network":
          await applyNetwork(page, action.profile);
          if (this.meta) {
            this.meta.network = action.profile;
            await this.ctx.storage.put("meta", this.meta);
          }
          break;
        case "scroll":
          await page.mouse.wheel(0, action.direction === "down" ? action.amount : -action.amount);
          break;
        case "click": {
          const t = await this.resolveTarget(page, action.ref, action.anchor);
          resolution = t.resolution;
          recAnchor = t.recAnchor;
          await t.locator.click({ timeout: 5_000, clickCount: action.clickCount });
          break;
        }
        case "fill": {
          const t = await this.resolveTarget(page, action.ref, action.anchor);
          resolution = t.resolution;
          recAnchor = t.recAnchor;
          // A secret typed while recording must never land in a saved flow.
          if (recAnchor) secretVar = await this.secretPlaceholder(t.locator);
          await t.locator.fill(action.value, { timeout: 5_000 });
          break;
        }
        case "select": {
          const t = await this.resolveTarget(page, action.ref, action.anchor);
          resolution = t.resolution;
          recAnchor = t.recAnchor;
          await t.locator.selectOption(action.value, { timeout: 5_000 });
          break;
        }
        case "press": {
          if (action.ref || action.anchor) {
            const t = await this.resolveTarget(page, action.ref, action.anchor);
            resolution = t.resolution;
            recAnchor = t.recAnchor;
              await t.locator.press(action.key, { timeout: 5_000 });
          } else {
            await page.keyboard.press(action.key);
          }
          break;
        }
        case "hover": {
          const t = await this.resolveTarget(page, action.ref, action.anchor);
          resolution = t.resolution;
          recAnchor = t.recAnchor;
          await t.locator.hover({ timeout: 5_000 });
          break;
        }
      }
    } catch (err) {
      return { ok: false, resolution, error: String(err).slice(0, 400), ...recovered };
    }

    // Recording: persist the step with a durable semantic anchor (never a ref).
    await this.maybeRecord(action, recAnchor, secretVar);

    const tSettle = Date.now();
    // While the action's own request is still out: what is the user looking at?
    let pending: ActEffects["pending"];
    // Only a user who just clicked/pressed is waiting on the app; a reload's
    // background fetches are not an unanswered action.
    if (isInteraction(action)) {
      const inFlight = await slowRequest(page, tAction);
      if (inFlight > 0) pending = { inFlight, afterMs: Date.now() - tAction, ...(await pendingFeedback(page)) };
    }
    await waitForQuiet(page, tAction, settleBudget(2_000, this.meta?.network));
    const tAfter = Date.now();

    const urlAfter = page.url();
    // Same single read also decides focus: landing on the element acted on is not an effect.
    const after = await pageState(page, { detectors: watch, observe: "read" });
    return {
      ok: true,
      resolution,
      ...recovered,
      effects: actEffects({
        action,
        urlBefore,
        urlAfter,
        navigated: this.navCount > navBefore || urlBefore !== urlAfter,
        before,
        after,
        watch,
        network: this.netBuf,
        console: this.conBuf,
        seqBefore,
        pending,
        timings: { before: tAction - tStart, action: tSettle - tAction, settle: tAfter - tSettle, after: Date.now() - tAfter },
      }),
    };
  }

  /**
   * A field that holds a secret (password, OTP, card, API key) is recorded as
   * a `${VAR}` placeholder — the flow file never carries the typed value.
   */
  private async secretPlaceholder(locator: Locator): Promise<string | undefined> {
    const info = await locator
      .evaluate((el: HTMLElement) => {
        const attr = (n: string) => (el.getAttribute(n) ?? "").toLowerCase();
        const hint = [attr("name"), attr("id"), attr("aria-label"), attr("placeholder")].join(" ");
        const auto = attr("autocomplete");
        const secret =
          attr("type") === "password" ||
          /current-password|new-password|one-time-code|cc-number|cc-csc/.test(auto) ||
          /pass(word|code)?\b|secret|token|\botp\b|\bpin\b|cvv|cvc|api[-_ ]?key/.test(hint);
        return { secret, auto, hint };
      })
      .catch(() => ({ secret: false, auto: "", hint: "" }));
    if (!info.secret) return undefined;
    if (/one-time-code|\botp\b/.test(info.auto + " " + info.hint)) return "OTP";
    if (/cc-|cvv|cvc/.test(info.auto + " " + info.hint)) return "CARD_SECRET";
    if (/api[-_ ]?key|token/.test(info.hint)) return "API_TOKEN";
    return "PASSWORD";
  }

  // -------------------------------------------------------------------------
  // Observe
  // -------------------------------------------------------------------------

  private async handleObserve(request: Request): Promise<Response> {
    const req = ObserveRequestSchema.parse(await request.json());
    const page = await this.ensurePage();
    return json({
      cursor: this.seq,
      network: req.what.includes("network")
        ? this.netBuf.filter((e) => e.seq > req.since)
        : [],
      console: req.what.includes("console")
        ? this.conBuf.filter((e) => e.seq > req.since)
        : [],
      stream: req.what.includes("stream")
        ? this.streamBuf.filter((e) => e.seq > req.since)
        : [],
      route: req.what.includes("route")
        ? { url: page.url(), title: await page.title().catch(() => "") }
        : undefined,
      ...this.gapReport(req.since),
    });
  }

  // -------------------------------------------------------------------------
  // Assert — evidence-tiered
  // -------------------------------------------------------------------------

  private async handleAssert(request: Request): Promise<Response> {
    const req = AssertRequestSchema.parse(await request.json());
    const page = await this.ensurePage();

    const results: PredicateResult[] = [];
    for (const p of req.predicates) {
      results.push(await evalPredicate(page, this.buffers(), p));
    }

    const pass = results.every((r) => r.pass);
    // Honesty: report the WEAKEST tier the verdict rests on.
    return json({ pass, tier: weakestTier(results), results, ...(this.recovered ? { recovered: this.recovered } : {}) });
  }

  /** Gaps an agent reading from `since` must know about. */
  private gapReport(since: number) {
    const lostThrough: LostThrough = {};
    for (const k of ["network", "console", "stream"] as const) {
      const v = this.lost[k];
      if (v !== undefined && v > since) lostThrough[k] = v;
    }
    return {
      ...(Object.keys(lostThrough).length ? { lostThrough } : {}),
      ...(this.recovered ? { recovered: this.recovered } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Recording — while active, successful acts append semantic-anchored steps
  // -------------------------------------------------------------------------

  /**
   * Persist this session's cookies/localStorage as a reusable auth profile —
   * called after driving a real login, so later flows skip the login form.
   */
  private async handleAuthSave(request: Request): Promise<Response> {
    const parsedName = AuthProfileNameSchema.safeParse(
      ((await request.json()) as { profile?: unknown }).profile
    );
    // An unsafe name would save a profile no lease/flow could ever load.
    if (!parsedName.success) return json(apiError("bad_request", `profile: ${parsedName.error.message}`), 400);
    const profile = parsedName.data;
    const page = await this.ensurePage();
    const meta = await this.loadMeta();
    if (!meta) return json({ error: "session not initialized" }, 409);
    const state = await page.context().storageState();
    const saved = await saveAuthProfile(
      this.env,
      meta.tenantId,
      profile,
      hostOf(page.url()),
      state as never,
      page.url()
    );
    return json(saved);
  }

  private async handleRecordStart(request: Request): Promise<Response> {
    const { name } = (await request.json().catch(() => ({}))) as { name?: string };
    // A recording starts where the page IS, not where the lease began.
    const startUrl = (await this.ensurePage()).url();
    // A throttled session records its throttle as step 0, so the replay that
    // "proves the fix" runs on the same network the failure was found on.
    const network = (await this.loadMeta())?.network;
    const steps: FlowStep[] =
      network && network !== "none" ? [{ action: { action: "network", profile: network }, expect: [] }] : [];
    await this.ctx.storage.put("recording", { name: name ?? "recording", steps, startUrl });
    return json({ ok: true, recording: name ?? "recording" });
  }

  private async handleRecordStop(): Promise<Response> {
    const rec = await this.ctx.storage.get<{ name: string; steps: FlowStep[]; placeholders?: string[]; startUrl?: string }>(
      "recording"
    );
    await this.ctx.storage.delete("recording");
    if (!rec) return json({ error: "no active recording" }, 400);
    const meta = await this.loadMeta();
    return json({
      name: rec.name,
      steps: rec.steps,
      startUrl: rec.startUrl ?? meta?.url,
      viewport: meta?.viewport ?? "desktop",
      // Secrets typed while recording were saved as ${VAR}; replay needs them set.
      ...(rec.placeholders?.length
        ? {
            placeholders: rec.placeholders,
            note: `secret fields were recorded as placeholders — set ${rec.placeholders.join(", ")} in the environment to replay`,
          }
        : {}),
    });
  }

  /**
   * Derive a durable semantic anchor from a live element (for recording):
   * the first rung of the ladder (testid → role+name → text) that resolves to
   * exactly this one element on the page right now.
   */
  private async deriveAnchor(page: Page, locator: Locator): Promise<Anchor | undefined> {
    let candidates: Anchor[];
    try {
      candidates = await locator.evaluate((el: HTMLElement) => {
        const out: Array<Record<string, string>> = [];
        const testid = el.getAttribute("data-testid");
        if (testid) out.push({ testid });
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute("type") ?? "").toLowerCase();
        const implicit =
          tag === "a" && el.hasAttribute("href") ? "link"
          : tag === "button" || (tag === "input" && ["button", "submit", "reset"].includes(type)) ? "button"
          : tag === "input" && type === "checkbox" ? "checkbox"
          : tag === "input" && type === "radio" ? "radio"
          : tag === "select" ? "combobox"
          : tag === "textarea" || (tag === "input" && !["hidden", "file", "image", "range", "color"].includes(type)) ? "textbox"
          : undefined;
        const role = el.getAttribute("role") ?? implicit;
        const labelledBy = (el.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .map((id: string) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim();
        const labelFor = el.id
          ? (Array.from(document.querySelectorAll("label")) as HTMLElement[]).find((l) => l.getAttribute("for") === el.id)?.textContent
          : undefined;
        const wrapping = el.closest("label")?.textContent;
        const ownText = ["link", "button"].includes(role ?? "") ? el.innerText : undefined;
        const name = [
          el.getAttribute("aria-label"),
          labelledBy,
          labelFor,
          wrapping,
          (el as HTMLInputElement).placeholder,
          ownText,
          el.getAttribute("title"),
        ]
          .map((v) => (v ?? "").trim().replace(/\s+/g, " "))
          .find((v) => v.length > 0);
        if (role && name) out.push({ role, name: name.slice(0, 80) });
        const text = (el.innerText ?? "").trim().slice(0, 60);
        if (text) out.push({ text });
        return out;
      });
    } catch {
      return undefined;
    }
    for (const anchor of candidates) {
      const { locator: found } = resolveAnchor(page, anchor);
      if ((await found.count().catch(() => 0)) === 1) return anchor;
    }
    return undefined;
  }

  private async maybeRecord(action: Action, anchor: Anchor | undefined, secretVar?: string): Promise<void> {
    const rec = await this.ctx.storage.get<{ name: string; steps: FlowStep[]; placeholders?: string[] }>("recording");
    if (!rec) return;
    // Strip volatile refs — recorded steps carry semantic anchors only.
    const cleanAction = { ...action } as Record<string, unknown>;
    delete cleanAction.ref;
    delete cleanAction.anchor;
    if (secretVar && action.action === "fill" && !/^\$\{[A-Z0-9_]+\}$/.test(action.value)) {
      cleanAction.value = `\${${secretVar}}`;
      rec.placeholders = [...new Set([...(rec.placeholders ?? []), secretVar])];
    }
    rec.steps.push({
      action: cleanAction as unknown as Action,
      anchor,
      expect: [],
    });
    await this.ctx.storage.put("recording", rec);
  }

  // -------------------------------------------------------------------------
  // Screenshot
  // -------------------------------------------------------------------------

  private async handleScreenshot(request: Request): Promise<Response> {
    const req = ScreenshotRequestSchema.parse(await request.json());
    const page = await this.ensurePage();
    const meta = await this.loadMeta();

    // CSS pixels: a 2x `phone` still returns a 375-wide image, like every other preset.
    const png = await page.screenshot({ fullPage: req.fullPage, type: "png", scale: "css" });
    const key = `tenants/${meta?.tenantId ?? "_admin"}/shots/${meta?.sessionId ?? "unknown"}/${Date.now()}${
      req.label ? "-" + req.label.replace(/[^a-zA-Z0-9_-]/g, "_") : ""
    }.png`;
    await this.env.ARTIFACTS.put(key, png, {
      httpMetadata: { contentType: "image/png" },
    });

    const viewport = page.viewportSize() ?? VIEWPORTS.desktop;
    return json({
      key,
      url: `/v1/artifact/${key}`,
      width: viewport.width,
      height: viewport.height,
    });
  }
}
