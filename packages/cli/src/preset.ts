/**
 * The `cf-saas` preset — a baseline flow suite for the house stack
 * (Cloudflare Workers + Hono + React + Vite + better-auth).
 *
 * Route discovery is the hard part. In a client-routed SPA every path returns
 * HTTP 200 (the shell), so status codes prove nothing — probing that way
 * invents flows for routes that don't exist, and those flows then "pass"
 * against the not-found page. So discovery works two ways instead:
 *
 *   1. harvest the hrefs the app itself advertises on its landing page;
 *   2. render each candidate in a real browser and compare it against the
 *      app's own not-found fingerprint — same fingerprint means no such route.
 *
 * Anything that can't be confirmed is skipped and reported, never guessed.
 */
import type { Anchor, Flow, Predicate } from "@argus/shared";

/** What a rendered page looks like, as seen through a real browser. */
export interface RenderedPage {
  url: string;
  title: string;
  /** Text of the page's interactive elements — a cheap structural signature. */
  texts: string[];
}

export type RenderProbe = (path: string) => Promise<RenderedPage>;

export interface ProbeResult {
  signin?: string;
  signup?: string;
  protectedPath?: string;
  apiHealth?: string;
  /** A phrase unique to the app's not-found page, used to assert "real route". */
  notFoundMarker?: string;
  /** Does an anonymous visit to the protected route redirect to sign-in? */
  protectedRedirects: boolean;
  harvestedLinks: string[];
}

const SIGNIN_CANDIDATES = ["/signin", "/login", "/sign-in", "/auth/signin", "/auth/login"];
const SIGNUP_CANDIDATES = ["/sign-up", "/signup", "/register", "/auth/signup"];
const PROTECTED_CANDIDATES = ["/portal", "/dashboard", "/app", "/home", "/admin", "/settings"];
const HEALTH_CANDIDATES = ["/api/health", "/health", "/api/v1/health", "/api/status"];
const SENTINEL = "/__argus_no_such_route__";

/** Same-origin paths the landing page links to — the app naming its own routes. */
export async function harvestLinks(base: string): Promise<string[]> {
  const root = base.replace(/\/$/, "");
  try {
    const html = await (await fetch(root + "/")).text();
    const paths = new Set<string>();
    for (const m of html.matchAll(/href="([^"]+)"/g)) {
      const href = m[1]!;
      if (href.startsWith("/") && !href.startsWith("//")) paths.add(href.split("#")[0]!.split("?")[0]!);
      else if (href.startsWith(root)) paths.add(href.slice(root.length).split("#")[0]!.split("?")[0]! || "/");
    }
    return [...paths].filter(Boolean);
  } catch {
    return [];
  }
}

function sameShape(a: RenderedPage, b: RenderedPage): boolean {
  if (a.texts.length !== b.texts.length) return false;
  return a.texts.every((t, i) => t === b.texts[i]);
}

/** Pick the phrase most likely to identify the not-found page in assertions. */
function pickMarker(page: RenderedPage): string | undefined {
  const candidates = page.texts
    .map((t) => t.split("\n")[0]!.trim())
    .filter((t) => t.length >= 4 && t.length <= 40);
  // Prefer an explicit "back to safety" affordance — stable across releases.
  return (
    candidates.find((t) => /return home|go home|back home|not found|404/i.test(t)) ??
    candidates[candidates.length - 1]
  );
}

export async function probeApp(base: string, render: RenderProbe): Promise<ProbeResult> {
  const root = base.replace(/\/$/, "");
  const links = await harvestLinks(root);

  // The app's own not-found page — every non-route looks exactly like this.
  const fallback = await render(SENTINEL);
  const notFoundMarker = pickMarker(fallback);

  const exists = async (path: string): Promise<boolean> => {
    const page = await render(path);
    // A browser error page (chrome-error://, about:blank) is not a redirect:
    // an empty 404 lands there and once read as "real route" for every path.
    if (!/^https?:/i.test(page.url)) return false;
    // A redirect away from the requested path still means the route is real.
    if (!page.url.endsWith(path)) return true;
    return !sameShape(page, fallback);
  };

  /** Links the app advertises come first — it knows its own routes. */
  const firstReal = async (candidates: string[]): Promise<string | undefined> => {
    const ordered = [
      ...candidates.filter((c) => links.includes(c)),
      ...candidates.filter((c) => !links.includes(c)),
    ];
    for (const path of ordered) {
      if (await exists(path)) return path;
    }
    return undefined;
  };

  const signin = await firstReal(SIGNIN_CANDIDATES);
  const signup = await firstReal(SIGNUP_CANDIDATES);
  const protectedPath = await firstReal(PROTECTED_CANDIDATES);

  // Does hitting the protected route anonymously bounce you to sign-in?
  let protectedRedirects = false;
  if (protectedPath && signin) {
    const anon = await render(protectedPath);
    protectedRedirects = anon.url.includes(signin);
  }

  let apiHealth: string | undefined;
  for (const p of HEALTH_CANDIDATES) {
    try {
      if ((await fetch(root + p, { redirect: "manual" })).status === 200) {
        apiHealth = p;
        break;
      }
    } catch {
      /* keep looking */
    }
  }

  return { signin, signup, protectedPath, apiHealth, notFoundMarker, protectedRedirects, harvestedLinks: links };
}

