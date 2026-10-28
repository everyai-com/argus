/**
 * Local sessions — Argus on an Electron app on this machine.
 *
 * The cloud can't reach a desktop app, so the stdio MCP server drives it here
 * with Playwright's Electron driver and the SAME engine the cloud uses
 * (detectors, settle, pending feedback, anchors, predicates, act effects).
 * Session ids start with `local-`; every session tool routes them here, so an
 * agent's loop is identical for a web app in the cloud and a desktop app.
 */
import { randomUUID } from "node:crypto";
import type { Action, Anchor, NetworkEvent, ConsoleEvent, Predicate } from "@argus/shared";
import { actEffects, pageState, pendingFeedback } from "../../cloud/src/detectors";
import { applyNetwork, applyViewport, settleBudget, slowRequest, trackInflight, waitForQuiet } from "../../cloud/src/flow-utils";
import { evalPredicate, resolveAnchor, weakestTier } from "../../cloud/src/verify";

// Structural types: the cloud engine is typed against @cloudflare/playwright,
// whose Page is API-compatible with playwright-core's for everything it calls.
type AnyPage = any;
interface ElectronLease {
  /** Path to the app (its main script or folder), passed to Electron. */
  app: string;
  /** Electron binary; defaults to the `electron` package resolved from cwd. */
  executablePath?: string;
  args?: string[];
  cwd?: string;
}

interface LocalSession {
  id: string;
  close: () => Promise<void>;
  page: AnyPage;
  seq: number;
  network: NetworkEvent[];
  console: ConsoleEvent[];
  navCount: number;
  label?: string;
}

const sessions = new Map<string, LocalSession>();
export const isLocal = (sessionId: string): boolean => sessionId.startsWith("local-");

async function launchElectron(opts: ElectronLease): Promise<{ page: AnyPage; close: () => Promise<void> }> {
  const { _electron } = await import("playwright-core");
  const app = await _electron.launch({
    args: [opts.app, ...(opts.args ?? [])],
    ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
    cwd: opts.cwd ?? process.cwd(),
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  return { page, close: () => app.close() };
}

function bind(s: LocalSession): void {
  const p = s.page;
  trackInflight(p);
  p.on("response", (res: AnyPage) => {
    const req = res.request();
    s.network.push({
      seq: ++s.seq,
      method: req.method(),
      url: res.url(),
      status: res.status(),
      failed: res.status() >= 400,
      resourceType: req.resourceType(),
    } as NetworkEvent);
  });
  p.on("requestfailed", (req: AnyPage) => {
    s.network.push({ seq: ++s.seq, method: req.method(), url: req.url(), failed: true, resourceType: req.resourceType() } as NetworkEvent);
  });
  p.on("console", (msg: AnyPage) => {
    const t = msg.type();
    s.console.push({ seq: ++s.seq, level: ["log", "info", "warn", "error"].includes(t) ? t : "log", text: msg.text().slice(0, 500) } as ConsoleEvent);
  });
  p.on("pageerror", (err: Error) => {
    s.console.push({ seq: ++s.seq, level: "error", text: `Uncaught: ${String(err).slice(0, 500)}` } as ConsoleEvent);
  });
  p.on("framenavigated", (f: AnyPage) => {
    if (f === p.mainFrame()) s.navCount++;
  });
}

export async function leaseLocal(body: { electron: ElectronLease; label?: string }, launch = launchElectron): Promise<unknown> {
  const t0 = Date.now();
  const { page, close } = await launch(body.electron);
  const s: LocalSession = { id: `local-${randomUUID().slice(0, 12)}`, close, page, seq: 0, network: [], console: [], navCount: 0, label: body.label };
  bind(s);
  sessions.set(s.id, s);
  return { sessionId: s.id, ready: true, url: page.url(), title: await page.title().catch(() => ""), local: "electron", timings: { launchMs: Date.now() - t0 } };
}

function get(id: string): LocalSession {
  const s = sessions.get(id);
  if (!s) throw new Error(`no such local session ${id} (released, or this MCP server restarted)`);
  return s;
}

async function target(page: AnyPage, ref?: string, anchor?: Anchor) {
  if (ref) {
    const locator = page.locator(`[data-argus-ref="${ref}"]`).first();
    if ((await locator.count()) === 0) throw new Error(`ref ${ref} no longer resolves (page changed?) — re-query to get fresh refs`);
    return { locator, resolution: undefined };
  }
  if (!anchor) throw new Error("this action needs a ref or an anchor");
  const { locator, via } = resolveAnchor(page, anchor);
  const matched = await locator.count();
  // Verify-or-refuse: an anchor that is missing or ambiguous is an error, never a guess.
  if (matched !== 1) throw new Error(`anchor via ${via} matched ${matched} elements — make it unique`);
  return { locator, resolution: { via, matched } };
}

async function act(s: LocalSession, action: Action): Promise<unknown> {
  const page = s.page;
  const urlBefore = page.url();
  const seqBefore = s.seq;
  const navBefore = s.navCount;
  const watch = action.action !== "wait" && action.action !== "scroll" && action.action !== "hover";
  const tStart = Date.now();
  const before = await pageState(page, { detectors: watch, observe: "start" });
  const tAction = Date.now();
  let resolution: unknown;
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
        break;
      case "scroll":
        await page.mouse.wheel(0, action.direction === "down" ? action.amount : -action.amount);
        break;
      case "press":
        if (action.ref || action.anchor) {
          const t = await target(page, action.ref, action.anchor);
          resolution = t.resolution;
          await t.locator.press(action.key, { timeout: 5_000 });
        } else await page.keyboard.press(action.key);
        break;
      default: {
        const t = await target(page, action.ref, action.anchor);
        resolution = t.resolution;
        if (action.action === "click") await t.locator.click({ timeout: 5_000, clickCount: action.clickCount });
        else if (action.action === "fill") await t.locator.fill(action.value, { timeout: 5_000 });
        else if (action.action === "select") await t.locator.selectOption(action.value, { timeout: 5_000 });
        else if (action.action === "hover") await t.locator.hover({ timeout: 5_000 });
      }
    }
  } catch (err) {
    return { ok: false, resolution, error: String(err).slice(0, 400) };
  }
  const tSettle = Date.now();
  let pending;
  if (watch) {
    const inFlight = await slowRequest(page, tAction);
    if (inFlight > 0) pending = { inFlight, afterMs: Date.now() - tAction, ...(await pendingFeedback(page)) };
  }
  await waitForQuiet(page, tAction, settleBudget(2_000, undefined));
  const tAfter = Date.now();
  const urlAfter = page.url();
  const after = await pageState(page, { detectors: watch, observe: "read" });
  return {
    ok: true,
    resolution,
    effects: actEffects({
      action,
      urlBefore,
      urlAfter,
      navigated: s.navCount > navBefore || urlBefore !== urlAfter,
      before,
      after,
      watch,
      network: s.network,
      console: s.console,
      seqBefore,
      pending,
      timings: { before: tAction - tStart, action: tSettle - tAction, settle: tAfter - tSettle, after: Date.now() - tAfter },
    }),
  };
}

