/**
 * Session steps — turning a driven action into the saved-flow step that
 * repeats it, and a session's accumulated steps into a flow ready to save.
 *
 * `describeTarget` runs inside the page; the rest is pure. Two rules hold
 * everywhere a step is produced (action responses, recordings, drafts):
 *   - a step carries a semantic anchor, never a volatile ref;
 *   - what is typed into a password field is never written into a step — the
 *     step carries a `${VAR}` placeholder that replay resolves from the
 *     environment.
 */
import type { Action, Anchor, FlowDraft, FlowStep, NetworkEvent, Predicate, ViewportName } from "@argus/shared";

export interface TargetInfo {
  /** Anchors that may identify the element, best first (testid → role+name → text → css). */
  candidates: Anchor[];
  /** A password field: its value must never be returned. */
  secure: boolean;
  /** The field's own name (testid, name attribute or id) — names its placeholder. */
  hint: string;
  /** How many elements the locator matched, when the target came as a locator's match list. */
  matched?: number;
}

/**
 * Runs IN THE PAGE, so it must stay self-contained: no imports, no closures
 * over module scope. The target arrives in whichever form costs the fewest
 * round trips to Chromium: an argus ref (`page.evaluate`), a locator's match
 * list (`locator.evaluateAll`, which also yields the match count), or the
 * element itself.
 */
