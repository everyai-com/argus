/**
 * Design-craft checks — advisory feedback, never a blocker.
 *
 * Ported to the web from the "slop pre-flight" in Appllama's app design skill
 * (github.com/Appllama/appllama-skills, MIT): the mechanical counts that make
 * an app read as assembled-from-a-template — accent hues, corner radii, emoji
 * in chrome, the AI-default purple gradient, one intent under three labels,
 * font sprawl, and motion that ignores Reduce Motion. Native-only laws (SF
 * Symbols, haptics, Dynamic Island) don't apply to a browser and aren't here.
 *
 * The page is read ONCE (`probeDesign`); the verdict is the pure `judgeDesign`,
 * so every threshold is unit-tested without a browser. Every rule is `minor` or
 * `info`: taste is feedback, and audit only blocks on critical/major.
 *
 * Keep this free of Worker-only imports (types only from @cloudflare/playwright).
 */
import type { Page } from "@cloudflare/playwright";
import type { Finding, ViewportName } from "@argus/shared";

/** Raw measurements from one in-page read. No judgement happens in the page. */
export interface DesignSample {
  /** Computed background-color of each filled call-to-action. */
  ctaColors: string[];
  /** Corner radius in px of each control/card; -1 = pill or circle. */
  radii: number[];
  /** Chrome elements (buttons, nav, tabs, headings) whose label holds an emoji. */
  emojiChrome: string[];
  /** CTAs painted with a gradient: label + the computed background-image. */
  gradientCtas: Array<{ label: string; image: string }>;
  /** Visible action labels (buttons and button-styled links), as shown. */
  labels: string[];
  /** First font family → number of visible text elements using it. */
  fonts: Record<string, number>;
  /** Large elements still animating forever while the page is told to reduce motion. */
  motion: string[];
}

export type DesignRule =
  | "design/accent-sprawl"
  | "design/radius-sprawl"
  | "design/emoji-in-chrome"
  | "design/ai-default-gradient"
  | "design/duplicate-intent-labels"
  | "design/font-sprawl"
  | "design/ignores-reduced-motion";

export interface DesignHit {
  rule: DesignRule;
  count: number;
  samples: string[];
}