export interface PresetOptions {
  base: string;
  probe: ProbeResult;
  authProfile: string;
  emailVar: string;
  passwordVar: string;
}

/**
 * Build the suite. Credentials are `${VAR}` placeholders resolved on the
 * developer's machine at replay time — never written into these files.
 */
export function buildCfSaasFlows(opts: PresetOptions): { flows: Flow[]; skipped: string[] } {
  const { base, probe, authProfile, emailVar, passwordVar } = opts;
  const root = base.replace(/\/$/, "");
  const flows: Flow[] = [];
  const skipped: string[] = [];
  const clean: Predicate = { kind: "console-clean", since: 0, cumulative: false, includeThirdParty: false };
  /** "this is a real route, not the not-found page" */
  const realRoute: Predicate[] = probe.notFoundMarker
    ? [{ kind: "hidden", anchor: { text: probe.notFoundMarker } }]
    : [];

  flows.push({
    version: 1,
    name: "landing-loads",
    startUrl: root + "/",
    viewport: "desktop",
    steps: [{ action: { action: "wait", ms: 1200 }, expect: [] }],
    success: [clean],
    dynamic: [],
  });

  if (probe.signin) {
    flows.push({
      version: 1,
      name: "signin-page",
      startUrl: root + probe.signin,
      viewport: "desktop",
      steps: [{ action: { action: "wait", ms: 1200 }, expect: [] }],
      success: [{ kind: "visible", anchor: { css: 'input[type="password"]' } }, clean],
      dynamic: [],
    });

    // The login itself — the flow that mints the auth profile everything else uses.
    flows.push({
      version: 1,
      name: "auth-login",
      startUrl: root + probe.signin,
      viewport: "desktop",
      steps: [
        { action: { action: "wait", ms: 1200 }, expect: [] },
        {
          action: { action: "fill", value: `\${${emailVar}}` },
          anchor: { css: 'input[type="email"], input[name="email"]' },
          expect: [],
        },
        {
          action: { action: "fill", value: `\${${passwordVar}}` },
          anchor: { css: 'input[type="password"]' },
          expect: [],
        },
        {
          action: { action: "click" },
          anchor: { css: 'button[type="submit"]' },
          // The consequence that proves a real sign-in, not just a spinner.
          expect: [{ kind: "network", urlIncludes: "/api/auth", status: 200, minCount: 1, since: 0, cumulative: false }],
        },
        { action: { action: "wait", ms: 1500 }, expect: [] },
      ],
      success: [{ kind: "hidden", anchor: { css: 'input[type="password"]' } }, clean],
      dynamic: [],
      saveAuthAs: authProfile,
    });
  } else {
    skipped.push("signin-page / auth-login — no sign-in route confirmed");
  }

  if (probe.signup) {
    flows.push({
      version: 1,
      name: "signup-page",
      startUrl: root + probe.signup,
      viewport: "desktop",
      steps: [{ action: { action: "wait", ms: 1200 }, expect: [] }],
      success: [{ kind: "visible", anchor: { css: 'input[type="password"]' } }, clean],
      dynamic: [],
    });
  } else {
    skipped.push("signup-page — no signup route confirmed");
  }

  if (probe.protectedPath) {
    // Signed in, the protected route must render its real page — asserting
    // "not the not-found page" is what stops this from being a false green.
    flows.push({
      version: 1,
      name: "authed-area",
      startUrl: root + probe.protectedPath,
      viewport: "desktop",
      steps: [{ action: { action: "wait", ms: 2000 }, expect: [] }],
      success: [
        ...realRoute,
        { kind: "hidden", anchor: { css: 'input[type="password"]' } },
        clean,
      ],
      dynamic: [],
      auth: authProfile,
    });

    if (probe.protectedRedirects && probe.signin) {
      flows.push({
        version: 1,
        name: "protected-redirect",
        startUrl: root + probe.protectedPath,
        viewport: "desktop",
        steps: [{ action: { action: "wait", ms: 2000 }, expect: [] }],
        success: [{ kind: "route", includes: probe.signin }],
        dynamic: [],
      });
    } else {
      skipped.push(
        `protected-redirect — ${probe.protectedPath} does not redirect anonymous visitors to sign-in (verify that's intended)`
      );
    }
  } else {
    skipped.push("authed-area / protected-redirect — no protected route confirmed");
  }

  flows.push({
    version: 1,
    name: "unknown-route",
    startUrl: root + "/argus-unknown-route-check",
    viewport: "desktop",
    steps: [{ action: { action: "wait", ms: 1200 }, expect: [] }],
    success: probe.notFoundMarker
      ? [{ kind: "visible", anchor: { text: probe.notFoundMarker } }, clean]
      : [clean],
    dynamic: [],
  });

  if (probe.apiHealth) {
    flows.push({
      version: 1,
      name: "api-health",
      startUrl: root + probe.apiHealth,
      viewport: "desktop",
      steps: [{ action: { action: "wait", ms: 600 }, expect: [] }],
      success: [{ kind: "network", urlIncludes: probe.apiHealth, status: 200, minCount: 1, since: 0, cumulative: false }],
      dynamic: [],
    });
  } else {
    skipped.push("api-health — no health endpoint found");
  }

  return { flows, skipped };
}