export function describeTarget(target: any): TargetInfo | undefined {
  const el = Array.isArray(target)
    ? target[0]
    : typeof target === "string"
      ? document.querySelector(`[data-argus-ref="${target}"]`)
      : target;
  if (!el) return undefined;
  const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
  const tag = String(el.tagName).toLowerCase();
  const type = tag === "input" ? String(el.getAttribute("type") || "text").toLowerCase() : "";
  if (
    tag === "input" &&
    (type === "password" || String(el.getAttribute("autocomplete") || "").toLowerCase().includes("password"))
  ) {
    el.__argusSecure = true; // sticky: survives a "show password" toggle
  }
  const secure = el.__argusSecure === true;
  const isField = tag === "input" || tag === "textarea" || tag === "select";

  const candidates: Anchor[] = [];
  const testid = el.getAttribute("data-testid");
  if (testid) candidates.push({ testid });

  const label = clean(el.getAttribute("aria-label"));
  const explicitRole = el.getAttribute("role");
  if (explicitRole && label) candidates.push({ role: explicitRole, name: label });

  // The implicit ARIA role of the common controls. A password input has none.
  let role: string | undefined;
  if (tag === "button" || (tag === "input" && (type === "submit" || type === "button"))) role = "button";
  else if (tag === "a" && el.hasAttribute("href")) role = "link";
  else if (tag === "textarea") role = "textbox";
  else if (tag === "select") role = "combobox";
  else if (tag === "input" && type === "checkbox") role = "checkbox";
  else if (tag === "input" && type === "radio") role = "radio";
  else if (tag === "input" && ["text", "email", "tel", "url"].includes(type)) role = "textbox";
  else if (tag === "input" && type === "search") role = "searchbox";
  const text = clean(el.textContent).slice(0, 60);
  if (role && !explicitRole) {
    const name =
      label ||
      (isField
        ? clean(el.labels?.[0]?.textContent) || clean(el.getAttribute("placeholder"))
        : tag === "input"
          ? clean(el.value)
          : text);
    if (name) candidates.push({ role, name: name.slice(0, 60) });
  }

  if (!isField && text) candidates.push({ text });

  const esc = (s: string) => s.replace(/["\\]/g, "\\$&");
  const id = el.getAttribute("id");
  const nameAttr = el.getAttribute("name");
  if (id) candidates.push({ css: `[id="${esc(id)}"]` });
  if (isField && nameAttr) candidates.push({ css: `${tag}[name="${esc(nameAttr)}"]` });

  return {
    candidates,
    secure,
    hint: testid || nameAttr || id || "",
    ...(Array.isArray(target) ? { matched: target.length } : {}),
  };
}

/** `login-password` → `LOGIN_PASSWORD`; anything unusable → `PASSWORD`. */
export function placeholderName(hint: string): string {
  const name = hint
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  if (!name) return "PASSWORD";
  return /^[A-Z_]/.test(name) ? name : `SECRET_${name}`;
}

const NEEDS_TARGET = new Set(["click", "fill", "select", "hover"]);

export interface BuiltStep {
  step: FlowStep;
  /** Why the step may not replay as it stands. */
  note?: string;
  /** True when the note is a reason the flow cannot be saved as it is. */
  blocking: boolean;
}

/**
 * The saved-flow form of one performed action: the action without its ref or
 * inline anchor, beside the anchor the target resolved to.
 */
export function buildStep(
  action: Action,
  target: { anchor?: Anchor; matched?: number; secure?: boolean; hint?: string }
): BuiltStep {
  const clean = { ...action } as Record<string, unknown>;
  delete clean.ref;
  delete clean.anchor;

  const notes: string[] = [];
  let blocking = false;
  if (action.action === "fill" && target.secure) {
    const name = placeholderName(target.hint ?? "");
    clean.value = `\${${name}}`;
    notes.push(`password field: the value is not returned — replay reads it from the environment as ${name}`);
  }
  const aimed = action as { ref?: string; anchor?: Anchor };
  const targeted = aimed.ref !== undefined || aimed.anchor !== undefined;
  if (!target.anchor && (NEEDS_TARGET.has(action.action) || targeted)) {
    blocking = true;
    notes.push(
      "no anchor identifies this element uniquely — give it a data-testid (or act with an explicit anchor) before saving"
    );
  } else if (target.anchor && target.matched !== undefined && target.matched > 1) {
    blocking = true;
    notes.push(
      `the anchor matched ${target.matched} elements and the action used the first — replay refuses ambiguous anchors, so tighten it before saving`
    );
  }

  return {
    step: {
      action: clean as unknown as Action,
      ...(target.anchor ? { anchor: target.anchor } : {}),
      expect: [],
    },
    ...(notes.length ? { note: notes.join("; ") } : {}),
    blocking,
  };
}

/** Remove a secret from text that may quote it (Playwright errors echo what was typed). */
export function scrub(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface DraftInput {
  name: string;
  startUrl: string;
  viewport: ViewportName;
  steps: FlowStep[];
  /** Per-step reasons the flow is not saveable yet, each already naming its step. */
  blockers: string[];
  dropped: number;
  finalUrl: string;
  /** Console errors the session saw since the steps began. */
  consoleErrors: number;
  /** Network events since the steps began. */
  network: NetworkEvent[];
}

/** A session's accumulated steps, shaped as the arguments `argus_flow_save` takes. */
export function buildFlowDraft(input: DraftInput): FlowDraft {
  const notes: string[] = [];
  let origin = "";
  let path = "/";
  try {
    const u = new URL(input.finalUrl);
    origin = u.origin;
    path = u.pathname;
  } catch {
    /* about:blank and friends have no route to assert */
  }

  // Only what the final page itself can vouch for goes into `success`.
  const success: Predicate[] = [];
  if (path !== "/") success.push({ kind: "route", includes: path });
  if (input.consoleErrors === 0)
    success.push({ kind: "console-clean", since: 0, cumulative: false, includeThirdParty: false });
  if (success.length === 0) success.push({ kind: "route", includes: path });

  // First-party writes the session actually observed — the consequences worth asserting.
  const seen = new Set<string>();
  const suggested: Predicate[] = [];
  for (const e of input.network) {
    if (e.failed || e.status === undefined || e.status >= 400) continue;
    if (["GET", "HEAD", "OPTIONS"].includes(e.method.toUpperCase())) continue;
    let u: URL;
    try {
      u = new URL(e.url);
    } catch {
      continue;
    }
    if (u.origin !== origin) continue;
    const key = `${e.method} ${u.pathname} ${e.status}`;
    if (seen.has(key) || suggested.length >= 5) continue;
    seen.add(key);
    suggested.push({
      kind: "network",
      urlIncludes: u.pathname,
      method: e.method.toUpperCase(),
      status: e.status,
      minCount: 1,
      since: 0,
      cumulative: false,
    });
  }

  const placeholders = new Set<string>();
  for (const s of input.steps) {
    const value = (s.action as { value?: unknown }).value;
    if (typeof value === "string") for (const m of value.matchAll(PLACEHOLDER)) placeholders.add(m[1]!);
  }

  if (input.steps.length === 0) notes.push("no successful actions yet — drive the journey with argus_act first");
  notes.push(...input.blockers);
  if (placeholders.size > 0)
    notes.push(
      `set ${[...placeholders].join(", ")} in the environment that replays this flow — the stdio MCP server and the CLI resolve \${VAR} placeholders locally, so the secret is never stored in the flow`
    );
  if (input.dropped > 0)
    notes.push(`${input.dropped} later step(s) were not kept — the session passed the accumulation cap; reset and re-drive a shorter journey`);
  notes.push(
    suggested.length > 0
      ? "success only states the final route / a clean console — promote the suggested network predicates (into success, or the expect of the step that causes them) so the flow asserts a consequence"
      : "success only states the final route / a clean console — add the network or route consequence that proves this journey before trusting a green"
  );

  return {
    flow: {
      name: input.name,
      startUrl: input.startUrl,
      viewport: input.viewport,
      steps: input.steps,
      success,
    },
    ready: input.steps.length > 0 && input.blockers.length === 0,
    suggested,
    placeholders: [...placeholders],
    dropped: input.dropped,
    notes,
  };
}
