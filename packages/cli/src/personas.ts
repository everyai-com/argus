/**
 * `argus personas` — five first-time users, one ranked list.
 *
 * The users are agents (your agent CLI, driving Argus over MCP); everything
 * after they report is deterministic: moments are keyed by page + element +
 * symptom, merged across users, ranked by how many users hit them, and each
 * claimed evidence tier is checked against the evidence it cites — a user
 * cannot promote a DOM read to `signal` by saying so.
 */

export type Tier = "signal" | "consequence" | "dom" | "visual";
const TIER_RANK: Record<Tier, number> = { signal: 3, consequence: 2, dom: 1, visual: 0 };
const SEVERITY_RANK: Record<string, number> = { blocker: 2, major: 1, minor: 0 };

export interface Moment {
  kind: string;
  where: string;
  element?: Record<string, string>;
  symptom: string;
  saw?: string;
  severity: string;
  evidence?: { screenshot?: string; tier?: string; effects?: Record<string, unknown> };
}

export interface PersonaReport {
  persona: string;
  reachedSuccess: boolean;
  moments: Moment[];
  coverage?: unknown;
}

export interface RankedIssue {
  key: string;
  symptom: string;
  where: string;
  element: string;
  personas: string[];
  severity: string;
  tier: Tier;
  saw: string[];
  screenshots: string[];
}

/** The symptom vocabulary: same problem, same word — or it can't be counted across users. */
export const SYMPTOMS = [
  "dead-button",
  "button-no-feedback",
  "silent-failure",
  "success-shown-on-failure",
  "data-lost-on-reload",
  "duplicate-submit",
  "no-validation-message",
  "unclear-copy",
  "missing-legal-page",
  "missing-label",
  "layout-overflow",
  "tap-target-too-small",
  "no-loading-state",
  "console-error",
  "lost-input",
  "offline-no-message",
  "silent-input-truncation",
] as const;

/** Words agents reach for instead of the vocabulary. */
const SYNONYMS: Record<string, string> = {
  "internal-text-visible": "unclear-copy",
  "debug-text-visible": "unclear-copy",
  "jargon": "unclear-copy",
  "placeholder-only-label": "missing-label",
  "unlabelled-control": "missing-label",
  "double-submit": "duplicate-submit",
  "lost-input-on-back": "lost-input",
  "no-pending-feedback": "no-loading-state",
  "no-length-limit": "silent-input-truncation",
  "data-not-persisted": "data-lost-on-reload",
};
export const canonicalSymptom = (s: string): string => SYNONYMS[s] ?? s;

export const PERSONAS = [
  {
    id: "impatient",
    lease: { viewport: "desktop" },
    brief:
      "Read headlines and button labels only. Click the first plausible primary control. Wait at most ~3 s for anything. QUIT at the first error or dead end: log it as `stuck` and stop.",
  },
  {
    id: "skeptic",
    lease: { viewport: "desktop" },
    brief:
      "Before entering anything, look for pricing, terms and privacy reachable from the page, and for what it says happens to your data. After success, check every data claim against argus_observe network traffic, and reload twice to confirm your data persists.",
  },
  {
    id: "mobile",
    lease: { viewport: "phone", network: "slow3g" },
    brief:
      "Use only what fits the screen; never zoom. Anything off-screen, overlapping, under 44 px to tap, or with no feedback while waiting is a finding. Read `pending` on every act: `pending.feedback: false` means you waited on an unchanged screen.",
  },
  {
    id: "literal",
    lease: { viewport: "desktop" },
    brief:
      "Follow ONLY what the UI literally says. No idioms, no guessing icons, no shortcuts that are not shown. Ambiguous text, odd plurals, jargon, debug text or unlabelled controls are `confused` moments quoting the exact text. Submit empty first: does the UI explain in plain words?",
  },
  {
    id: "breaker",
    lease: { viewport: "desktop" },
    brief:
      "Attack every input and state change: empty and whitespace submits; 5000-char, emoji/RTL, <script> and SQL-ish junk; double-click submit (click clickCount 2); Enter twice; network offline → submit → network none; reload after saving; back mid-flow. Count POSTs with argus_observe.",
  },
] as const;

export function personaPrompt(p: (typeof PERSONAS)[number], url: string, goal: string): string {
  return [
    `You are the "${p.id}" persona in an Argus launch-QA run: a first-time user. Do NOT read the app's source code.`,
    `URL: ${url}`,
    `Goal (all you know): "${goal}"`,
    `Lease: argus_lease with ${JSON.stringify({ url, ...p.lease, label: `persona-${p.id}` })}. Drive with the argus MCP tools only.`,
    `Behaviour: ${p.brief}`,
    "Read the effects of every act: silentAction, failureShownAsSuccess, newConsoleErrors, newNetworkFailures, newLayoutIssues, newHorizontalOverflow and pending are findings. Screenshot every confused/stuck/annoyed moment before moving on. An act carrying `recovered` with pageReattached:false reset the browser: re-check on a fresh lease before logging data loss.",
    "Evidence tier = the WEAKEST it rests on: signal ONLY with an app-declared signal event; request counts/statuses = consequence; DOM/text/bounds/silentAction = dom; screenshot-only = visual.",
    `symptom must be one of: ${SYMPTOMS.join(", ")} — invent a new kebab slug only if none fits.`,
    "Never fabricate a moment. Always argus_release.",
    'Reply with ONE JSON object and nothing else: {"persona","reachedSuccess","moments":[{"kind":"stuck|confused|annoyed|broken","where":"/path","element":{"testid"|"role"+"name"|"text":"..."},"symptom":"kebab-slug","saw":"...","severity":"blocker|major|minor","evidence":{"screenshot":"<key>","tier":"...","effects":{...}}}],"coverage":"..."}',
  ].join("\n");
}

