/**
 * argus doctor — pure, unit-testable helpers for the one-command health check.
 *
 * The `doctor` CLI case wires these up with live API calls; everything in
 * here stays dependency-free so it runs identically offline and in tests.
 */

export interface FlowIssue {
  file: string;
  issue: string;
}

/** Step actions that must carry a semantic anchor (testid/role/text/css). */
const ANCHORED_ACTIONS = new Set(["fill", "click", "press", "hover", "select"]);

/** Predicate kinds that must carry a semantic anchor. */
const ANCHORED_PREDICATES = new Set(["visible", "hidden", "text"]);

function hasAnchor(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const anchor = value as Record<string, unknown>;
  return (
    (typeof anchor.testid === "string" && anchor.testid.length > 0) ||
    (typeof anchor.role === "string" && anchor.role.length > 0) ||
    (typeof anchor.text === "string" && anchor.text.length > 0) ||
    (typeof anchor.css === "string" && anchor.css.length > 0)
  );
}

/**
 * Structural validation of one parsed flow file. Returns the issues found;
 * an empty array means the flow is well-formed. (Deep schema validation
 * stays in @argus/shared on the server; this catches the mistakes worth
 * catching before a cloud round-trip.)
 */
export function validateFlowFile(file: string, raw: unknown): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const bad = (issue: string): void => {
    issues.push({ file, issue });
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    bad("not a JSON object");
    return issues;
  }
  const flow = raw as Record<string, unknown>;
  if (typeof flow.name !== "string" || flow.name.length === 0) bad('missing string "name"');
  if (typeof flow.startUrl !== "string" || flow.startUrl.length === 0) {
    bad('missing string "startUrl"');
  }
  if (!Array.isArray(flow.steps)) {
    bad('missing array "steps"');
  } else {
    flow.steps.forEach((step, i) => {
      if (!step || typeof step !== "object") {
        bad(`steps[${i}]: not an object`);
        return;
      }
      const action = (step as Record<string, unknown>).action as Record<string, unknown> | undefined;
      const actionName = typeof action?.action === "string" ? action.action : undefined;
      if (!actionName) {
        bad(`steps[${i}]: missing action.action`);
        return;
      }
      if (ANCHORED_ACTIONS.has(actionName) && !hasAnchor((step as Record<string, unknown>).anchor)) {
        bad(`steps[${i}]: "${actionName}" needs a semantic anchor (testid/role/text/css)`);
      }
    });
  }
  if (!Array.isArray(flow.success) || flow.success.length === 0) {
    bad('missing non-empty array "success"');
  } else {
    flow.success.forEach((predicate, i) => {
      if (!predicate || typeof predicate !== "object") {
        bad(`success[${i}]: not an object`);
        return;
      }
      const kind = (predicate as Record<string, unknown>).kind;
      if (typeof kind !== "string" || kind.length === 0) {
        bad(`success[${i}]: missing predicate kind`);
        return;
      }
      if (ANCHORED_PREDICATES.has(kind) && !hasAnchor((predicate as Record<string, unknown>).anchor)) {
        bad(`success[${i}]: "${kind}" needs a semantic anchor (testid/role/text/css)`);
      }
    });
  }
  return issues;
}

function numericParts(version: string): number[] | undefined {
  const cleaned = version.replace(/^[~^>=<\s]+/, "").split("-")[0]!;
  if (!cleaned) return undefined;
  const parts = cleaned.split(".").map((p) => Number(p));
  if (parts.length === 0 || parts.some((p) => !Number.isInteger(p) || p < 0)) return undefined;
  return parts;
}

/**
 * Compare a pinned range (e.g. "^5.20261003.1") against a registry version.
 * "current" covers equal-or-newer; anything unparseable is "unknown".
 */
export function compareVersions(pinned: string, latest: string): "current" | "behind" | "unknown" {
  const have = numericParts(pinned);
  const want = numericParts(latest);
  if (!have || !want) return "unknown";
  const width = Math.max(have.length, want.length);
  for (let i = 0; i < width; i++) {
    const h = have[i] ?? 0;
    const w = want[i] ?? 0;
    if (h < w) return "behind";
    if (h > w) return "current";
  }
  return "current";
}

/** Latest published version from the npm registry; undefined when unreachable. */
export async function npmLatest(pkg: string, timeoutMs = 5000): Promise<string | undefined> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === "string" ? data.version : undefined;
  } catch {
    return undefined;
  }
}
