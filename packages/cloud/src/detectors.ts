/**
 * Deterministic layout & content detectors — no model, real computed layout.
 *
 * Each catches a "this looks broken" class a pixel diff can't explain, and each
 * finding names a consequence in one sentence. One rule on one screen is ONE
 * finding listing sample elements, never one finding per element (eleven
 * low-contrast labels are one decision, not eleven).
 *
 * (Detector set after bugpatrol's detection rubric, Apache-2.0.)
 */
import type { Page } from "@cloudflare/playwright";
import type { Action, ActEffects, Finding, ViewportName } from "@argus/shared";

export interface DetectorHit {
  rule: DetectorRule;
  count: number;
  samples: string[];
}

export type DetectorRule =
  | "layout/occluded-control"
  | "layout/zero-size-control"
  | "layout/small-tap-target"
  | "layout/broken-image"
  | "layout/unstyled-page"
  | "content/placeholder-text"
  | "content/raw-value"
  | "content/i18n-key";

export interface PageState {
  hits: DetectorHit[];
  nodes: number;
  overflow: boolean;
  /** Visible error signals: alert regions with text + error wording in the body. */
  errors: number;
  /** DOM mutations since observe:"start" (-1: a new document, or not observing). */
  mutations: number;
  /** Focus moved since observe:"start" — to something OTHER than the element interacted with. */
  focusChanged: boolean;
  /**
   * The interaction put the caret in a field it wasn't in before (tapping an
   * input/textarea/contenteditable). That IS the control working — the user
   * can now type — even though nothing on screen changed.
   */
  focusEntered: boolean;
}

/**
 * Everything Argus measures about a page, in ONE round-trip to the browser
 * (each separate evaluate is a CDP hop; an act used to make ~12 of them).
 * `observe: "start"` installs a mutation/focus watch; `"read"` reads and stops
 * it. Read-only and best-effort: never throws.
 */
