/**
 * Per-flow failure detail for `verify`, `test --local` and `gate`.
 *
 * A bare "1 passed, 2 failed" tells a CI reader nothing. For every flow that
 * did not pass this names the flow, the step (or the success condition) that
 * failed, what the flow file expected there, what Argus actually observed, and
 * the evidence the API returned (run id + final-state screenshot).
 *
 * Pure: the caller prints the lines. Everything is read defensively — the
 * deployed Worker may be newer or older than this CLI, so no field is assumed.
 */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const clip = (s: string, max = 300): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** `[testid=add-task]`, `[role=button "Add"]`, … — the anchor as the flow file wrote it. */
export function describeAnchor(anchor: unknown): string {
  if (!isObj(anchor)) return "";
  if (str(anchor.testid)) return `[testid=${anchor.testid}]`;
  if (str(anchor.role)) return `[role=${anchor.role}${str(anchor.name) ? ` "${anchor.name}"` : ""}]`;
  if (str(anchor.text)) return `[text="${anchor.text}"]`;
  if (str(anchor.css)) return `[css=${anchor.css}]`;
  return "";
}

/** One predicate as a short human sentence; unknown kinds fall back to their JSON. */
export function describePredicate(p: unknown): string {
  if (!isObj(p)) return String(p);
  const anchor = describeAnchor(p.anchor);
  switch (p.kind) {
    case "network": {
      const min = num(p.minCount) ?? 1;
      const max = num(p.maxCount);
      const count = max === undefined ? `≥${min}` : max === min ? `exactly ${min}` : `${min}–${max}`;
      const status = num(p.status) === undefined ? "" : ` → ${p.status}`;
      return `${count} × ${str(p.method) ?? "request"} ${str(p.urlIncludes) ?? ""}${status}`;
    }
    case "console-clean":
      return "no console errors";
    case "route":
      return `route includes "${String(p.includes)}"`;
    case "visible":
      return `${anchor} is visible`;
    case "hidden":
      return `${anchor} is hidden`;
    case "text":
      return `${anchor} text includes "${String(p.includes)}"`;
    case "allOf":
    case "anyOf":
      return `${p.kind}(${arr(p.predicates).map(describePredicate).join(p.kind === "allOf" ? " AND " : " OR ")})`;
    default:
      return clip(JSON.stringify(p), 200);
  }
}

function describeAction(step: unknown): string {
  if (!isObj(step) || !isObj(step.action)) return "";
  const a = step.action;
  const arg = str(a.value) ?? str(a.key) ?? str(a.url) ?? (num(a.ms) === undefined ? undefined : `${a.ms}ms`);
  const anchor = describeAnchor(step.anchor);
  return [str(a.action) ?? "?", arg === undefined ? "" : JSON.stringify(arg), anchor ? `on ${anchor}` : ""]
    .filter(Boolean)
    .join(" ");
}

export interface FlowFailureOptions {
  /** API origin — turns a screenshot key into a fetchable (token-gated) URL. */
  api?: string;
  /** Run id of the suite the results belong to. */
  runId?: string;
}

/**
 * Lines describing every non-passing flow in a `/v1/flows/verify` response.
 * `flows` are the flow files that were sent (for the "expected" side); a
 * result with no matching file still prints everything the API returned.
 */
export function formatFlowFailures(results: unknown, flows: unknown[], opts: FlowFailureOptions = {}): string[] {
  const lines: string[] = [];
  const byName = new Map<string, Obj>();
  for (const f of flows) if (isObj(f) && str(f.name)) byName.set(f.name as string, f);

  for (const r of arr(results)) {
    if (!isObj(r) || r.status === "ok") continue;
    const name = str(r.flow) ?? "(unnamed flow)";
    const flow = byName.get(name);
    const steps = arr(flow?.steps);
    const decision = isObj(r.decision) ? r.decision : {};
    const verdict = str(decision.verdict) ?? str(r.status) ?? "error";
    const failedStep = num(r.failedStep);

    lines.push(`✘ ${name} — ${verdict}`);

    let expected: string[] = [];
    if (failedStep !== undefined) {
      const step = steps[failedStep];
      const action = describeAction(step);
      const total = steps.length ? ` of ${steps.length}` : "";
      // Steps are 0-indexed everywhere in Argus (API, flow files) — keep that.
      lines.push(`    failed at: step ${failedStep}${total}${action ? ` — ${action}` : ""}`);
      if (verdict === "expectation_failed" && isObj(step)) expected = arr(step.expect).map(describePredicate);
      else if (action) expected = [`${action} succeeds`];
    } else if (verdict === "success_condition_failed") {
      const ran = num(r.stepsRun);
      lines.push(`    failed at: success condition${ran === undefined ? "" : ` (all ${ran} steps ran)`}`);
      expected = arr(flow?.success).map(describePredicate);
    } else {
      const ran = num(r.stepsRun);
      lines.push(`    failed at: before any step${ran ? ` (${ran} steps ran)` : ""}`);
    }

    if (expected.length) lines.push(`    expected:  ${clip(expected.join("; "))}`);
    lines.push(`    actual:    ${clip(str(decision.whatChanged) ?? `status ${String(r.status)}, no detail returned`)}`);
    if (str(decision.suggestedFix)) lines.push(`    fix:       ${clip(decision.suggestedFix as string)}`);
    if (str(decision.nextAction)) lines.push(`    next:      ${clip(decision.nextAction as string)}`);

    const evidence: string[] = [];
    if (opts.runId) evidence.push(`run ${opts.runId}`);
    if (str(r.evidenceTier)) evidence.push(`tier ${r.evidenceTier}`);
    const key = str(r.screenshotKey);
    if (key) evidence.push(`screenshot ${opts.api ? `${opts.api}/v1/artifact/${key}` : key}`);
    if (evidence.length) lines.push(`    evidence:  ${evidence.join(" · ")}`);

    if (isObj(r.triage)) {
      const t = r.triage;
      lines.push(
        `    triage:    ${String(t.bugClass)} · ${String(t.severity)}${t.needsHuman ? " · needs human" : ""}` +
          `${num(t.confidence) === undefined ? "" : ` · confidence ${t.confidence}`}`
      );
    }
  }
  return lines;
}
