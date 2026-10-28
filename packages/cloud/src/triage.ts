/**
 * Finding identity and triage memory.
 *
 * A finding gets a FINGERPRINT that survives across runs — hash(host, path,
 * rule, subject[, viewport]) with volatile parts (ids, numbers, query strings)
 * normalised away — so the same bug on the next run is the same finding. Per
 * host, R2 keeps what the team decided about each one:
 *
 *  - new          never seen on this host before
 *  - known        seen before and still open (occurrences counted)
 *  - dismissed    a human said "not a bug": kept out of findings AND the
 *                 verdict, listed under `suppressed` — never silently
 *  - regression   it was fixed (or auto-closed) and came back
 *
 * An open finding that a run covering its scope no longer sees gets a clean
 * visit; three clean visits close it as fixed. A human decision is never
 * overwritten by automation.
 *
 * (Model after bugpatrol's fingerprint + triage record, Apache-2.0.)
 */
import type { Finding, ViewportName } from "@argus/shared";
import type { Env } from "./env";

export interface TriageRecord {
  status: "open" | "dismissed" | "fixed";
  rule: string;
  summary: string;
  path: string;
  viewport?: string;
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
  cleanVisits: number;
  reason?: string;
  /** Who last set the status: "argus" (automation) or "human". */
  decidedBy?: "argus" | "human";
}

interface TriageDoc {
  v: 1;
  records: Record<string, TriageRecord>;
}

/** Clean visits (covering runs with no sighting) before an open finding auto-closes. */
export const CLEAN_VISITS_TO_CLOSE = 3;
const MAX_RECORDS = 2_000;

const VIEWPORT_SCOPED = new Set(["layout", "content", "perf", "visual", "responsive"]);

/** Ids, hashes, numbers → placeholders, so `/orders/8812` and `/orders/9917` are one path. */
export function normalizePath(pathname: string): string {
  return (
    pathname
      .split("/")
      .map((seg) =>
        /^\d+$/.test(seg) || /^[0-9a-f]{8,}$/i.test(seg) || /^[0-9a-f-]{20,}$/i.test(seg) ? ":id" : seg
      )
      .join("/") || "/"
  );
}

