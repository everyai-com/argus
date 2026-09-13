/**
 * Shared verification logic: anchor resolution ladder + predicate evaluation.
 * Used identically by the interactive BrowserSession DO and the deterministic
 * flow-replay engine — one truth, two callers.
 */
import type { Page, Locator } from "@cloudflare/playwright";
import type {
  Anchor,
  AnchorResolution,
  ConsoleEvent,
  NetworkEvent,
  Predicate,
  PredicateResult,
  EvidenceTier,
} from "@argus/shared";

/** Resolution ladder: testid → role+name → text → css. */
export function resolveAnchor(
  page: Page,
  anchor: Anchor
): { locator: Locator; via: AnchorResolution["via"] } {
  if (anchor.testid) return { locator: page.getByTestId(anchor.testid), via: "testid" };
  if (anchor.role)
    return {
      locator: page.getByRole(anchor.role as Parameters<Page["getByRole"]>[0], {
        name: anchor.name,
      }),
      via: "role",
    };
  if (anchor.text) return { locator: page.getByText(anchor.text), via: "text" };
  if (anchor.css) return { locator: page.locator(anchor.css), via: "css" };
  throw new Error("empty anchor");
}

export interface EventBuffers {
  network: NetworkEvent[];
  console: ConsoleEvent[];
}