async function query(s: LocalSession, body: { anchor?: Anchor; interactive?: boolean; limit?: number }): Promise<unknown> {
  const page = s.page;
  const limit = body.limit ?? 50;
  if (body.anchor) {
    const { locator, via } = resolveAnchor(page, body.anchor);
    const n = await locator.count();
    const elements = [];
    for (let i = 0; i < Math.min(n, limit); i++) {
      const ref = `e${++s.seq}`;
      const el = locator.nth(i);
      await el.evaluate((node: any, r: string) => node.setAttribute("data-argus-ref", r), ref);
      elements.push({ ref, text: ((await el.textContent()) ?? "").trim().slice(0, 120), visible: await el.isVisible(), bounds: await el.boundingBox() });
    }
    return { elements, resolution: { via, matched: n }, pageUrl: page.url(), pageTitle: await page.title() };
  }
  const start = s.seq;
  const elements = await page.evaluate(
    (o: { start: number; limit: number }) => {
      const sel = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[tabindex]:not([tabindex="-1"])';
      let n = o.start;
      const out: unknown[] = [];
      for (const el of Array.from(document.querySelectorAll(sel)) as any[]) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const ref = `e${++n}`;
        el.setAttribute("data-argus-ref", ref);
        out.push({
          ref,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") ?? undefined,
          name: el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? undefined,
          text: (el.textContent ?? "").trim().slice(0, 80),
          testid: el.getAttribute("data-testid") ?? undefined,
          bounds: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        });
        if (out.length >= o.limit) break;
      }
      return { out, n };
    },
    { start, limit }
  );
  s.seq = elements.n;
  return { elements: elements.out, pageUrl: page.url(), pageTitle: await page.title() };
}

/** Handle a /v1 call for a local session. Returns undefined when the path isn't a local one. */
export async function localApi(method: string, path: string, body: any): Promise<unknown | undefined> {
  if (method === "POST" && path === "/v1/lease" && body?.electron) return leaseLocal(body);
  const m = path.match(/^\/v1\/session\/(local-[\w-]+)(?:\/([\w-]+))?$/);
  if (!m) return undefined;
  const s = get(m[1]!);
  switch (m[2] ?? (method === "DELETE" ? "release" : "")) {
    case "release":
      sessions.delete(s.id);
      await s.close().catch(() => {});
      return { ok: true };
    case "act":
      return act(s, body as Action);
    case "act-batch": {
      const results = [];
      let completed = 0;
      for (const step of body.steps as Action[]) {
        const r = (await act(s, step)) as { ok: boolean };
        results.push(r);
        if (r.ok) completed++;
        else if (body.stopOnError !== false) break;
      }
      return { results, completed };
    }
    case "query":
      return query(s, body ?? {});
    case "observe": {
      const since = body?.since ?? 0;
      return {
        cursor: s.seq,
        network: s.network.filter((e) => e.seq > since),
        console: s.console.filter((e) => e.seq > since),
        stream: [],
        route: { url: s.page.url(), title: await s.page.title().catch(() => "") },
      };
    }
    case "assert": {
      const results = [];
      for (const p of body.predicates as Predicate[]) results.push(await evalPredicate(s.page, { network: s.network, console: s.console }, p));
      return { pass: results.every((r) => r.pass), tier: weakestTier(results), results };
    }
    case "screenshot": {
      const png: Buffer = await s.page.screenshot({ fullPage: Boolean(body?.fullPage), type: "png" });
      // An Electron window has no emulated viewport: read the size from the PNG header (IHDR).
      return {
        key: `local/${s.id}/${Date.now()}${body?.label ? "-" + body.label : ""}.png`,
        url: "",
        width: png.readUInt32BE(16),
        height: png.readUInt32BE(20),
        png: png.toString("base64"),
      };
    }
    default:
      throw new Error(`${m[2]} is not available for local Electron sessions yet (supported: act, act-batch, query, observe, assert, screenshot, release)`);
  }
}