/** Volatile text → stable text: URLs to host+path, numbers and hex runs collapsed. */
function normalizeText(text: string): string {
  return text
    .replace(/https?:\/\/([^/\s"')]+)([^\s"')?#]*)[^\s"')]*/g, (_m, host: string, path: string) => `${host}${normalizePath(path)}`)
    .replace(/\b[0-9a-f]{8,}\b/gi, "#")
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** A stable rule id for any finding (explicit `rule` wins). */
export function ruleOf(f: Finding): string {
  if (f.rule) return f.rule;
  switch (f.category) {
    case "a11y": {
      const m = /rule ([\w-]+)/.exec(f.detail ?? "");
      return `a11y/${m?.[1] ?? "unknown"}`;
    }
    case "perf":
      return /LCP/.test(f.summary) ? "perf/lcp" : /CLS|shift/i.test(f.summary) ? "perf/cls" : "perf/other";
    case "visual":
      return "visual/diff";
    case "responsive":
      return "responsive/overflow";
    case "console-error":
      return "console/error";
    case "network-failure":
      return "network/failure";
    case "slow-request":
      return "network/slow";
    case "link":
      return "link/broken";
    case "load":
      return "load/failed";
    default:
      return `${f.category}/other`;
  }
}

/** The part of a finding that distinguishes two instances of the same rule. */
function subjectOf(f: Finding, rule: string): string {
  if (rule === "visual/diff") return /at (\w+\/\w+)/.exec(f.summary)?.[1] ?? "";
  if (rule.startsWith("console/") || rule.startsWith("network/")) return normalizeText(f.detail ?? f.summary);
  if (rule === "link/broken") return normalizeText(f.summary.replace(/ → .*$/, ""));
  return ""; // one finding per rule per screen (a11y, layout, content, perf)
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function fingerprintOf(f: Finding, pageUrl: string): Promise<string> {
  const u = new URL(pageUrl);
  const rule = ruleOf(f);
  const viewport = VIEWPORT_SCOPED.has(rule.split("/")[0]!) ? (f.evidence?.viewport ?? "") : "";
  const parts = [u.host, normalizePath(u.pathname), rule, subjectOf(f, rule), viewport];
  return (await sha256Hex(parts.join("\u0000"))).slice(0, 16);
}

function triageKey(tenantId: string, host: string): string {
  return `tenants/${tenantId}/triage/${host.toLowerCase().replace(/[^a-z0-9.:-]/g, "_")}.json`;
}

export function hostKeyOf(hostOrUrl: string): string {
  try {
    return new URL(hostOrUrl).host;
  } catch {
    return hostOrUrl;
  }
}

export async function loadTriage(env: Env, tenantId: string, host: string): Promise<Record<string, TriageRecord>> {
  const obj = await env.ARTIFACTS.get(triageKey(tenantId, host));
  if (!obj) return {};
  const doc = (await obj.json().catch(() => null)) as TriageDoc | null;
  return doc?.records ?? {};
}

/**
 * Read-modify-write with an etag precondition so two runs on the same host
 * can't lose each other's updates (retries on conflict).
 */
async function mutateTriage<T>(
  env: Env,
  tenantId: string,
  host: string,
  fn: (records: Record<string, TriageRecord>) => T
): Promise<T> {
  const key = triageKey(tenantId, host);
  for (let attempt = 0; ; attempt++) {
    const obj = await env.ARTIFACTS.get(key);
    const doc = obj ? (((await obj.json().catch(() => null)) as TriageDoc | null) ?? { v: 1, records: {} }) : { v: 1 as const, records: {} };
    const out = fn(doc.records);
    prune(doc.records);
    const body = JSON.stringify(doc);
    const opts = { httpMetadata: { contentType: "application/json" } };
    const written = obj
      ? await env.ARTIFACTS.put(key, body, { ...opts, onlyIf: { etagMatches: obj.etag } })
      : await env.ARTIFACTS.put(key, body, opts);
    if (written !== null || attempt >= 4) return out;
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
  }
}

function prune(records: Record<string, TriageRecord>): void {
  const ids = Object.keys(records);
  if (ids.length <= MAX_RECORDS) return;
  // Drop closed records first, oldest sighting first; never a human decision.
  const removable = ids
    .filter((id) => records[id]!.status === "fixed")
    .sort((a, b) => records[a]!.lastSeen.localeCompare(records[b]!.lastSeen));
  for (const id of removable.slice(0, ids.length - MAX_RECORDS)) delete records[id];
}

export interface TriageScope {
  pageUrl: string;
  /** Rule families this run actually evaluated (e.g. "a11y", "console", "visual"). */
  ranFamilies: Set<string>;
  viewports: ViewportName[];
}

export interface TriageOutcome {
  findings: Finding[];
  suppressed: Array<{ fingerprint: string; summary: string; reason?: string }>;
  newFindings: number;
  regressions: number;
}

/**
 * Stamp identity on every finding, apply the team's decisions, and update the
 * memory. Triage is additive: if R2 fails, findings pass through unchanged.
 */
export async function applyTriage(env: Env, tenantId: string, findings: Finding[], scope: TriageScope): Promise<TriageOutcome> {
  for (const f of findings) {
    f.rule = ruleOf(f);
    f.fingerprint = await fingerprintOf(f, scope.pageUrl);
  }
  const now = new Date().toISOString();
  const path = normalizePath(new URL(scope.pageUrl).pathname);
  try {
    return await mutateTriage(env, tenantId, new URL(scope.pageUrl).host, (records) => {
      const kept: Finding[] = [];
      const suppressed: TriageOutcome["suppressed"] = [];
      let newFindings = 0;
      let regressions = 0;
      const seen = new Set<string>();
      const stamped = new Map<string, Finding["triage"] | "suppressed">();
      for (const f of findings) {
        const fp = f.fingerprint!;
        if (seen.has(fp)) {
          // Same identity twice in one run (e.g. one console error at two
          // viewports): same decision, counted once.
          const prior = stamped.get(fp);
          if (prior === "suppressed") continue;
          if (prior) f.triage = { ...prior };
          kept.push(f);
          continue;
        }
        seen.add(fp);
        const rec = records[fp];
        if (!rec) {
          records[fp] = {
            status: "open",
            rule: f.rule!,
            summary: f.summary.slice(0, 200),
            path,
            viewport: f.evidence?.viewport,
            firstSeen: now,
            lastSeen: now,
            occurrences: 1,
            cleanVisits: 0,
            decidedBy: "argus",
          };
          f.triage = { state: "new", firstSeen: now, occurrences: 1 };
          stamped.set(fp, f.triage);
          newFindings++;
          kept.push(f);
          continue;
        }
        rec.lastSeen = now;
        rec.occurrences++;
        rec.cleanVisits = 0;
        if (rec.status === "dismissed") {
          stamped.set(fp, "suppressed");
          suppressed.push({ fingerprint: fp, summary: f.summary, reason: rec.reason });
          continue;
        }
        if (rec.status === "fixed") {
          rec.status = "open";
          rec.decidedBy = "argus";
          f.triage = { state: "regression", firstSeen: rec.firstSeen, occurrences: rec.occurrences };
          regressions++;
        } else {
          f.triage = { state: "known", firstSeen: rec.firstSeen, occurrences: rec.occurrences };
        }
        stamped.set(fp, f.triage);
        kept.push(f);
      }
      // Open findings this run looked for and did not see.
      for (const [fp, rec] of Object.entries(records)) {
        if (seen.has(fp) || rec.status !== "open" || rec.path !== path) continue;
        if (!scope.ranFamilies.has(rec.rule.split("/")[0]!)) continue;
        if (rec.viewport && !scope.viewports.includes(rec.viewport as ViewportName)) continue;
        rec.cleanVisits++;
        if (rec.cleanVisits >= CLEAN_VISITS_TO_CLOSE) {
          rec.status = "fixed";
          rec.decidedBy = "argus";
        }
      }
      return { findings: kept, suppressed, newFindings, regressions };
    });
  } catch {
    return { findings, suppressed: [], newFindings: 0, regressions: 0 };
  }
}

/** A human decision on one finding. Returns the updated record, or null if unknown. */
export async function setTriage(
  env: Env,
  tenantId: string,
  host: string,
  fingerprint: string,
  status: "open" | "dismissed",
  reason?: string
): Promise<TriageRecord | null> {
  return await mutateTriage(env, tenantId, host, (records) => {
    const rec = records[fingerprint];
    if (!rec) return null;
    rec.status = status;
    rec.decidedBy = "human";
    rec.cleanVisits = 0;
    if (status === "dismissed") rec.reason = reason;
    else delete rec.reason;
    return { ...rec };
  });
}
