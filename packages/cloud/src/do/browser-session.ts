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
import {
  type Action,
  type ActResult,
  type Anchor,
  type AnchorResolution,
  type ConsoleEvent,
  type FlowStep,
  type ScreenDiff,
  type NetworkEvent,
  type PredicateResult,
  type StreamEvent,
  ActBatchRequestSchema,
  AssertRequestSchema,
  ActionSchema,
  FlowDraftRequestSchema,
  FLOW_DRAFT_MAX_STEPS,
  SCREEN_DIFF_LIMITS,
  ObserveRequestSchema,
  QueryRequestSchema,
  ScreenshotRequestSchema,
  RING_BUFFER_LIMIT,
  VIEWPORTS,
  apiError,
  type ViewportName,
} from "@argus/shared";
import { evalPredicate, resolveAnchor, weakestTier } from "../verify";
import { collectSnapshot, diffSnapshots, type Snapshot } from "../screen-diff";
import { buildFlowDraft, buildStep, describeTarget, scrub, type BuiltStep } from "../session-steps";
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
  createdAt: string;
  expiresAt: string;
  released: boolean;
}

/**
 * Every successful action since the lease (or the last reset), in saved-flow
 * form — what `/flow-draft` answers. One storage key per session DO.
 */
interface StepLog {
  startUrl: string;
  steps: FlowStep[];
  /** Reasons a step cannot be saved as it is, each naming its step. */
  blockers: string[];
  /** Steps past FLOW_DRAFT_MAX_STEPS: counted, not kept. */
  dropped: number;
  /** Ring-buffer cursor when the log began, so a draft reads only its own events. */
  sinceSeq: number;
}