/** Read the page once, with prefers-reduced-motion emulated. Best-effort: never throws. */
export async function probeDesign(page: Page): Promise<DesignSample | undefined> {
  await page.emulateMedia({ reducedMotion: "reduce" }).catch(() => {});
  try {
    return await page.evaluate(() => {
      const shown = (el: any) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.01;
      };
      const label = (el: any) =>
        String(el.getAttribute?.("aria-label") || el.innerText || el.value || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 60);
      const describe = (el: any) => {
        const tag = el.tagName.toLowerCase();
        const testid = el.getAttribute?.("data-testid");
        if (testid) return `${tag}[data-testid="${testid}"]`;
        const name = label(el);
        return name ? `${tag} "${name.slice(0, 40)}"` : tag;
      };
      const filled = (cs: any) => {
        const m = String(cs.backgroundColor).match(/rgba?\(([^)]+)\)/);
        if (!m) return false;
        const parts = m[1]!.split(",").map((x: string) => Number(x.trim()));
        return parts.length < 4 || parts[3]! > 0.5;
      };

      const ctas = (Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], a')) as any[])
        .filter(shown)
        .filter((el) => {
          const cs = getComputedStyle(el);
          if (el.tagName === "A" && !filled(cs) && !String(cs.backgroundImage).includes("gradient(")) return false;
          const r = el.getBoundingClientRect();
          return r.width >= 24 && r.height >= 16;
        });

      const ctaColors: string[] = [];
      const gradientCtas: Array<{ label: string; image: string }> = [];
      const labels: string[] = [];
      for (const el of ctas) {
        const cs = getComputedStyle(el);
        if (filled(cs)) ctaColors.push(cs.backgroundColor);
        if (String(cs.backgroundImage).includes("gradient(")) gradientCtas.push({ label: describe(el), image: cs.backgroundImage });
        const l = label(el);
        if (l) labels.push(l);
      }

      const radii: number[] = [];
      const shaped = Array.from(
        document.querySelectorAll('button, [role="button"], input:not([type="hidden"]), select, textarea, img, section, article, li, div')
      ) as any[];
      for (const el of shaped.slice(0, 1500)) {
        const cs = getComputedStyle(el);
        const r = parseFloat(cs.borderTopLeftRadius);
        if (!r || !shown(el)) continue;
        // A div/li counts only when it is drawn as a surface (card), not a layout box.
        const surface = cs.boxShadow !== "none" || parseFloat(cs.borderTopWidth) > 0 || filled(cs);
        if (/^(DIV|LI|SECTION|ARTICLE|IMG)$/.test(el.tagName) && !surface) continue;
        const box = el.getBoundingClientRect();
        radii.push(r >= Math.min(box.width, box.height) / 2 - 1 ? -1 : Math.round(r));
      }

      // © ® ™ are Extended_Pictographic too, but they are typography, not emoji.
      const emoji = /(?![©®™])\p{Extended_Pictographic}/u;
      const emojiChrome = (
        Array.from(
          document.querySelectorAll('button, [role="button"], [role="tab"], [role="menuitem"], nav a, header a, label, th, h1, h2')
        ) as any[]
      )
        .filter((el) => shown(el) && emoji.test(String(el.innerText || "")))
        .map(describe);

      const fonts: Record<string, number> = {};
      const texty = Array.from(document.querySelectorAll("h1, h2, h3, h4, p, a, button, label, li, td, span")) as any[];
      for (const el of texty.slice(0, 1500)) {
        if (!shown(el) || !String(el.innerText || "").trim()) continue;
        const family = String(getComputedStyle(el).fontFamily).split(",")[0]!.replace(/["']/g, "").trim().toLowerCase();
        if (family) fonts[family] = (fonts[family] ?? 0) + 1;
      }

      const motion: string[] = [];
      for (const a of ((document as any).getAnimations?.() ?? []) as any[]) {
        if (a.playState !== "running") continue;
        const forever = a.effect?.getTiming?.().iterations === Infinity;
        const el = a.effect?.target;
        if (!forever || !el || !shown(el)) continue;
        const r = el.getBoundingClientRect();
        // Small spinners are the one motion users need; big looping motion is decoration.
        if (r.width > 48 && r.height > 48 && motion.length < 5) motion.push(describe(el));
      }

      return { ctaColors, radii, emojiChrome, gradientCtas, labels, fonts, motion };
    });
  } catch {
    return undefined;
  } finally {
    await page.emulateMedia({ reducedMotion: null }).catch(() => {});
  }
}

/** rgb()/rgba() → hue (0–360), saturation and lightness (0–1). */
export function toHsl(css: string): { h: number; s: number; l: number } | undefined {
  const m = css.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (!m) return undefined;
  const [r, g, b] = [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
  return { h, s, l };
}

/** Phrasings that are one intent. Two of a group on one screen reads as assembled from parts. */
export const INTENT_GROUPS: string[][] = [
  ["get started", "start now", "begin", "start free", "start for free", "try free", "try it free", "try for free"],
  ["sign up", "create account", "create an account", "register", "join now"],
  ["log in", "login", "sign in"],
  ["contact us", "get in touch", "talk to us", "contact sales", "talk to sales"],
  ["learn more", "read more", "find out more", "see more"],
];

const ICON_OR_MONO = /icon|awesome|symbol|material|mono|code|courier|consolas|menlo/;

/** Decide from a sample. Thresholds are deliberate and named in each finding. */
export function judgeDesign(sample: DesignSample): DesignHit[] {
  const hits: DesignHit[] = [];

  // One accent: hue buckets of 30° over saturated, mid-light CTA fills. Two is
  // brand + destructive red; three is sprawl.
  const buckets = new Map<number, string>();
  for (const c of sample.ctaColors) {
    const hsl = toHsl(c);
    if (!hsl || hsl.s < 0.25 || hsl.l < 0.12 || hsl.l > 0.92) continue;
    const bucket = Math.floor(((hsl.h + 15) % 360) / 30);
    if (!buckets.has(bucket)) buckets.set(bucket, c);
  }
  if (buckets.size >= 3) hits.push({ rule: "design/accent-sprawl", count: buckets.size, samples: [...buckets.values()].slice(0, 4) });

  // Shape lock: a radius scale has a few steps; pills/circles are one shape, not a step.
  const steps = [...new Set(sample.radii.filter((r) => r > 0))].sort((a, b) => a - b);
  if (steps.length > 4) hits.push({ rule: "design/radius-sprawl", count: steps.length, samples: [steps.map((r) => `${r}px`).join(", ")] });

  if (sample.emojiChrome.length > 0) {
    hits.push({ rule: "design/emoji-in-chrome", count: sample.emojiChrome.length, samples: sample.emojiChrome.slice(0, 3) });
  }

  // The model's house style: a purple/indigo gradient on the primary action.
  const purple = sample.gradientCtas.filter((g) =>
    [...g.image.matchAll(/rgba?\([^)]+\)/g)].some((m) => {
      const hsl = toHsl(m[0]);
      return hsl !== undefined && hsl.s >= 0.35 && hsl.h >= 230 && hsl.h <= 290;
    })
  );
  if (purple.length > 0) hits.push({ rule: "design/ai-default-gradient", count: purple.length, samples: purple.slice(0, 3).map((g) => g.label) });

  const shown = new Set(sample.labels.map((l) => l.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim()));
  const mixed = INTENT_GROUPS.map((group) => group.filter((p) => shown.has(p))).filter((used) => used.length >= 2);
  if (mixed.length > 0) {
    hits.push({ rule: "design/duplicate-intent-labels", count: mixed.length, samples: mixed.map((used) => used.map((p) => `"${p}"`).join(" vs ")) });
  }

  // Families carrying real text (≥3 elements); icon and code fonts are tools, not voice.
  const families = Object.entries(sample.fonts).filter(([f, n]) => n >= 3 && !ICON_OR_MONO.test(f));
  if (families.length > 2) hits.push({ rule: "design/font-sprawl", count: families.length, samples: [families.map(([f]) => f).join(", ")] });

  if (sample.motion.length > 0) hits.push({ rule: "design/ignores-reduced-motion", count: sample.motion.length, samples: sample.motion.slice(0, 3) });

  return hits;
}