/** The last top-level JSON object in an agent's output (agents like to talk first). */
export function extractReport(output: string): PersonaReport | undefined {
  for (let end = output.lastIndexOf("}"); end > 0; end = output.lastIndexOf("}", end - 1)) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      const c = output[i];
      if (c === "}") depth++;
      else if (c === "{" && --depth === 0) {
        try {
          const parsed = JSON.parse(output.slice(i, end + 1)) as PersonaReport;
          if (typeof parsed.persona === "string" && Array.isArray(parsed.moments)) return parsed;
        } catch {
          /* not this one */
        }
        break;
      }
    }
  }
  return undefined;
}

/**
 * The tier the cited evidence actually supports — never higher than claimed.
 * `signal` needs an app signal in the effects; request evidence is consequence.
 */
export function checkedTier(m: Moment): Tier {
  const claimed = (m.evidence?.tier as Tier) in TIER_RANK ? (m.evidence!.tier as Tier) : "visual";
  const fx = JSON.stringify(m.evidence?.effects ?? {}).toLowerCase();
  const supported: Tier = /"signal/.test(fx)
    ? "signal"
    : /network|post |get |status|request/.test(fx)
      ? "consequence"
      : Object.keys(m.evidence?.effects ?? {}).length > 0 || m.element
        ? "dom"
        : "visual";
  return TIER_RANK[claimed] <= TIER_RANK[supported] ? claimed : supported;
}

function elementKey(e: Record<string, string> | undefined): string {
  if (!e) return "page";
  return e.testid ?? (e.role ? `${e.role}:${e.name ?? ""}` : (e.text ?? e.css ?? "page"));
}

const pathOf = (where: string) => {
  try {
    return new URL(where, "https://x").pathname.replace(/\/\d+(?=\/|$)/g, "/:id");
  } catch {
    return where;
  }
};

/** Merge every persona's moments into issues, ranked by how many personas hit each. */
export function mergeReports(reports: PersonaReport[]): RankedIssue[] {
  const byKey = new Map<string, RankedIssue>();
  for (const r of reports) {
    for (const m of r.moments) {
      const where = pathOf(m.where);
      const element = elementKey(m.element);
      const symptom = canonicalSymptom(m.symptom);
      const key = `${where}|${element}|${symptom}`;
      const tier = checkedTier(m);
      const issue = byKey.get(key) ?? {
        key,
        symptom,
        where,
        element,
        personas: [],
        severity: m.severity,
        tier,
        saw: [],
        screenshots: [],
      };
      if (!issue.personas.includes(r.persona)) issue.personas.push(r.persona);
      if ((SEVERITY_RANK[m.severity] ?? 0) > (SEVERITY_RANK[issue.severity] ?? 0)) issue.severity = m.severity;
      // The issue is as strong as its STRONGEST independent sighting, each already checked.
      if (TIER_RANK[tier] > TIER_RANK[issue.tier]) issue.tier = tier;
      if (m.saw) issue.saw.push(`${r.persona}: ${m.saw}`);
      if (m.evidence?.screenshot) issue.screenshots.push(m.evidence.screenshot);
      byKey.set(key, issue);
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      b.personas.length - a.personas.length ||
      (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
      TIER_RANK[b.tier] - TIER_RANK[a.tier]
  );
}

export function renderReport(url: string, reports: PersonaReport[], issues: RankedIssue[]): string {
  const ok = reports.filter((r) => r.reachedSuccess).map((r) => r.persona);
  const missing = PERSONAS.map((p) => p.id).filter((id) => !reports.some((r) => r.persona === id));
  return [
    `# Persona launch QA — ${url}`,
    "",
    `Reached first success: **${ok.length}/${PERSONAS.length}** (${ok.join(", ") || "none"})`,
    ...(missing.length ? [`No report (agent failed — coverage partial): ${missing.join(", ")}`] : []),
    "",
    "| # | issue | where | users | severity | tier |",
    "|---|---|---|---|---|---|",
    ...issues.map(
      (i, n) => `| ${n + 1} | ${i.symptom} (${i.element}) | ${i.where} | ${i.personas.length}: ${i.personas.join(", ")} | ${i.severity} | ${i.tier} |`
    ),
    "",
    ...issues.flatMap((i, n) => [`**${n + 1}. ${i.symptom}** — ${i.saw[0] ?? ""}`, ...i.screenshots.slice(0, 3).map((s) => `- ${s}`), ""]),
  ].join("\n");
}