export async function evalPredicate(
  page: Page,
  buffers: EventBuffers,
  p: Predicate
): Promise<PredicateResult> {
  switch (p.kind) {
    case "network": {
      const onUrl = buffers.network.filter(
        (e) =>
          e.seq > p.since &&
          e.url.includes(p.urlIncludes) &&
          (!p.method || e.method === p.method.toUpperCase())
      );
      const matches = onUrl.filter((e) =>
        p.status === undefined ? !e.failed : e.status === p.status
      );
      const countOk =
        matches.length >= p.minCount &&
        (p.maxCount === undefined || matches.length <= p.maxCount);

      // On failure, say what actually happened. "0 matching requests" sends an
      // agent hunting; "saw POST … → 403" points straight at the cause.
      let observed = "";
      if (!countOk && onUrl.length > 0) {
        const seen = onUrl
          .slice(-3)
          .map((e) => `${e.method} ${e.url.split("?")[0]!.slice(-48)} → ${e.failed && !e.status ? "failed" : e.status}`);
        observed = ` — saw: ${seen.join("; ")}`;
      } else if (!countOk) {
        observed = ` — no request to "${p.urlIncludes}" was made at all`;
      }

      return {
        pass: countOk,
        tier: "consequence",
        evidence: `${matches.length} matching request(s) for "${p.urlIncludes}"${
          p.status !== undefined ? ` status=${p.status}` : ""
        } (wanted ≥${p.minCount}${p.maxCount !== undefined ? `, ≤${p.maxCount}` : ""})${observed}`,
      };
    }
    case "console-clean": {
      const pageHost = (() => {
        try {
          return new URL(page.url()).host;
        } catch {
          return "";
        }
      })();
      const errors = buffers.console.filter((c) => {
        if (c.level !== "error" || c.seq <= p.since) return false;
        if (p.includeThirdParty || !c.sourceUrl) return true;
        // First-party only: skip errors emitted by scripts on other hosts
        try {
          return new URL(c.sourceUrl).host === pageHost;
        } catch {
          return true;
        }
      });
      const thirdPartySkipped =
        !p.includeThirdParty &&
        buffers.console.some(
          (c) =>
            c.level === "error" &&
            c.seq > p.since &&
            c.sourceUrl &&
            (() => {
              try {
                return new URL(c.sourceUrl).host !== pageHost;
              } catch {
                return false;
              }
            })()
        );
      return {
        pass: errors.length === 0,
        tier: "consequence",
        evidence:
          errors.length === 0
            ? `no first-party console errors${thirdPartySkipped ? " (third-party noise ignored)" : ""}`
            : `${errors.length} console error(s): ${errors[0]?.text.slice(0, 120)}`,
      };
    }
    case "route": {
      const url = page.url();
      return {
        pass: url.includes(p.includes),
        tier: "consequence",
        evidence: `route is ${url}`,
      };
    }
    case "visible":
    case "hidden": {
      try {
        const { locator, via } = resolveAnchor(page, p.anchor);
        const count = await locator.count();
        const visible = count > 0 && (await locator.first().isVisible());
        const want = p.kind === "visible";
        return {
          pass: visible === want,
          tier: "dom",
          evidence: `anchor via ${via}: ${count} match(es), visible=${visible}`,
        };
      } catch (err) {
        return {
          pass: p.kind === "hidden",
          tier: "dom",
          evidence: `anchor did not resolve (${String(err).slice(0, 80)})`,
        };
      }
    }
    case "text": {
      try {
        const { locator, via } = resolveAnchor(page, p.anchor);
        if ((await locator.count()) === 0)
          return { pass: false, tier: "dom", evidence: `anchor not found via ${via}` };
        const text = (await locator.first().innerText({ timeout: 3_000 })).trim();
        return {
          pass: text.includes(p.includes),
          tier: "dom",
          evidence: `text is "${text.slice(0, 120)}"`,
        };
      } catch (err) {
        return { pass: false, tier: "dom", evidence: String(err).slice(0, 120) };
      }
    }
    case "signal": {
      // Tier-1: read the app's own declarations. Absent SDK is reported as
      // such rather than as a failed assertion — "we couldn't look" and "we
      // looked and it wasn't there" are different verdicts.
      const read = await page
        .evaluate(() => {
          const a = (window as any).__argus;
          return a ? { present: true, signals: a.signals } : { present: false, signals: [] };
        })
        .catch(() => ({ present: false, signals: [] as Array<{ seq: number; name: string }> }));
      if (!read.present) {
        return {
          pass: false,
          tier: "signal",
          evidence:
            "@argus/sdk is not loaded in this page — add the Vite plugin (dev/preview builds) to assert on signals",
        };
      }
      const matches = (read.signals as Array<{ seq: number; name: string }>).filter(
        (s) => s.name === p.name && s.seq > p.since
      );
      const ok =
        matches.length >= p.minCount &&
        (p.maxCount === undefined || matches.length <= p.maxCount);
      return {
        pass: ok,
        tier: "signal",
        evidence: `signal "${p.name}" emitted ${matches.length}× (wanted ≥${p.minCount}${
          p.maxCount !== undefined ? `, ≤${p.maxCount}` : ""
        })`,
      };
    }
    case "state": {
      const read = await page
        .evaluate(
          ({ store, path }: { store: string; path?: string }) => {
            const a = (window as any).__argus;
            if (!a) return { present: false };
            const r = a.readStore(store);
            if (!r.ok) return { present: true, ok: false, error: r.error };
            let value = r.value;
            if (path) {
              for (const part of path.split(".")) {
                if (value == null) break;
                value = (value as Record<string, unknown>)[part];
              }
            }
            return { present: true, ok: true, value };
          },
          { store: p.store, path: p.path }
        )
        .catch(() => ({ present: false }) as { present: boolean });

      if (!("present" in read) || !read.present) {
        return {
          pass: false,
          tier: "consequence",
          evidence: "@argus/sdk is not loaded — add the Vite plugin to assert on store state",
        };
      }
      const r = read as { present: true; ok?: boolean; error?: string; value?: unknown };
      if (r.ok === false) {
        return { pass: false, tier: "consequence", evidence: r.error ?? "store unavailable" };
      }
      const value = r.value;
      const shown = JSON.stringify(value ?? null)?.slice(0, 120);
      if (p.exists !== undefined) {
        const exists = value !== undefined && value !== null;
        return {
          pass: exists === p.exists,
          tier: "consequence",
          evidence: `${p.store}${p.path ? "." + p.path : ""} ${exists ? "exists" : "is absent"} (${shown})`,
        };
      }
      if (p.includes !== undefined) {
        const hay = typeof value === "string" ? value : JSON.stringify(value ?? null);
        return {
          pass: hay.includes(p.includes),
          tier: "consequence",
          evidence: `${p.store}${p.path ? "." + p.path : ""} = ${shown}`,
        };
      }
      return {
        pass: JSON.stringify(value ?? null) === JSON.stringify(p.equals ?? null),
        tier: "consequence",
        evidence: `${p.store}${p.path ? "." + p.path : ""} = ${shown} (wanted ${JSON.stringify(p.equals ?? null)})`,
      };
    }
    case "storage": {
      const read = await page
        .evaluate(
          ({ area, key }: { area: "local" | "session"; key: string }) => {
            try {
              const store = area === "local" ? window.localStorage : window.sessionStorage;
              return { present: true, value: store.getItem(key) as string | null };
            } catch {
              return { present: false, value: null };
            }
          },
          { area: p.area, key: p.key }
        )
        .catch(() => ({ present: false, value: null }) as {
          present: boolean;
          value: string | null;
        });

      if (!read.present) {
        // Blocked storage (privacy mode, sandboxed frame) is "couldn't look",
        // not "the value is wrong" — say which.
        return {
          pass: false,
          tier: "consequence",
          evidence: `could not read ${p.area}Storage["${p.key}"] (blocked or unavailable)`,
        };
      }
      const value = read.value;
      const shown = value === null ? "null" : JSON.stringify(value).slice(0, 120);
      if (p.exists !== undefined) {
        const exists = value !== null;
        return {
          pass: exists === p.exists,
          tier: "consequence",
          evidence: `${p.area}Storage["${p.key}"] ${exists ? "is set" : "is absent"}`,
        };
      }
      if (p.includes !== undefined) {
        return {
          pass: (value ?? "").includes(p.includes),
          tier: "consequence",
          evidence: `${p.area}Storage["${p.key}"] = ${shown}`,
        };
      }
      return {
        pass: (value ?? "") === (p.equals ?? ""),
        tier: "consequence",
        evidence: `${p.area}Storage["${p.key}"] = ${shown} (wanted ${JSON.stringify(p.equals ?? "")})`,
      };
    }
    case "allOf":
    case "anyOf": {
      const results = await Promise.all(
        p.predicates.map((child) => evalPredicate(page, buffers, child))
      );
      const passing = results.filter((r) => r.pass);
      const pass = p.kind === "allOf" ? passing.length === results.length : passing.length > 0;
      // The verdict rests only on the evidence that carried it: every child for
      // allOf, just the passing children for anyOf.
      const basis = pass && p.kind === "anyOf" ? passing : results;
      const failed = results.filter((r) => !r.pass);
      return {
        pass,
        tier: weakestTier(basis),
        evidence: pass
          ? `${p.kind}: ${p.kind === "allOf" ? results.length : passing.length}/${results.length} predicate(s) passed`
          : `${p.kind} failed — ${failed
              .slice(0, 3)
              .map((r) => r.evidence)
              .join(" | ")}`,
      };
    }
  }
}

/** The weakest tier a set of results rests on — honesty about the evidence. */
export function weakestTier(results: PredicateResult[]): EvidenceTier {
  const order: EvidenceTier[] = ["signal", "consequence", "dom", "visual"];
  if (results.length === 0) return "dom";
  return order[Math.max(...results.map((r) => order.indexOf(r.tier)))] ?? "dom";
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