// ---------------------------------------------------------------------------
// Discriminating list cases — does the data respond, not just the page?
// See docs/discriminating-cases.md.
// ---------------------------------------------------------------------------

/** An interactive element as the probe's surface scan reports it. */
export interface SurfaceElement {
  role?: string;
  name?: string;
  text?: string;
  testid?: string;
  tag?: string;
}

/** A list page the probe found: its rows, a search box over them, maybe a pager. */
export interface ListProbe {
  path: string;
  /** Matches EVERY row — the one anchor that is meant to match many. */
  item: Anchor;
  rows: string[];
  search?: Anchor;
  next?: Anchor;
}

/** Row containers, most specific first. A table body excludes its header row. */
export const ROW_CANDIDATES: Anchor[] = [{ css: "tbody tr" }, { role: "listitem" }];

const SEARCH_NAME = /search|filter/i;
const NEXT_NAME = /^(next( page)?|›|»|→)$/i;

/** A search control on the surface: testid first, else the exact label it advertises. */
export function findSearch(elements: SurfaceElement[]): Anchor | undefined {
  const el = elements.find(
    (e) => e.tag === "input" && (e.role === "searchbox" || SEARCH_NAME.test(e.name ?? "") || SEARCH_NAME.test(e.testid ?? ""))
  );
  if (!el) return undefined;
  if (el.testid) return { testid: el.testid };
  if (el.role === "searchbox") return { role: "searchbox", name: el.name };
  if (!el.name) return undefined;
  // The scan's name is aria-label ?? placeholder — match whichever it was.
  const v = el.name.replace(/"/g, '\\"');
  return { css: `input[aria-label="${v}"], input[placeholder="${v}"]` };
}

/** A next-page control: a link or button whose whole label says "next". */
export function findNext(elements: SurfaceElement[]): Anchor | undefined {
  const el = elements.find((e) => NEXT_NAME.test((e.text ?? e.name ?? "").trim()));
  if (!el) return undefined;
  if (el.testid) return { testid: el.testid };
  return { role: el.tag === "a" || el.role === "link" ? "link" : "button", name: (el.text ?? el.name ?? "").trim() };
}

/**
 * Choose the value to type into the search box. It must DISCRIMINATE: some
 * rows include it (case-insensitive) and some don't — otherwise an ignored
 * filter and a working one look identical. Undefined when no value splits
 * the rows; the case is then skipped, never guessed.
 */
export function pickDiscriminatingValue(rows: string[]): string | undefined {
  if (rows.length < 2) return undefined;
  const lower = rows.map((r) => r.toLowerCase());
  // Words, not ids: pure numbers are volatile and often not searchable.
  const tokens = new Set(lower.flatMap((r) => r.match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((t) => !/^\d+$/.test(t)));
  let best: { token: string; distance: number } | undefined;
  for (const token of tokens) {
    // Counted the way the replayed `rows` check matches: case-insensitive substring.
    const hits = lower.filter((r) => r.includes(token)).length;
    if (hits === 0 || hits === rows.length) continue;
    // Closest to half the rows splits best and survives a little data drift.
    const distance = Math.abs(hits / rows.length - 0.5);
    const better =
      !best ||
      distance < best.distance ||
      (distance === best.distance && (token.length > best.token.length || (token.length === best.token.length && token < best.token)));
    if (better) best = { token, distance };
  }
  return best?.token;
}

/** The list cases for one probed page. Row data never lands in the file — only V and anchors. */
export function buildListFlows(opts: {
  base: string;
  list: ListProbe;
  authProfile?: string;
}): { flows: Flow[]; skipped: string[] } {
  const { list, authProfile } = opts;
  const root = opts.base.replace(/\/$/, "");
  const flows: Flow[] = [];
  const skipped: string[] = [];
  const clean: Predicate = { kind: "console-clean", since: 0, cumulative: false, includeThirdParty: false };
  const auth = authProfile ? { auth: authProfile } : {};

  const value = list.search ? pickDiscriminatingValue(list.rows) : undefined;
  if (!list.search) {
    skipped.push(`list-filter-applies — no search control on ${list.path}`);
  } else if (!value) {
    skipped.push(`list-filter-applies — no value splits the ${list.rows.length} rows on ${list.path}`);
  } else {
    flows.push({
      version: 1,
      name: "list-filter-applies",
      startUrl: root + list.path,
      viewport: "desktop",
      ...auth,
      // The split this case depends on — gone tomorrow means untested, not regressed.
      precondition: [
        { kind: "rows", item: list.item, minCount: 2, some: { includes: value }, someNot: { includes: value } },
      ],
      steps: [
        { action: { action: "wait", ms: 800 }, expect: [], snapshot: { name: "before", item: list.item } },
        { action: { action: "fill", value }, anchor: list.search, expect: [] },
        // Debounced search fetches after the act settles — give it a beat.
        { action: { action: "wait", ms: 1500 }, expect: [] },
      ],
      success: [
        { kind: "rows", item: list.item, minCount: 1, every: { includes: value }, fewerThan: "before" },
        clean,
      ],
      dynamic: [],
    });
  }

  if (!list.next) {
    skipped.push(`list-next-page-advances — no next-page control on ${list.path}`);
  } else {
    flows.push({
      version: 1,
      name: "list-next-page-advances",
      startUrl: root + list.path,
      viewport: "desktop",
      ...auth,
      precondition: [{ kind: "rows", item: list.item, minCount: 1 }],
      steps: [
        { action: { action: "wait", ms: 800 }, expect: [], snapshot: { name: "page1", item: list.item } },
        { action: { action: "click" }, anchor: list.next, expect: [] },
        { action: { action: "wait", ms: 1200 }, expect: [] },
      ],
      success: [{ kind: "rows", item: list.item, minCount: 1, notSubsetOf: "page1" }, clean],
      dynamic: [],
    });
  }

  return { flows, skipped };
}

/** Pick the row set to reason about: the first candidate that renders ≥2 rows with text. */
export function chooseRows(candidates: Array<{ anchor: Anchor; texts: string[] }>): { item: Anchor; rows: string[] } | undefined {
  for (const c of candidates) {
    const rows = c.texts.map((t) => t.trim()).filter(Boolean);
    if (rows.length >= 2) return { item: c.anchor, rows };
  }
  return undefined;
}

/** What a replay reports, as far as the generation gate cares. */
export interface ReplayLike {
  status: string;
  stepsRun?: number;
  failedStep?: number;
  decision?: { verdict?: string; whatChanged?: string };
}

const UNTESTED_VERDICTS = new Set(["fleet_busy", "auth_profile_missing", "precondition_unmet"]);

/**
 * The generation gate: a generated case joins the suite only after it passes
 * twice on the build it was generated from. The same failure twice may be a
 * real bug or a bad case — it is kept as a candidate for a human, never run
 * in the suite. Disagreement or "couldn't test" drops it.
 */
export function gateDecision(first: ReplayLike, second: ReplayLike): { keep: "suite" | "candidate" | "drop"; reason: string } {
  const untested = (r: ReplayLike) =>
    UNTESTED_VERDICTS.has(r.decision?.verdict ?? "") || (r.decision?.verdict === "error" && r.stepsRun === 0 && r.failedStep === undefined);
  const blocked = [first, second].find(untested);
  if (blocked) return { keep: "drop", reason: `could not test (${blocked.decision?.verdict})` };
  if (first.status === "ok" && second.status === "ok") return { keep: "suite", reason: "passed twice" };
  const sig = (r: ReplayLike) =>
    [r.status, r.decision?.verdict ?? "", r.failedStep ?? "", (r.decision?.whatChanged ?? "").replace(/\d{4,}/g, "#")].join("|");
  if (first.status !== "ok" && second.status !== "ok" && sig(first) === sig(second)) {
    return { keep: "candidate", reason: `failed the same way twice: ${first.decision?.whatChanged ?? first.decision?.verdict}` };
  }
  return { keep: "drop", reason: "results disagreed between two runs (flaky at generation)" };
}