export async function pageState(
  page: Page,
  opts: { tapTargets?: boolean; detectors?: boolean; observe?: "start" | "read" | "none" } = {}
): Promise<PageState> {
  const empty: PageState = { hits: [], nodes: 0, overflow: false, errors: 0, mutations: -1, focusChanged: false, focusEntered: false };
  return await page
    .evaluate(
      (o: { tapTargets: boolean; detectors: boolean; observe: string }) => {
        const w = window as any;
        let mutations = -1;
        let focusChanged = false;
        let focusEntered = false;
        if (o.observe === "read") {
          mutations = typeof w.__argusMut === "number" ? w.__argusMut : -1;
          const active = document.activeElement as any;
          const touched = w.__argusTouched as any;
          // Focus landing on (or around) the element just clicked/typed into is
          // not an effect of the action — decided here, without another hop.
          const onTarget = Boolean(active && touched && (active === touched || active.contains(touched) || touched.contains(active)));
          focusChanged = w.__argusFocus !== undefined && active !== w.__argusFocus && !onTarget;
          const editable =
            active &&
            (active.isContentEditable ||
              active.tagName === "TEXTAREA" ||
              (active.tagName === "INPUT" && !/^(button|submit|reset|checkbox|radio|file|image|range|color)$/i.test(active.type ?? "")));
          focusEntered = Boolean(editable && onTarget && active !== w.__argusFocus);
          w.__argusObs?.disconnect();
          w.__argusStopTouch?.();
        }
        const nodes = document.querySelectorAll("*").length;
        const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
        const tapTargets = o.tapTargets;
        let out: Array<{ rule: string; count: number; samples: string[] }> = [];
        let errors = 0;
        if (o.detectors) {
        const hits: Record<string, { count: number; samples: string[] }> = {};
        const add = (rule: string, el: any, label?: string) => {
          const h = (hits[rule] ??= { count: 0, samples: [] });
          h.count++;
          if (h.samples.length < 3) h.samples.push(label ?? describe(el));
        };
        function describe(el: any): string {
          const tag = el.tagName.toLowerCase();
          const testid = el.getAttribute?.("data-testid");
          if (testid) return `${tag}[data-testid="${testid}"]`;
          if (el.id) return `${tag}#${el.id}`;
          const name = (el.getAttribute?.("aria-label") || el.innerText || el.alt || "").trim().replace(/\s+/g, " ");
          return name ? `${tag} "${name.slice(0, 40)}"` : tag;
        }
        const visible = (el: any) => {
          const cs = getComputedStyle(el);
          return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.01;
        };

        const controls = Array.from(
          document.querySelectorAll(
            'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"]'
          )
        ) as any[];
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        // Rendered control boxes, for WCAG 2.5.8's spacing exception below.
        const boxes = controls
          .filter((el: any) => visible(el))
          .map((el: any) => ({ el, r: el.getBoundingClientRect() }))
          .filter((b: any) => b.r.width >= 1 && b.r.height >= 1);
        for (const el of controls) {
          if (!visible(el) || el.closest("[aria-hidden='true'], [inert]")) continue;
          const r = el.getBoundingClientRect();
          // A rendered control with no area can't be used at all.
          if ((r.width < 1 || r.height < 1) && el.getClientRects().length > 0 && !el.closest("details:not([open])")) {
            add("layout/zero-size-control", el);
            continue;
          }
          if (r.width < 1 || r.height < 1) continue;
          // Only judge what is on screen now — below-the-fold is not "covered".
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          if (cx >= 0 && cy >= 0 && cx < vw && cy < vh && !el.disabled) {
            const top = document.elementFromPoint(cx, cy) as any;
            if (top && top !== el && !el.contains(top) && !top.contains(el)) {
              // Labels forward clicks to their control; that's not occlusion.
              const viaLabel = top.closest?.("label") && (top.closest("label").control === el || top.closest("label").contains(el));
              if (!viaLabel) add("layout/occluded-control", el, `${describe(el)} under ${describe(top)}`);
            }
          }
          // WCAG 2.5.8: 24×24 CSS px. Exempt: inline text links, and the spacing
          // exception — an undersized target passes when a 24px circle on its
          // centre touches no other target (a lone small link is still easy to hit).
          if (tapTargets && (r.width < 24 || r.height < 24)) {
            const inlineLink = el.tagName === "A" && getComputedStyle(el).display === "inline";
            const crowded = boxes.some((b: any) => {
              if (b.el === el || b.el.contains(el) || el.contains(b.el)) return false;
              const nx = Math.max(b.r.left, Math.min(cx, b.r.right));
              const ny = Math.max(b.r.top, Math.min(cy, b.r.bottom));
              return (nx - cx) ** 2 + (ny - cy) ** 2 < 12 * 12;
            });
            if (!inlineLink && crowded) add("layout/small-tap-target", el, `${describe(el)} (${Math.round(r.width)}×${Math.round(r.height)})`);
          }
        }

        for (const img of Array.from(document.images) as any[]) {
          if (img.getAttribute("src") && img.complete && img.naturalWidth === 0 && visible(img)) add("layout/broken-image", img, `img ${String(img.getAttribute("src")).slice(0, 60)}`);
        }

        const elementCount = document.body ? document.body.getElementsByTagName("*").length : 0;
        if (document.styleSheets.length === 0 && !document.querySelector("[style]") && elementCount > 30) {
          add("layout/unstyled-page", document.body, "no stylesheet applied");
        }

        // Visible text leaf-ish nodes: what a user actually reads.
        const TLDS = /\.(com|org|net|io|dev|ai|app|co|gov|edu|uk|de|fr|in|us|me|sh|xyz|cloud|tech|site)$/i;
        const walker = document.createTreeWalker(document.body, 4 /* NodeFilter.SHOW_TEXT */);
        let node: any;
        let scanned = 0;
        while ((node = walker.nextNode()) && scanned < 4000) {
          scanned++;
          const text = String(node.nodeValue ?? "").trim();
          if (!text || text.length > 400) continue;
          const parent = node.parentElement;
          if (!parent || ["SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "TEXTAREA"].includes(parent.tagName) || !visible(parent)) continue;
          if (/\blorem ipsum\b|\b(TODO|FIXME|TBD|XXX)\b|\{\{\s*[\w.]+\s*\}\}/.test(text)) {
            add("content/placeholder-text", parent, `"${text.slice(0, 50)}"`);
          } else if (/^(undefined|null|NaN|\[object Object\]|Invalid Date)$/.test(text) || /\b(undefined|NaN|\[object Object\])\b/.test(text) && text.length < 80) {
            add("content/raw-value", parent, `"${text.slice(0, 50)}"`);
          } else if (/^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+){2,}$/.test(text) && !TLDS.test(text)) {
            add("content/i18n-key", parent, `"${text.slice(0, 50)}"`);
          }
        }
          out = Object.entries(hits).map(([rule, h]) => ({ rule, count: h.count, samples: h.samples }));
          const alerts = (Array.from(document.querySelectorAll('[role="alert"], [aria-live="assertive"]')) as any[]).filter(
            (el) => (el.innerText ?? "").trim().length > 0
          ).length;
          const bodyText = document.body ? String((document.body as any).innerText ?? "") : "";
          const words = bodyText.match(/\b(error|errors|failed|failure|couldn['’]?t|could not|unable to|try again|went wrong|invalid)\b/gi);
          errors = alerts + (words ? words.length : 0);
        }
        if (o.observe === "start") {
          w.__argusObs?.disconnect();
          w.__argusMut = 0;
          w.__argusFocus = document.activeElement;
          w.__argusObs = new w.MutationObserver((m: unknown[]) => {
            w.__argusMut += m.length;
          });
          w.__argusObs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
          // Remember what the action touched (pointer/keyboard/input target).
          w.__argusStopTouch?.();
          w.__argusTouched = undefined;
          const touch = (e: any) => {
            w.__argusTouched = e.target;
          };
          for (const t of ["pointerdown", "mousedown", "keydown", "input"]) document.addEventListener(t, touch, true);
          w.__argusStopTouch = () => {
            for (const t of ["pointerdown", "mousedown", "keydown", "input"]) document.removeEventListener(t, touch, true);
          };
        }
        return { hits: out, nodes, overflow, errors, mutations, focusChanged, focusEntered };
      },
      { tapTargets: opts.tapTargets ?? false, detectors: opts.detectors ?? false, observe: opts.observe ?? "none" }
    )
    .then((st) => st as PageState)
    .catch(() => empty);
}

/** Layout & content detector hits (one page state read). */
export async function probeLayout(page: Page, opts: { tapTargets: boolean }): Promise<DetectorHit[]> {
  return (await pageState(page, { tapTargets: opts.tapTargets, detectors: true })).hits;
}

/**
 * Problems present after an action that weren't there before it (by rule
 * count). After a navigation the baseline is a different page, so every
 * problem on the new page is new to the caller.
 */
export function newIssues(
  before: DetectorHit[],
  after: DetectorHit[],
  navigated: boolean
): Array<{ rule: string; count: number; samples: string[] }> {
  const prior = new Map(before.map((h) => [h.rule, h.count]));
  return after
    .map((h) => ({ rule: h.rule, count: navigated ? h.count : h.count - (prior.get(h.rule) ?? 0), samples: h.samples }))
    .filter((h) => h.count > 0);
}

const META: Record<DetectorRule, { severity: Finding["severity"]; category: Finding["category"]; what: string; next: string }> = {
  "layout/occluded-control": {
    severity: "major",
    category: "layout",
    what: "an interactive control is covered at its centre point — a click lands on something else",
    next: "find the overlapping element (sticky header/footer, overlay, z-index) and move or stack it below the control",
  },
  "layout/zero-size-control": {
    severity: "major",
    category: "layout",
    what: "an interactive control renders with no area — users cannot click it",
    next: "give the control real dimensions, or remove it if it is meant to be hidden",
  },
  "layout/small-tap-target": {
    severity: "minor",
    category: "layout",
    what: "a touch target is smaller than 24×24 CSS px (WCAG 2.5.8) — easy to miss on a phone",
    next: "increase the hit area with padding or min-width/min-height",
  },
  "layout/broken-image": {
    severity: "major",
    category: "layout",
    what: "an image failed to load and renders as a broken placeholder",
    next: "check the image URL and that the asset is deployed",
  },
  "layout/unstyled-page": {
    severity: "critical",
    category: "layout",
    what: "the page rendered with no stylesheet — the CSS failed to load",
    next: "check the stylesheet URL, its MIME type and the CSP",
  },
  "content/placeholder-text": {
    severity: "minor",
    category: "content",
    what: "placeholder copy (lorem ipsum, TODO, unrendered {{template}}) is visible to users",
    next: "replace the placeholder with real copy, or fix the template that failed to render",
  },
  "content/raw-value": {
    severity: "major",
    category: "content",
    what: "a raw programming value (undefined, NaN, [object Object]) is shown to users — a data bug",
    next: "trace the rendered field back to its data source; a value is missing or the wrong type",
  },
  "content/i18n-key": {
    severity: "minor",
    category: "content",
    what: "a raw translation key is rendered instead of translated text",
    next: "add the key to the locale file, or fix the lookup",
  },
};

/** Grouped hits → findings (one per rule per viewport). */
export function detectorFindings(hits: DetectorHit[], viewport: ViewportName, fid: () => string): Finding[] {
  return hits
    .filter((h) => h.rule in META)
    .map((h) => {
      const m = META[h.rule];
      const head = m.what.split(" — ")[0]!;
      return {
        id: fid(),
        severity: m.severity,
        category: m.category,
        rule: h.rule,
        summary: `${head[0]!.toUpperCase()}${head.slice(1)} at ${viewport} (${h.count} element${h.count === 1 ? "" : "s"})`,
        detail: `e.g. ${h.samples.join("; ")}`,
        evidence: { viewport },
        decision: { whatChanged: m.what, nextAction: `${m.next} — e.g. ${h.samples[0]}` },
      };
    });
}

/**
 * Mid-request read: does the page tell the user it is working? Looks at the
 * element just acted on (disabled / aria-busy / "Saving…" label) and at the
 * page (aria-busy regions, progress bars, live status text, spinner-ish
 * elements). ONE evaluate, and only when a request is slow — see `pending`.
 */
export async function pendingFeedback(page: Page): Promise<{ feedback: boolean; signals: string[] }> {
  const none = { feedback: false, signals: [] as string[] };
  return await page
    .evaluate(() => {
      const signals: string[] = [];
      const shown = (e: any) => {
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
      };
      const busyText = /(…|\.\.\.|\b(loading|saving|adding|sending|submitting|processing|please wait)\b)/i;
      const el = (window as any).__argusTouched as any;
      const control = el?.closest?.("button,[role=button],input,select,textarea,a,form") ?? el;
      if (control) {
        if (control.disabled || control.getAttribute?.("aria-disabled") === "true") signals.push("control disabled");
        if (control.getAttribute?.("aria-busy") === "true") signals.push("control aria-busy");
        if (busyText.test((control.textContent ?? "") + " " + (control.value ?? ""))) signals.push("control label says it is working");
      }
      const first = (sel: string) => (Array.from(document.querySelectorAll(sel)) as any[]).find(shown);
      const region = (Array.from(document.querySelectorAll('[aria-busy="true"]')) as any[]).find((e) => e !== control && shown(e));
      if (region) signals.push("aria-busy region");
      if (first('[role="progressbar"],progress')) signals.push("progress bar");
      const status = (Array.from(document.querySelectorAll('[role="status"],[aria-live]')) as any[]).find(
        (e) => shown(e) && busyText.test(e.textContent ?? "")
      );
      if (status) signals.push("live status text");
      // Enter in a field submits via a button the user never touched: its label counts too.
      const busyButton = (Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"]')) as any[]).find(
        (b) => b !== control && shown(b) && busyText.test((b.textContent ?? "") + " " + (b.value ?? ""))
      );
      if (busyButton) signals.push("a button shows it is working");
      if (first('[class*="spinner"],[class*="loader"],[class*="loading"],[class*="skeleton"],[class*="spin"]'))
        signals.push("spinner/skeleton element");
      return { feedback: signals.length > 0, signals };
    })
    .catch(() => none);
}

/**
 * Actions that should DO something visible: a click, or Enter/Space. Fill and
 * select legitimately just store a value; navigation, hover, scroll and wait
 * aren't a user waiting on the app. Decides both `silentAction` and whether a
 * mid-request `pending` read means anything.
 */
export function isInteraction(action: Action): boolean {
  return action.action === "click" || (action.action === "press" && /^(Enter| |Space)$/.test(action.key));
}

/** Everything one act observed — the input to `actEffects`, from either backend. */
export interface ActWindow {
  action: Action;
  urlBefore: string;
  urlAfter: string;
  navigated: boolean;
  before: PageState;
  after: PageState;
  watch: boolean;
  /** Buffered events; only those with seq > seqBefore belong to this act. */
  network: Array<{ seq: number; url: string; failed: boolean }>;
  console: Array<{ seq: number; level: string }>;
  seqBefore: number;
  pending?: ActEffects["pending"];
  timings: NonNullable<ActEffects["timings"]>;
}

/**
 * What an act DID, decided from what it observed. Pure, so the cloud session
 * and a local (Electron) session report the same effects for the same page.
 */
export function actEffects(w: ActWindow): ActEffects {
  const { action, before, after, navigated } = w;
  const focusMoved = after.focusChanged;
  const introduced = w.watch ? newIssues(before.hits, after.hits, navigated) : [];
  // Only the app's own requests: a failed analytics beacon is not the app lying.
  const host = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return "";
    }
  };
  const pageHost = host(w.urlAfter);
  const net = w.network.filter((n) => n.seq > w.seqBefore);
  const con = w.console.filter((c) => c.seq > w.seqBefore);
  const ownFailures = net.filter((n) => n.failed && host(n.url) === pageHost).length;
  const newConsoleErrors = con.filter((c) => c.level === "error").length;
  const newNetworkFailures = net.filter((n) => n.failed).length;
  const mutations = after.mutations;
  const nothingChanged = !navigated && mutations === 0 && !focusMoved;
  const interaction = isInteraction(action);
  return {
    urlBefore: w.urlBefore,
    urlAfter: w.urlAfter,
    navigated,
    domNodeDelta: after.nodes - before.nodes,
    newConsoleErrors,
    newNetworkFailures,
    focusMoved,
    ...(mutations >= 0 ? { domMutations: mutations } : {}),
    silentAction: interaction && nothingChanged && net.length === 0 && con.length === 0 && !after.focusEntered,
    unsurfacedFailure: newNetworkFailures > 0 && nothingChanged,
    newHorizontalOverflow: !before.overflow && after.overflow && !navigated,
    ...(introduced.length ? { newLayoutIssues: introduced } : {}),
    failureShownAsSuccess: ownFailures > 0 && !navigated && mutations > 0 && after.errors <= before.errors,
    ...(w.pending ? { pending: w.pending } : {}),
    timings: w.timings,
  };
}
