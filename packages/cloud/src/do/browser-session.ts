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
  type NetworkEvent,
  type PredicateResult,
  ActBatchRequestSchema,
  AssertRequestSchema,
  ActionSchema,
  ObserveRequestSchema,
  QueryRequestSchema,
  ScreenshotRequestSchema,
  RING_BUFFER_LIMIT,
  VIEWPORTS,
  type ViewportName,
} from "@argus/shared";
import { evalPredicate, resolveAnchor, weakestTier } from "../verify";
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

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

export class BrowserSession extends DurableObject<Env> {
  private browser?: Browser;
  private page?: Page;
  private meta?: SessionMeta;

  // Ring buffers — in-memory, rebound on reconnect. seq is monotonic.
  private seq = 0;
  private netBuf: NetworkEvent[] = [];
  private conBuf: ConsoleEvent[] = [];
  private pendingStarts = new Map<string, number>(); // request url+seq → start ts

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
          return json({ error: `unknown command ${path}` }, 404);
      }
    } catch (err) {
      return json({ error: "session_command_failed", detail: String(err) }, 500);
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
      // instead of cold-launched (~1-2s, capped at 1/sec). A dead id just falls
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

    const page = await this.ensurePage();
    await page.goto(body.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await this.settle(page, 3_000);

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
    // (~100-200ms) rather than cold-launching (~1-2s, capped at 1/sec). Only a
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
      // warm pool staggers to <=1/sec (CF's cap) and completes instead of failing.
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
      // element (or the whole page) may be gone.
      const recAnchor = (await this.isRecording())
        ? await this.deriveAnchor(locator)
        : undefined;
      return { locator, recAnchor };
    }
    if (anchor) {
      const { locator, via } = resolveAnchor(page, anchor);
      const matched = await locator.count();
      if (matched === 0) throw new Error(`anchor_not_found via=${via}`);
      return { locator: locator.first(), resolution: { via, matched }, recAnchor: anchor };
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
      const result = await this.performAction(step);
      results.push(result);
      if (result.ok) completed++;
      else if (req.stopOnError) break;
    }
    return json({ results, completed });
  }

  private async performAction(action: Action): Promise<ActResult> {
    const page = await this.ensurePage();

    // Snapshot "before" so effects are observed, not assumed.
    const urlBefore = page.url();
    const errSeqBefore = this.conBuf.filter((c) => c.level === "error").length;
    const failSeqBefore = this.netBuf.filter((n) => n.failed).length;
    const nodesBefore = await page
      .evaluate(() => document.querySelectorAll("*").length)
      .catch(() => 0);

    let resolution: AnchorResolution | undefined;
    let recAnchor: Anchor | undefined; // derived pre-action while recording
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
        case "click": {
          const t = await this.resolveTarget(page, action.ref, action.anchor);
          resolution = t.resolution;
          recAnchor = t.recAnchor;
          await t.locator.click({ timeout: 5_000 });
          break;
        }
        case "fill": {
          const t = await this.resolveTarget(page, action.ref, action.anchor);
          resolution = t.resolution;
          recAnchor = t.recAnchor;
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
      return { ok: false, resolution, error: String(err).slice(0, 400) };
    }

    // Recording: persist the step with a durable semantic anchor (never a ref).
    await this.maybeRecord(action, recAnchor);

    await this.settle(page);

    const urlAfter = page.url();
    const nodesAfter = await page
      .evaluate(() => document.querySelectorAll("*").length)
      .catch(() => nodesBefore);

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

    const buffers = { network: this.netBuf, console: this.conBuf };
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

  /** Derive a durable semantic anchor from a live element (for recording). */
  private async deriveAnchor(locator: Locator): Promise<Anchor | undefined> {
    try {
      return await locator.evaluate((el: HTMLElement) => {
        const testid = el.getAttribute("data-testid");
        if (testid) return { testid };
        const role = el.getAttribute("role") ?? undefined;
        const name = el.getAttribute("aria-label") ?? undefined;
        if (role && name) return { role, name };
        const text = (el.innerText ?? "").trim().slice(0, 60);
        if (text) return { text };
        return undefined;
      });
    } catch {
      return undefined;
    }
  }

  private async maybeRecord(action: Action, anchor: Anchor | undefined): Promise<void> {
    const rec = await this.ctx.storage.get<{ name: string; steps: FlowStep[] }>("recording");
    if (!rec) return;
    // Strip volatile refs — recorded steps carry semantic anchors only.
    const cleanAction = { ...action } as Record<string, unknown>;
    delete cleanAction.ref;
    delete cleanAction.anchor;
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
