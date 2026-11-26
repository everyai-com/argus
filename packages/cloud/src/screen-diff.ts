/**
 * Screen diff — what an action changed on the page, in a form small enough to
 * ride every action response.
 *
 * A snapshot lists the page's visible, meaningful elements (controls, anything
 * with a testid or role, and every element that carries text of its own). Two
 * snapshots diff into added / removed / changed lines plus URL and title
 * changes. Elements are matched by DOM node identity first (so an in-place
 * text or value change reads as "changed", not removed + added), then by
 * equality (a re-rendered or re-navigated but identical element is unchanged),
 * then by testid / accessible name.
 *
 * `collectSnapshot` runs inside the page; everything else is pure and is unit
 * tested without a browser. The value of a password field never leaves the
 * page: such a field reports `[redacted]` once it holds anything.
 */
import { SCREEN_DIFF_LIMITS, type ScreenDiff } from "@argus/shared";

export const REDACTED = "[redacted]";

export interface SnapshotElement {
  /** DOM node identity within one document (an expando, never an attribute). */
  id: number;
  tag: string;
  type?: string; // input type, when not plain text
  role?: string;
  name?: string; // aria-label, label, placeholder, alt or title
  testid?: string;
  text?: string;
  value?: string; // form fields only; `[redacted]` for a password field
  state?: string; // space-separated flags: disabled checked expanded selected pressed invalid open
}

export interface Snapshot {
  /** Identity of the document, so node ids are only compared within one page load. */
  doc: string;
  url: string;
  title: string;
  /** Total DOM node count (the existing `domNodeDelta` signal reads it). */
  nodes: number;
  els: SnapshotElement[];
  /** The page held more elements than `maxEls`. */
  partial: boolean;
}

/**
 * Runs IN THE PAGE (passed to `page.evaluate`), so it must stay self-contained:
 * no imports, no closures over module scope.
 */
