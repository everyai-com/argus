/**
 * Anchors — semantic element addressing, resolved one way everywhere.
 *
 * Ladder: testid → role+name → label → placeholder → text → css. The first
 * rung the anchor carries is the one used; lower rungs are never fallbacks.
 * Verify-or-refuse: an anchor that matches several elements is an error that
 * names its candidates, never `.first()` — a guess would drive the wrong
 * element and bless a false green.
 */
import type { Anchor, AnchorResolution } from "@argus/shared";
import type { AnchorRoot, LocatorLike } from "./page.ts";

export type AnchorVia = AnchorResolution["via"];

/** Resolve an anchor to a locator. Says nothing about how many elements match. */
export function resolveAnchor<L>(root: AnchorRoot<L>, anchor: Anchor): { locator: L; via: AnchorVia } {
  if (anchor.testid) return { locator: root.getByTestId(anchor.testid), via: "testid" };
  if (anchor.role)
    return { locator: root.getByRole(anchor.role, { name: anchor.name }), via: "role" };
  if (anchor.label) return { locator: root.getByLabel(anchor.label), via: "label" };
  if (anchor.placeholder)
    return { locator: root.getByPlaceholder(anchor.placeholder), via: "placeholder" };
  if (anchor.text) return { locator: root.getByText(anchor.text), via: "text" };
  if (anchor.css) return { locator: root.locator(anchor.css), via: "css" };
  throw new Error("empty anchor");
}

/** The rung an anchor resolves through, without touching a page. */
export function anchorVia(anchor: Anchor): AnchorVia {
  if (anchor.testid) return "testid";
  if (anchor.role) return "role";
  if (anchor.label) return "label";
  if (anchor.placeholder) return "placeholder";
  if (anchor.text) return "text";
  if (anchor.css) return "css";
  throw new Error("empty anchor");
}

/** Short human name for an anchor, used in every message that mentions one. */
export function describeAnchor(anchor: Anchor): string {
  if (anchor.testid) return anchor.testid;
  if (anchor.role) return anchor.name ? `${anchor.role}/${anchor.name}` : anchor.role;
  return anchor.label ?? anchor.placeholder ?? anchor.text ?? anchor.css ?? "(empty anchor)";
}

/** Describe up to 5 matched elements so an ambiguous anchor names its candidates. */
export async function describeCandidates(locator: LocatorLike, total: number): Promise<string[]> {
  try {
    const infos = (await locator.evaluateAll((els: any[]) =>
      els.slice(0, 5).map((el) => {
        const text = String(el.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 60);
        const testid = el.getAttribute("data-testid");
        return `${String(el.tagName).toLowerCase()}${testid ? `[data-testid="${testid}"]` : ""}${text ? ` "${text}"` : ""}`;
      })
    )) as string[];
    return total > infos.length ? [...infos, `+${total - infos.length} more`] : infos;
  } catch {
    return [];
  }
}

export interface AmbiguityDecision {
  verdict: "ambiguous_anchor";
  whatChanged: string;
  suggestedFix: string;
  nextAction: string;
}

/**
 * The ambiguity decision — pure so it's unit-testable without a browser.
 * `where` locates the anchor for the reader ("step 2" in a flow, undefined in
 * a code-first test, where the stack already says where).
 */
export function ambiguityDecision(
  where: number | string | undefined,
  from: string,
  via: string,
  count: number,
  candidates: string[]
): AmbiguityDecision {
  const shown = candidates.length ? ` — candidates: ${candidates.join(" · ")}` : "";
  const prefix = where === undefined ? "" : typeof where === "number" ? `step ${where}: ` : `${where}: `;
  return {
    verdict: "ambiguous_anchor",
    whatChanged: `${prefix}anchor "${from}" (via ${via}) matched ${count} elements${shown}`,
    suggestedFix:
      "tighten the anchor until it matches exactly one element — prefer a unique data-testid, else role+name",
    nextAction:
      "disambiguate the anchor in the flow file (or remove the duplicate element from the page) and re-run",
  };
}

/** Every data-testid on the page — the candidate pool for nearest-match hints. */
export async function testidsOnPage(page: { evaluate(fn: any, arg?: any): Promise<any> }): Promise<string[]> {
  return await page
    .evaluate(() =>
      Array.from((globalThis as any).document.querySelectorAll("[data-testid]")).map((el: any) =>
        String(el.getAttribute("data-testid"))
      )
    )
    .catch(() => []);
}

/** Levenshtein distance — powers nearest-match heal proposals. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n]!;
}

/** Closest candidate to `target`, with a 0..1 confidence. */
export function nearestMatch(
  target: string,
  candidates: string[]
): { value: string; confidence: number } | undefined {
  let best: { value: string; confidence: number } | undefined;
  for (const c of candidates) {
    if (c === target) continue;
    const d = levenshtein(target, c);
    const confidence = 1 - d / Math.max(target.length, c.length);
    if (!best || confidence > best.confidence) best = { value: c, confidence };
  }
  return best && best.confidence >= 0.5 ? best : undefined;
}
