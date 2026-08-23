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
import type { Flow, Predicate } from "@argus/shared";

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
  const clean: Predicate = { kind: "console-clean", since: 0, includeThirdParty: false };
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
          expect: [{ kind: "network", urlIncludes: "/api/auth", status: 200, minCount: 1, since: 0 }],
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
      success: [{ kind: "network", urlIncludes: probe.apiHealth, status: 200, minCount: 1, since: 0 }],
      dynamic: [],
    });
  } else {
    skipped.push("api-health — no health endpoint found");
  }

  return { flows, skipped };
}