const META: Record<DesignRule, { severity: Finding["severity"]; what: string; next: string }> = {
  "design/accent-sprawl": {
    severity: "minor",
    what: "primary actions use three or more accent hues — the screen has no single brand colour to follow",
    next: "lock one accent for primary actions and active states; keep red for destructive only",
  },
  "design/radius-sprawl": {
    severity: "info",
    what: "more than four corner radii across controls and cards — shapes read as assembled from parts",
    next: "state a radius scale (e.g. inputs 8, cards 16, actions pill) and map every component onto it",
  },
  "design/emoji-in-chrome": {
    severity: "minor",
    what: "emoji used as icons in buttons, navigation or headings — reads as a template, renders differently per OS",
    next: "replace them with one icon family (an SVG icon set); keep emoji for user content",
  },
  "design/ai-default-gradient": {
    severity: "info",
    what: "a purple/indigo gradient on a call to action — the AI-default look users file under 'template'",
    next: "use a solid fill in the brand accent unless the gradient is part of the brand",
  },
  "design/duplicate-intent-labels": {
    severity: "minor",
    what: "one intent carries several labels on the same screen (e.g. 'Get started' and 'Start now')",
    next: "pick one phrasing per intent and use it everywhere it appears",
  },
  "design/font-sprawl": {
    severity: "info",
    what: "more than two typefaces carry text on this screen — hierarchy should come from size and weight",
    next: "use one family (two at most: display + text) and emphasise with weight",
  },
  "design/ignores-reduced-motion": {
    severity: "minor",
    what: "large elements keep animating forever when the user asks the OS to reduce motion",
    next: "wrap decorative animation in @media (prefers-reduced-motion: no-preference), or stop it when matchMedia says reduce",
  },
};

/** Hits → findings, one per rule per viewport, category `design`. */
export function designFindings(hits: DesignHit[], viewport: ViewportName, fid: () => string): Finding[] {
  return hits.map((h) => {
    const m = META[h.rule];
    const head = m.what.split(" — ")[0]!;
    return {
      id: fid(),
      severity: m.severity,
      category: "design",
      rule: h.rule,
      summary: `${head[0]!.toUpperCase()}${head.slice(1)} at ${viewport}`,
      detail: `e.g. ${h.samples.join("; ")}`,
      evidence: { viewport },
      decision: { whatChanged: m.what, nextAction: `${m.next} — e.g. ${h.samples[0]}` },
    };
  });
}
