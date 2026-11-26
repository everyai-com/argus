/**
 * Audit signals — what a page says about itself whether or not a test asked.
 *
 * The cloud smoke/audit engines and the local runner read these the same way,
 * so "console clean" and "no horizontal overflow" mean one thing in a smoke
 * report, a flow predicate and a code-first test.
 */
import type { ConsoleEvent } from "@argus/shared";

export interface ConsoleErrorScan {
  /** Error-level console events that count against the page. */
  errors: ConsoleEvent[];
  /** True when errors from other hosts' scripts were seen and left out. */
  thirdPartySkipped: boolean;
}

/**
 * Error-level console events after `since`. First-party by default: an error
 * emitted by a script on another host (analytics, a captcha widget) isn't the
 * app's bug. Events with no source URL (uncaught exceptions, failed resource
 * loads) always count.
 */
export function firstPartyConsoleErrors(
  events: ConsoleEvent[],
  pageUrl: string,
  opts: { since?: number; includeThirdParty?: boolean } = {}
): ConsoleErrorScan {
  const since = opts.since ?? 0;
  const pageHost = hostOf(pageUrl) ?? "";
  const errors: ConsoleEvent[] = [];
  let thirdPartySkipped = false;
  for (const c of events) {
    if (c.level !== "error" || c.seq <= since) continue;
    if (opts.includeThirdParty || !c.sourceUrl) {
      errors.push(c);
      continue;
    }
    const sourceHost = hostOf(c.sourceUrl);
    if (sourceHost === undefined) {
      errors.push(c); // unparseable source: count it rather than hide it
      continue;
    }
    if (sourceHost === pageHost) errors.push(c);
    else thirdPartySkipped = true;
  }
  return { errors, thirdPartySkipped };
}

/** `URL` is a global in Workers and in Node, but in neither's types here. */
function hostOf(url: string): string | undefined {
  try {
    return new (globalThis as any).URL(url).host as string;
  } catch {
    return undefined;
  }
}

export interface OverflowReading {
  /** The page scrolls sideways: content is wider than the viewport. */
  overflow: boolean;
  scrollWidth: number;
  viewportWidth: number;
  /** Up to 3 elements whose right edge passes the viewport, widest first. */
  offenders: string[];
}

/**
 * Horizontal overflow: `scrollWidth > innerWidth + 1`, the test smoke and audit
 * have always used. On overflow it also names the widest offending elements,
 * because "something is too wide" sends the reader hunting.
 */
export async function readHorizontalOverflow(page: {
  evaluate(fn: any, arg?: any): Promise<any>;
}): Promise<OverflowReading> {
  return (await page.evaluate(() => {
    const w = globalThis as any;
    const doc = w.document;
    const viewportWidth: number = w.innerWidth;
    const scrollWidth: number = doc.documentElement.scrollWidth;
    const overflow = scrollWidth > viewportWidth + 1;
    const offenders: Array<{ label: string; right: number }> = [];
    if (overflow) {
      for (const el of Array.from(doc.body ? doc.body.querySelectorAll("*") : []) as any[]) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.right <= viewportWidth + 1) continue;
        const testid = el.getAttribute("data-testid");
        const id = el.id ? `#${el.id}` : "";
        offenders.push({
          label: `${String(el.tagName).toLowerCase()}${testid ? `[data-testid="${testid}"]` : id} (${Math.round(rect.width)}px wide)`,
          right: rect.right,
        });
      }
      offenders.sort((a, b) => b.right - a.right);
    }
    return { overflow, scrollWidth, viewportWidth, offenders: offenders.slice(0, 3).map((o) => o.label) };
  })) as OverflowReading;
}