export function collectSnapshot(opts: { maxEls: number; maxText: number }): Snapshot {
  const w = window as any;
  if (!w.__argusDoc) w.__argusDoc = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let seq: number = w.__argusSnapSeq ?? 0;
  const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
  const cap = (s: string) => (s.length > opts.maxText ? s.slice(0, opts.maxText - 1) + "…" : s);
  // Elements listed even without text of their own.
  const CONTROL =
    'a[href],button,input,select,textarea,summary,dialog,[role],[data-testid],[aria-live],[contenteditable="true"]';
  // Elements that report their whole text, so their children are not listed again.
  const LABELLED =
    'a[href],button,summary,label,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"]';
  const SKIP = new Set(["script", "style", "noscript", "template", "option", "optgroup", "br", "hr"]);

  const els: SnapshotElement[] = [];
  let partial = false;
  const all: any[] = document.body ? Array.from(document.body.querySelectorAll("*")) : [];
  for (const el of all) {
    const tag = String(el.tagName).toLowerCase();
    if (SKIP.has(tag) || el.ownerSVGElement) continue;
    const isControl = el.matches(CONTROL);
    if (!isControl && el.parentElement && el.parentElement.closest(LABELLED)) continue;

    let own = "";
    for (const n of Array.from(el.childNodes) as any[]) if (n.nodeType === 3) own += n.textContent;
    own = clean(own);
    const alt = tag === "img" ? el.getAttribute("alt") : null;
    if (!isControl && !own && !alt) continue;

    const type = tag === "input" ? String(el.getAttribute("type") || "text").toLowerCase() : undefined;
    if (type === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;

    if (els.length >= opts.maxEls) {
      partial = true;
      break;
    }

    // A password field stays secure for the life of the node, even after a
    // "show password" toggle flips its type to text.
    if (
      tag === "input" &&
      (type === "password" || String(el.getAttribute("autocomplete") || "").toLowerCase().includes("password"))
    ) {
      el.__argusSecure = true;
    }
    const secure = el.__argusSecure === true;

    const isField = tag === "input" || tag === "textarea" || tag === "select";
    const toggle = type === "checkbox" || type === "radio";
    let value: string | undefined;
    if (isField && !toggle) {
      if (secure) value = el.value ? "[redacted]" : "";
      else if (tag === "select") value = cap(clean(el.selectedOptions?.[0]?.textContent ?? el.value));
      else value = cap(String(el.value ?? ""));
    }

    const flags: string[] = [];
    const aria = (k: string) => el.getAttribute("aria-" + k) === "true";
    if (el.disabled === true || aria("disabled")) flags.push("disabled");
    if ((toggle && el.checked === true) || aria("checked")) flags.push("checked");
    if (aria("expanded")) flags.push("expanded");
    if (aria("selected")) flags.push("selected");
    if (aria("pressed")) flags.push("pressed");
    if (aria("invalid")) flags.push("invalid");
    if ((tag === "details" || tag === "dialog") && el.open === true) flags.push("open");

    const name = clean(
      el.getAttribute("aria-label") ||
        (isField ? el.labels?.[0]?.textContent || el.getAttribute("placeholder") : "") ||
        alt ||
        el.getAttribute("title") ||
        ""
    );
    const text = el.matches(LABELLED) ? clean(el.textContent) : own;

    if (el.__argusSnapId === undefined) el.__argusSnapId = ++seq;
    els.push({
      id: el.__argusSnapId,
      tag,
      type: type && type !== "text" ? type : undefined,
      role: el.getAttribute("role") || undefined,
      name: name ? cap(name) : undefined,
      testid: el.getAttribute("data-testid") || undefined,
      text: text ? cap(text) : undefined,
      value,
      state: flags.length ? flags.join(" ") : undefined,
    });
  }
  w.__argusSnapSeq = seq;
  return {
    doc: w.__argusDoc,
    url: String(window.location.href),
    title: String(document.title ?? ""),
    nodes: document.querySelectorAll("*").length,
    els,
    partial,
  };
}

// ---------------------------------------------------------------------------
// Diff — pure
// ---------------------------------------------------------------------------

const quote = (s: string) => JSON.stringify(s);
const quoteValue = (v: string) => (v === REDACTED ? REDACTED : quote(v));

/** `tag[type=… testid=… role=… name="…"]` — who the element is, without its content. */
export function identify(e: SnapshotElement): string {
  const attrs: string[] = [];
  if (e.type) attrs.push(`type=${e.type}`);
  if (e.testid) attrs.push(`testid=${e.testid}`);
  if (e.role) attrs.push(`role=${e.role}`);
  if (e.name) attrs.push(`name=${quote(e.name)}`);
  return e.tag + (attrs.length ? `[${attrs.join(" ")}]` : "");
}

/** One diff line: identity, then text, value and state where the element has them. */
export function describeElement(e: SnapshotElement): string {
  return (
    identify(e) +
    (e.text ? ` ${quote(e.text)}` : "") +
    (e.value !== undefined ? ` value=${quoteValue(e.value)}` : "") +
    (e.state ? ` (${e.state})` : "")
  );
}

function describeChange(prev: SnapshotElement, next: SnapshotElement): string {
  const parts: string[] = [];
  if (identify(prev) !== identify(next)) parts.push(`was ${identify(prev)}`);
  if ((prev.text ?? "") !== (next.text ?? ""))
    parts.push(`text ${quote(prev.text ?? "")} → ${quote(next.text ?? "")}`);
  if ((prev.value ?? "") !== (next.value ?? ""))
    parts.push(`value ${quoteValue(prev.value ?? "")} → ${quoteValue(next.value ?? "")}`);
  if ((prev.state ?? "") !== (next.state ?? "")) {
    const before = new Set((prev.state ?? "").split(" ").filter(Boolean));
    const after = new Set((next.state ?? "").split(" ").filter(Boolean));
    const flips = [
      ...[...after].filter((f) => !before.has(f)).map((f) => `+${f}`),
      ...[...before].filter((f) => !after.has(f)).map((f) => `-${f}`),
    ];
    parts.push(`state ${flips.join(" ")}`);
  }
  // Keep unchanged text as context, so `button "Save": state +disabled` names its button.
  const context = next.text && prev.text === next.text ? ` ${quote(next.text)}` : "";
  return `${identify(next)}${context}: ${parts.join("; ")}`;
}

/** A key that survives a re-render: the testid, else tag + role + accessible name. */
function stableKey(e: SnapshotElement): string | undefined {
  if (e.testid) return `testid:${e.testid}`;
  if (e.name) return `named:${e.tag}|${e.type ?? ""}|${e.role ?? ""}|${e.name}`;
  return undefined;
}

const URGENT_ROLES = new Set(["alert", "alertdialog", "dialog", "status"]);

function clip(line: string): string {
  return line.length > SCREEN_DIFF_LIMITS.line ? line.slice(0, SCREEN_DIFF_LIMITS.line - 1) + "…" : line;
}

export function diffSnapshots(
  prev: Snapshot,
  next: Snapshot,
  perList: number = SCREEN_DIFF_LIMITS.perList
): ScreenDiff {
  const changed: string[] = [];
  let gone: SnapshotElement[] = [];
  let fresh: SnapshotElement[] = [];

  // 1. Same DOM node, within one document: in-place changes.
  if (prev.doc === next.doc) {
    const byId = new Map(prev.els.map((e) => [e.id, e]));
    for (const n of next.els) {
      const p = byId.get(n.id);
      if (!p) {
        fresh.push(n);
        continue;
      }
      byId.delete(n.id);
      if (describeElement(p) !== describeElement(n)) changed.push(describeChange(p, n));
    }
    gone = [...byId.values()];
  } else {
    gone = [...prev.els];
    fresh = [...next.els];
  }

  // 2. An identical element under a new node (re-render, navigation) is unchanged.
  const pool = new Map<string, SnapshotElement[]>();
  for (const p of gone) {
    const key = describeElement(p);
    pool.set(key, [...(pool.get(key) ?? []), p]);
  }
  fresh = fresh.filter((n) => {
    const same = pool.get(describeElement(n));
    if (!same?.length) return true;
    same.pop();
    return false;
  });
  gone = [...pool.values()].flat();

  // 3. Same testid / accessible name, unique on both sides: changed, not swapped.
  const count = (list: SnapshotElement[]) => {
    const m = new Map<string, SnapshotElement[]>();
    for (const e of list) {
      const key = stableKey(e);
      if (key) m.set(key, [...(m.get(key) ?? []), e]);
    }
    return m;
  };
  const goneByKey = count(gone);
  const freshByKey = count(fresh);
  const paired = new Set<SnapshotElement>();
  for (const [key, nexts] of freshByKey) {
    const prevs = goneByKey.get(key);
    if (nexts.length !== 1 || prevs?.length !== 1) continue;
    changed.push(describeChange(prevs[0]!, nexts[0]!));
    paired.add(prevs[0]!).add(nexts[0]!);
  }
  gone = gone.filter((e) => !paired.has(e));
  fresh = fresh.filter((e) => !paired.has(e));

  // Dialogs, alerts and status regions lead, so the per-list limit never hides them.
  const urgentFirst = (list: SnapshotElement[]) => [
    ...list.filter((e) => e.role && URGENT_ROLES.has(e.role)),
    ...list.filter((e) => !(e.role && URGENT_ROLES.has(e.role))),
  ];
  const added = urgentFirst(fresh).map(describeElement);
  const removed = urgentFirst(gone).map(describeElement);

  const diff: ScreenDiff = {
    ...(prev.url !== next.url ? { url: { from: prev.url, to: next.url } } : {}),
    ...(prev.title !== next.title ? { title: { from: prev.title, to: next.title } } : {}),
    added: added.slice(0, perList).map(clip),
    removed: removed.slice(0, perList).map(clip),
    changed: changed.slice(0, perList).map(clip),
  };
  const omitted = {
    added: Math.max(0, added.length - perList),
    removed: Math.max(0, removed.length - perList),
    changed: Math.max(0, changed.length - perList),
  };
  if (omitted.added || omitted.removed || omitted.changed) diff.omitted = omitted;
  if (prev.partial || next.partial) diff.partial = true;
  return diff;
}