/** What a resolved target contributes to its step. */
interface StepTarget {
  anchor?: Anchor;
  matched?: number;
  secure?: boolean;
  hint?: string;
}

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

  // Ring buffers — in-memory, rebound on reconnect. seq is monotonic.
  private seq = 0;
  private netBuf: NetworkEvent[] = [];
  private conBuf: ConsoleEvent[] = [];
  private streamBuf: StreamEvent[] = [];
  private pendingStarts = new Map<string, number>(); // request url+seq → start ts

  // The previous observation of the page — what the next action's diff is
  // measured against. In-memory: after an eviction the next action re-baselines.
  private lastSnap?: Snapshot;

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
        case "/flow-draft":
          return await this.handleFlowDraft(request);
        case "/release":
          return await this.handleRelease();
        case "/info":
          return json((await this.loadMeta()) ?? { error: "no such session" });
        default:
          return json(apiError("unknown_command", path), 404);
      }
    } catch (err) {
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
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + body.ttlSeconds * 1000).toISOString(),
      released: false,
    };
    this.meta = meta;
    await this.ctx.storage.put("meta", meta);
    await this.ctx.storage.setAlarm(now + body.ttlSeconds * 1000);

    await this.ctx.storage.put("steps", {
      startUrl: body.url,
      steps: [],
      blockers: [],
      dropped: 0,
      sinceSeq: 0,
    } satisfies StepLog);

    const page = await this.ensurePage();
    await page.goto(body.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await this.settle(page, 3_000);
    // The first observation: the first action's diff is measured against it.
    this.lastSnap = await this.snapshot(page);

    return json({
      sessionId: meta.sessionId,
      ready: true,
      url: page.url(),
      title: await page.title().catch(() => ""),
      expiresAt: meta.expiresAt,
    });
  }

  private async handleRelease(): Promise<Response> {
    await this.release("released");
    return json({ ok: true });
  }

  private async release(reason: string): Promise<void> {
    const meta = await this.loadMeta();
    // Park the browser warm instead of closing it, so the NEXT lease reconnects
    // (~100-200ms) rather than cold-launching (~1-2s, capped at 3/sec). Only a
    // still-connected browser is parkable; the coordinator caps the warm pool
    // and tells us whether it took ours. A browser it did NOT take is closed
    // here, so browsers can never leak toward the 120/account cap.
    const warmSessionId =
      this.browser?.isConnected() && meta?.cfSessionId ? meta.cfSessionId : undefined;
    // Free the context regardless; a parked browser is reused with a fresh one.
    try {
      await this.page?.context().close();
    } catch {
      /* already gone */
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
        await this.browser?.close();
      } catch {
        /* already gone */
      }
    }
    this.browser = undefined;
    this.page = undefined;
    if (meta) {
      meta.released = true;
      await this.ctx.storage.put("meta", meta);
    }
    await this.ctx.storage.deleteAlarm();
  }

  private async loadMeta(): Promise<SessionMeta | undefined> {
    if (!this.meta) this.meta = await this.ctx.storage.get<SessionMeta>("meta");
    return this.meta;
  }

  // -------------------------------------------------------------------------
  // Browser plumbing
  // -------------------------------------------------------------------------

  private async ensurePage(): Promise<Page> {
    if (this.page && this.browser?.isConnected()) return this.page;

    const meta = await this.loadMeta();
    if (meta?.released) throw new Error("session already released");

    // Warm reconnect to the same Chromium if we have its session id.
    if (!this.browser?.isConnected() && meta?.cfSessionId) {
      try {
        this.browser = await connect(this.env.BROWSER, meta.cfSessionId);
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

    const viewport = VIEWPORTS[meta?.viewport ?? "desktop"];
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
      viewport,
      colorScheme: meta?.colorScheme ?? "light",
      ...(storageState ? { storageState: storageState as never } : {}),
    });
    this.page = await context.newPage();
    this.lastSnap = undefined; // a new page has no previous observation
    this.bindListeners(this.page);
    return this.page;
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
    page.on("request", (req) => {
      this.pendingStarts.set(req.url() + "#" + this.seq, Date.now());
    });
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
    if (this.netBuf.length > RING_BUFFER_LIMIT) this.netBuf.shift();
  }
  private pushConsole(e: ConsoleEvent) {
    this.conBuf.push(e);
    if (this.conBuf.length > RING_BUFFER_LIMIT) this.conBuf.shift();
  }
  private pushStream(e: StreamEvent) {
    this.streamBuf.push(e);
    if (this.streamBuf.length > RING_BUFFER_LIMIT) this.streamBuf.shift();
  }

  /** Best-effort quiesce: wait for network idle but never hang. */
  private async settle(page: Page, timeout = 2_000): Promise<void> {
    await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Target resolution (ladder lives in ../verify).
  // Verify-or-refuse: ambiguous or missing anchors are errors, not guesses.
  // -------------------------------------------------------------------------

  private async resolveTarget(
    page: Page,
    ref: string | undefined,
    anchor: Anchor | undefined,
    /** Read the element itself (is it a password field?) even when an anchor names it. */
    inspect = false
  ): Promise<{ locator: Locator; resolution?: AnchorResolution; target: StepTarget }> {
    if (ref) {
      const locator = page.locator(`[data-argus-ref="${ref}"]`).first();
      if ((await locator.count()) === 0)
        throw new Error(
          `ref ${ref} no longer resolves (page changed?) — re-query to get fresh refs`
        );
      // Derive the durable anchor NOW — after the action the element (or the
      // whole page) may be gone. A candidate only counts once it resolves, on
      // the live page, to exactly this element: the step never carries a guess.
      const info = await page.evaluate(describeTarget, ref).catch(() => undefined);
      let ambiguous: { anchor: Anchor; matched: number } | undefined;
      for (const candidate of info?.candidates ?? []) {
        try {
          // One call answers both questions: how many match, and is the match this element.
          const refs = await resolveAnchor(page, candidate).locator.evaluateAll((els) =>
            (els as unknown as any[]).map((el) => el.getAttribute("data-argus-ref"))
          );
          const matched = refs.length;
          if (matched > 1) ambiguous ??= { anchor: candidate, matched };
          if (matched !== 1 || refs[0] !== ref) continue;
          return { locator, target: { anchor: candidate, matched, secure: info?.secure, hint: info?.hint } };
        } catch {
          /* an anchor the page cannot resolve is not a candidate */
        }
      }
      return { locator, target: { ...ambiguous, secure: info?.secure, hint: info?.hint } };
    }
    if (anchor) {
      const { locator, via } = resolveAnchor(page, anchor);
      // Inspecting reads the match list once, which also counts it.
      const info = inspect ? await locator.evaluateAll(describeTarget).catch(() => undefined) : undefined;
      const matched = info?.matched ?? (await locator.count());
      if (matched === 0) throw new Error(`anchor_not_found via=${via}`);
      return {
        locator: locator.first(),
        resolution: { via, matched },
        target: { anchor, matched, secure: info?.secure, hint: info?.hint },
      };
    }
    throw new Error("action needs a ref or an anchor");
  }

  /** Observe the page as a snapshot; `undefined` when it cannot be read (mid-navigation). */
  private async snapshot(page: Page): Promise<Snapshot | undefined> {
    return await page
      .evaluate(collectSnapshot, {
        maxEls: SCREEN_DIFF_LIMITS.snapshotElements,
        maxText: SCREEN_DIFF_LIMITS.text,
      })
      .catch(() => undefined);
  }

  /** Observe the page and diff it against the previous observation, which it then replaces. */
  private async observeScreen(
    page: Page,
    perList: number
  ): Promise<{ snap?: Snapshot; diff?: ScreenDiff }> {
    const snap = await this.snapshot(page);
    if (!snap) return {};
    const diff = this.lastSnap ? diffSnapshots(this.lastSnap, snap, perList) : undefined;
    this.lastSnap = snap;
    return { snap, diff };
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
    const elements = await page.evaluate((limit: number) => {
      const sel =
        'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [onclick], [data-testid]';
      const nodes = (Array.from(document.querySelectorAll(sel)) as any[]).slice(0, limit * 3);
      let counter = (window as unknown as { __argusRefCounter?: number }).__argusRefCounter ?? 0;
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
        if (
          el.tagName === "INPUT" &&
          (String(el.getAttribute("type")).toLowerCase() === "password" ||
            String(el.getAttribute("autocomplete") || "").toLowerCase().includes("password"))
        ) {
          el.__argusSecure = true; // sticky: survives a "show password" toggle
        }
        const secure = el.__argusSecure === true;
        out.push({
          ref,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") ?? undefined,
          name:
            el.getAttribute("aria-label") ??
            (el as HTMLInputElement).placeholder ??
            undefined,
          testid: el.getAttribute("data-testid") ?? undefined,
          // What a password field holds is never returned, in any observation.
          text: (el.innerText || (secure ? "" : (el as HTMLInputElement).value) || "")
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
      (window as unknown as { __argusRefCounter?: number }).__argusRefCounter = counter;
      return out;
    }, req.limit);

    return json({
      elements,
      pageUrl: page.url(),
      pageTitle: await page.title().catch(() => ""),
    });
  }

  /** Describe one located element and give it a stable ref. */
  private async describeAndTag(page: Page, locator: Locator) {
    return await locator.evaluate((el: HTMLElement) => {
      let counter = (window as unknown as { __argusRefCounter?: number }).__argusRefCounter ?? 0;
      let ref = el.getAttribute("data-argus-ref");
      if (!ref) {
        ref = "e" + ++counter;
        el.setAttribute("data-argus-ref", ref);
        (window as unknown as { __argusRefCounter?: number }).__argusRefCounter = counter;
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
      };
    });
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
      // Up to 50 diffs ride one response, so each is held to the tighter limit.
      const result = await this.performAction(step, SCREEN_DIFF_LIMITS.perListBatch);
      results.push(result);
      if (result.ok) completed++;
      else if (req.stopOnError) break;
    }
    return json({ results, completed });
  }

  private async performAction(
    action: Action,
    diffLimit: number = SCREEN_DIFF_LIMITS.perList
  ): Promise<ActResult> {
    const page = await this.ensurePage();

    // Snapshot "before" so effects are observed, not assumed. The screen diff
    // is measured against the previous observation; only a session without one
    // (a fresh DO instance) takes its baseline here.
    const urlBefore = page.url();
    const errSeqBefore = this.conBuf.filter((c) => c.level === "error").length;
    const failSeqBefore = this.netBuf.filter((n) => n.failed).length;
    let nodesBefore: number;
    if (!this.lastSnap) {
      this.lastSnap = await this.snapshot(page);
      nodesBefore = this.lastSnap?.nodes ?? 0;
    } else {
      nodesBefore = await page
        .evaluate(() => document.querySelectorAll("*").length)
        .catch(() => 0);
    }

    let resolution: AnchorResolution | undefined;
    let target: StepTarget = {}; // resolved pre-action: anchor, and whether it is a password field
    const aim = async (ref?: string, anchor?: Anchor, inspect = false) => {
      const t = await this.resolveTarget(page, ref, anchor, inspect);
      resolution = t.resolution;
      target = t.target;
      return t.locator;
    };
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
        case "scroll":
          await page.mouse.wheel(0, action.direction === "down" ? action.amount : -action.amount);
          break;
        case "click":
          await (await aim(action.ref, action.anchor)).click({ timeout: 5_000 });
          break;
        case "fill":
          // inspect: a fill must know whether its field is a password field.
          await (await aim(action.ref, action.anchor, true)).fill(action.value, { timeout: 5_000 });
          break;
        case "select":
          await (await aim(action.ref, action.anchor)).selectOption(action.value, { timeout: 5_000 });
          break;
        case "press":
          if (action.ref || action.anchor) {
            await (await aim(action.ref, action.anchor)).press(action.key, { timeout: 5_000 });
          } else {
            await page.keyboard.press(action.key);
          }
          break;
        case "hover":
          await (await aim(action.ref, action.anchor)).hover({ timeout: 5_000 });
          break;
      }
    } catch (err) {
      let error = String(err).slice(0, 400);
      // Playwright's error quotes what it was typing; a password must not come back that way.
      if (action.action === "fill" && target.secure) error = scrub(error, action.value);
      const { diff } = await this.observeScreen(page, diffLimit);
      return { ok: false, resolution, error, ...(diff ? { diff } : {}) };
    }

    // The step that repeats this action — semantic anchor, never a ref, never a secret.
    const built = buildStep(action, target);
    await this.logStep(built);
    await this.maybeRecord(built.step);

    await this.settle(page);

    const urlAfter = page.url();
    const { snap, diff } = await this.observeScreen(page, diffLimit);
    const nodesAfter =
      snap?.nodes ??
      (await page.evaluate(() => document.querySelectorAll("*").length).catch(() => nodesBefore));

    return {
      ok: true,
      resolution,
      effects: {
        urlBefore,
        urlAfter,
        navigated: urlBefore !== urlAfter,
        domNodeDelta: nodesAfter - nodesBefore,
        newConsoleErrors:
          this.conBuf.filter((c) => c.level === "error").length - errSeqBefore,
        newNetworkFailures:
          this.netBuf.filter((n) => n.failed).length - failSeqBefore,
      },
      step: built.step,
      ...(built.note ? { stepNote: built.note } : {}),
      ...(diff ? { diff } : {}),
    };
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
    });
  }

  // -------------------------------------------------------------------------
  // Assert — evidence-tiered
  // -------------------------------------------------------------------------

  private async handleAssert(request: Request): Promise<Response> {
    const req = AssertRequestSchema.parse(await request.json());
    const page = await this.ensurePage();

    const buffers = { network: this.netBuf, console: this.conBuf, stream: this.streamBuf };
    const results: PredicateResult[] = [];
    for (const p of req.predicates) {
      results.push(await evalPredicate(page, buffers, p));
    }

    const pass = results.every((r) => r.pass);
    // Honesty: report the WEAKEST tier the verdict rests on.
    return json({ pass, tier: weakestTier(results), results });
  }

  // -------------------------------------------------------------------------
  // Recording — while active, successful acts append semantic-anchored steps
  // -------------------------------------------------------------------------

  /**
   * Persist this session's cookies/localStorage as a reusable auth profile —
   * called after driving a real login, so later flows skip the login form.
   */
  private async handleAuthSave(request: Request): Promise<Response> {
    const { profile } = (await request.json()) as { profile: string };
    if (!profile) return json({ error: "profile name required" }, 400);
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
    const { name } = (await request.json()) as { name?: string };
    await this.ctx.storage.put("recording", { name: name ?? "recording", steps: [] });
    return json({ ok: true, recording: name ?? "recording" });
  }

  private async handleRecordStop(): Promise<Response> {
    const rec = await this.ctx.storage.get<{ name: string; steps: FlowStep[] }>("recording");
    await this.ctx.storage.delete("recording");
    if (!rec) return json({ error: "no active recording" }, 400);
    const meta = await this.loadMeta();
    return json({
      name: rec.name,
      steps: rec.steps,
      startUrl: meta?.url,
      viewport: meta?.viewport ?? "desktop",
    });
  }

  private async maybeRecord(step: FlowStep): Promise<void> {
    const rec = await this.ctx.storage.get<{ name: string; steps: FlowStep[] }>("recording");
    if (!rec) return;
    rec.steps.push(step);
    await this.ctx.storage.put("recording", rec);
  }

  // -------------------------------------------------------------------------
  // Flow draft — every successful action accumulates, recording or not, so a
  // driving session can be turned into a saved flow after the fact.
  // -------------------------------------------------------------------------

  private async loadStepLog(): Promise<StepLog> {
    return (
      (await this.ctx.storage.get<StepLog>("steps")) ?? {
        startUrl: (await this.loadMeta())?.url ?? "",
        steps: [],
        blockers: [],
        dropped: 0,
        sinceSeq: 0,
      }
    );
  }

  /** Bookkeeping only: a storage hiccup here must never fail the action it follows. */
  private async logStep(built: BuiltStep): Promise<void> {
    try {
      const log = await this.loadStepLog();
      if (log.steps.length >= FLOW_DRAFT_MAX_STEPS) {
        log.dropped++;
      } else {
        if (built.blocking && built.note)
          log.blockers.push(`step ${log.steps.length} (${built.step.action.action}): ${built.note}`);
        log.steps.push(built.step);
      }
      await this.ctx.storage.put("steps", log);
    } catch {
      /* the action itself succeeded */
    }
  }

  private async handleFlowDraft(request: Request): Promise<Response> {
    const raw = await request.text();
    const req = FlowDraftRequestSchema.parse(raw.trim() ? JSON.parse(raw) : {});
    const page = await this.ensurePage();
    const meta = await this.loadMeta();
    const log = await this.loadStepLog();

    // An evicted DO restarts its ring buffers at 0; a cursor ahead of them means "everything".
    const since = log.sinceSeq > this.seq ? 0 : log.sinceSeq;
    const label = (meta?.label ?? "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^[-_]+|-+$/g, "");
    const draft = buildFlowDraft({
      name: req.name ?? (label || "session-flow"),
      startUrl: log.startUrl,
      viewport: meta?.viewport ?? "desktop",
      steps: log.steps,
      blockers: log.blockers,
      dropped: log.dropped,
      finalUrl: page.url(),
      consoleErrors: this.conBuf.filter((c) => c.level === "error" && c.seq > since).length,
      network: this.netBuf.filter((n) => n.seq > since),
    });

    if (req.reset) {
      await this.ctx.storage.put("steps", {
        startUrl: page.url(),
        steps: [],
        blockers: [],
        dropped: 0,
        sinceSeq: this.seq,
      } satisfies StepLog);
    }
    return json(draft);
  }

  // -------------------------------------------------------------------------
  // Screenshot
  // -------------------------------------------------------------------------

  private async handleScreenshot(request: Request): Promise<Response> {
    const req = ScreenshotRequestSchema.parse(await request.json());
    const page = await this.ensurePage();
    const meta = await this.loadMeta();

    const png = await page.screenshot({ fullPage: req.fullPage, type: "png" });
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
