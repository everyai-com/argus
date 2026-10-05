/**
 * Judge — the vision decision layer over Argus's deterministic engines.
 *
 * Cloudflare Clef (Jev-API compatible) via the Workers AI binding:
 * full `clef` for vision adjudication where precision matters, `clef-flash`
 * for high-volume text triage where latency matters (~39ms median).
 *
 * Contract with the rest of the system:
 * - Every function returns `undefined` when it cannot judge (no AI binding,
 *   timeout, malformed response, unusable images). Callers treat undefined as
 *   "judge abstained" and keep the deterministic result untouched.
 * - Judgments refine heuristic severities, never predicate verdicts. The raw
 *   deterministic signal (diffRatio, predicate evidence) is always preserved
 *   beside the judgment.
 * - Images are downscaled to a max dimension of 768px before sending: a
 *   desktop screenshot decodes to ~4MB of RGBA, and Clef caps total decoded
 *   images at 8MB — a raw baseline+current pair would exceed it.
 */
import type { Env } from "./env";
// @ts-expect-error — upng-js ships no types; pure-JS PNG codec that runs in workerd
import UPNG from "upng-js";
import {
  type FailureTriage,
  type JudgeBugClass,
  type VisualAdjudication,
} from "@argus/shared";

const CLEF = "@cf/cloudflare/clef";
const CLEF_FLASH = "@cf/cloudflare/clef-flash";

/** A slow model must never hang a run — abstain past this. */
export const JUDGE_TIMEOUT_MS = 12_000;
/**
 * Clef confidence is strict negentropy (observed: top-p 0.61 → 0.32 when torn,
 * top-p 0.81 → 0.53 when decisive), so gates sit lower than LLM intuition.
 * Recalibrate against production traffic as judgments accumulate.
 */
/** Hiding a finding demands near-unanimity: a wrong suppression hides a bug. */
export const NOISE_SUPPRESS_CONFIDENCE = 0.85;
/** Severity refinement: findings stay visible either way, so clear calls apply. */
export const GRADE_APPLY_CONFIDENCE = 0.5;
/** Below this the distribution is near-flat — report inconclusive, not a guess. */
const INCONCLUSIVE_BELOW = 0.35;

/** Max findings graded in one fan-out call (Clef allows 64 questions). */
const MAX_GRADED_FINDINGS = 24;
/** Longest side of a judged image in px (768×480 RGBA ≈ 1.8MB decoded). */
const JUDGE_MAX_DIM = 768;

// ---------------------------------------------------------------------------
// Clef wire I/O (narrow types from the verified Workers AI schemas)
// ---------------------------------------------------------------------------

interface ClefChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

interface ClefScoreAnswer {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
}

interface ClefNoulAnswer {
  type: "noul";
  noul: number;
}

interface ClefResponse {
  answers: Record<string, ClefChoiceAnswer | ClefScoreAnswer | ClefNoulAnswer>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asChoice(v: unknown): ClefChoiceAnswer | undefined {
  if (!isRecord(v) || v["type"] !== "choice") return undefined;
  if (typeof v["choice"] !== "string") return undefined;
  if (typeof v["confidence"] !== "number") return undefined;
  return v as unknown as ClefChoiceAnswer;
}

function asScore(v: unknown): ClefScoreAnswer | undefined {
  if (!isRecord(v) || v["type"] !== "score") return undefined;
  if (typeof v["score"] !== "number") return undefined;
  if (typeof v["confidence"] !== "number") return undefined;
  return v as unknown as ClefScoreAnswer;
}

function asNoul(v: unknown): ClefNoulAnswer | undefined {
  if (!isRecord(v) || v["type"] !== "noul") return undefined;
  if (typeof v["noul"] !== "number") return undefined;
  return v as unknown as ClefNoulAnswer;
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("judge timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

async function clef(
  env: Env,
  binding: typeof CLEF | typeof CLEF_FLASH,
  state: unknown,
  questions: Record<string, unknown>,
  images?: string[]
): Promise<{ res: ClefResponse; latencyMs: number } | undefined> {
  if (!env.AI) return undefined;
  try {
    const t0 = Date.now();
    const raw = await withTimeout(
      env.AI.run(binding, {
        model: binding === CLEF_FLASH ? "clef-flash" : "clef",
        state,
        questions,
        ...(images && images.length > 0 ? { images } : {}),
      }),
      JUDGE_TIMEOUT_MS
    );
    if (!isRecord(raw) || !isRecord(raw["answers"])) return undefined;
    return { res: { answers: raw["answers"] as ClefResponse["answers"] }, latencyMs: Date.now() - t0 };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Image normalization for judged screenshots
// ---------------------------------------------------------------------------

function base64Encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** Nearest-neighbor downscale of RGBA bytes; no-op when already small. */
function downscale(
  rgba: Uint8Array,
  w: number,
  h: number,
  maxDim: number
): { data: Uint8Array; w: number; h: number } {
  const scale = Math.min(1, maxDim / Math.max(w, h));
  if (scale === 1) return { data: rgba, w, h };
  const w2 = Math.max(1, Math.round(w * scale));
  const h2 = Math.max(1, Math.round(h * scale));
  const out = new Uint8Array(w2 * h2 * 4);
  for (let y = 0; y < h2; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / h2));
    for (let x = 0; x < w2; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / w2));
      const src = (sy * w + sx) * 4;
      const dst = (y * w2 + x) * 4;
      out[dst] = rgba[src]!;
      out[dst + 1] = rgba[src + 1]!;
      out[dst + 2] = rgba[src + 2]!;
      out[dst + 3] = rgba[src + 3]!;
    }
  }
  return { data: out, w: w2, h: h2 };
}

/**
 * Normalize a PNG screenshot into a Clef-ready data URL. Returns undefined
 * for undecodable input — callers then judge text-only or abstain.
 */
export function pngToJudgeImage(pngBytes: ArrayBufferLike): string | undefined {
  try {
    const img = UPNG.decode(pngBytes);
    if (!img || img.width < 1 || img.height < 1) return undefined;
    const rgba = new Uint8Array(UPNG.toRGBA8(img)[0] as ArrayBuffer);
    const small = downscale(rgba, img.width, img.height, JUDGE_MAX_DIM);
    const enc = UPNG.encode([small.data.buffer as ArrayBuffer], small.w, small.h, 0) as ArrayBuffer;
    return "data:image/png;base64," + base64Encode(new Uint8Array(enc));
  } catch {
    return undefined;
  }
}

/** Probability-weighted rubric score (0..levels-1) → finding severity. */
export function scoreToSeverity(score: number): "critical" | "major" | "minor" | "info" | "none" {
  if (score < 0.5) return "none";
  if (score < 1.5) return "minor";
  if (score < 2.5) return "major";
  return "critical";
}

// ---------------------------------------------------------------------------
// Visual-diff adjudication — full clef, two screenshots, one call
// ---------------------------------------------------------------------------

const ADJUDICATION_VERDICTS = ["real_regression", "rendering_noise", "content_change"] as const;

export async function adjudicateVisualDiff(
  env: Env,
  input: {
    baselinePng: ArrayBufferLike;
    currentPng: ArrayBufferLike;
    diffRatio: number;
    viewport: string;
    url: string;
  }
): Promise<VisualAdjudication | undefined> {
  // No eyes, no judgment: adjudication without both images would be a guess.
  const before = pngToJudgeImage(input.baselinePng);
  const after = pngToJudgeImage(input.currentPng);
  if (!before || !after) return undefined;

  const out = await clef(
    env,
    CLEF,
    `Visual regression check for ${input.url} at the ${input.viewport} viewport. ` +
      `First image = approved baseline, second image = current render. ` +
      `Pixel diff: ${(input.diffRatio * 100).toFixed(1)}% of pixels changed.`,
    {
      verdict: {
        type: "choice",
        instructions:
          "Compare the baseline (first image) with the current render (second image). " +
          "Is this a real visual regression a human QA engineer would flag?",
        criteria: {
          real_regression:
            "Visible breakage a user would notice: broken layout, missing or overlapping content, unreadable text, wrong colors or components.",
          rendering_noise:
            "Harmless rendering differences only: antialiasing, subpixel or 1px shifts, font smoothing, animation phase. Nothing a user would report.",
          content_change:
            "Same layout and styling, but legitimately different content: different text, data, dates, or images. No breakage.",
        },
      },
      severity: {
        type: "score",
        instructions: "If this is a real regression, how severe is its visible impact on users?",
        criteria: [
          "No visible issue a user would notice",
          "Minor cosmetic flaw, page fully usable",
          "Major visible breakage, hard to use or trust",
          "Critical: page unusable or content destroyed",
        ],
      },
    },
    [before, after]
  );
  if (!out) return undefined;
  const verdict = asChoice(out.res.answers["verdict"]);
  const sev = asScore(out.res.answers["severity"]);
  if (!verdict || !sev) return undefined;
  if (!ADJUDICATION_VERDICTS.includes(verdict.choice as (typeof ADJUDICATION_VERDICTS)[number])) {
    return undefined;
  }
  if (verdict.confidence < INCONCLUSIVE_BELOW) {
    return {
      verdict: "inconclusive",
      confidence: verdict.confidence,
      severity: "none",
      model: "clef",
      latencyMs: out.latencyMs,
    };
  }
  return {
    verdict: verdict.choice as VisualAdjudication["verdict"],
    confidence: verdict.confidence,
    severity: verdict.choice === "rendering_noise" ? "none" : scoreToSeverity(sev.score),
    model: "clef",
    latencyMs: out.latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Failure triage — clef-flash, trace summary + failure screenshot, one call
// ---------------------------------------------------------------------------

const BUG_CLASSES: JudgeBugClass[] = [
  "visual_regression",
  "console_error",
  "dead_button",
  "wrong_state",
  "network_failure",
  "auth_failure",
  "flaky_infra",
  "unknown",
];

const TRIAGE_SEVERITIES = ["critical", "major", "minor", "info"] as const;

export async function triageFlowFailure(
  env: Env,
  input: {
    verdict: string;
    whatChanged: string;
    failedStep?: number;
    stepsRun: number;
    consoleErrors: string[];
    failedRequests: string[];
    screenshotPng?: ArrayBufferLike;
  }
): Promise<FailureTriage | undefined> {
  const shot = input.screenshotPng ? pngToJudgeImage(input.screenshotPng) : undefined;
  const tail = (lines: string[]) => lines.slice(-3).map((l) => l.slice(0, 200));
  const out = await clef(
    env,
    CLEF_FLASH,
    {
      replay_verdict: input.verdict,
      what_changed: input.whatChanged.slice(0, 500),
      failed_step: input.failedStep,
      steps_run: input.stepsRun,
      console_errors: tail(input.consoleErrors),
      failed_requests: tail(input.failedRequests),
      screenshot: shot ? "attached (final page state at failure)" : "none",
    },
    {
      bug_class: {
        type: "choice",
        instructions: "What kind of bug caused this flow replay to fail?",
        criteria: {
          visual_regression: "The page renders broken: wrong layout, missing content, visual breakage.",
          console_error: "A JavaScript error broke the page or its handlers.",
          dead_button: "A click or interaction did nothing — the control is dead or covered.",
          wrong_state: "The app is in the wrong state: stale data, wrong page, auth state mismatch.",
          network_failure: "An API request failed or never fired — backend or wiring issue.",
          auth_failure: "Login expired or the session is invalid — re-authentication needed.",
          flaky_infra: "Environmental flake: timeout, slow load, error — retry would likely pass.",
          unknown: "Cannot determine the cause from this evidence.",
        },
      },
      severity: {
        type: "choice",
        instructions: "How severe is this failure for real users of the app?",
        criteria: {
          critical: "Core journey broken for all users, data loss, or security hole.",
          major: "Important flow broken but a workaround exists.",
          minor: "Edge-case glitch with small user impact.",
          info: "Noise or flake with no meaningful user impact.",
        },
      },
      needs_human: {
        type: "noul",
        instructions:
          "True only if a human should review this failure before acting on it: ambiguous cause, weak evidence, or a risky automatic fix.",
      },
    },
    shot ? [shot] : undefined
  );
  if (!out) return undefined;
  const bug = asChoice(out.res.answers["bug_class"]);
  const sev = asChoice(out.res.answers["severity"]);
  const human = asNoul(out.res.answers["needs_human"]);
  if (!bug || !sev || !human) return undefined;
  if (!BUG_CLASSES.includes(bug.choice as JudgeBugClass)) return undefined;
  if (!TRIAGE_SEVERITIES.includes(sev.choice as (typeof TRIAGE_SEVERITIES)[number])) return undefined;
  return {
    bugClass: bug.choice as JudgeBugClass,
    severity: sev.choice as FailureTriage["severity"],
    needsHuman: human.noul >= 0.5,
    confidence: Math.min(bug.confidence, sev.confidence),
    model: "clef-flash",
    latencyMs: out.latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Finding grading — clef-flash fan-out: every finding graded in ONE call
// ---------------------------------------------------------------------------

export interface FindingGrade {
  severity: "critical" | "major" | "minor" | "info";
  confidence: number;
}

export async function gradeFindings(
  env: Env,
  findings: Array<{ id: string; category: string; summary: string; detail?: string }>
): Promise<{ grades: Record<string, FindingGrade>; model: "clef-flash"; latencyMs: number } | undefined> {
  const batch = findings.slice(0, MAX_GRADED_FINDINGS);
  if (batch.length === 0) return undefined;
  const questions: Record<string, unknown> = {};
  for (let i = 0; i < batch.length; i++) {
    const f = batch[i]!;
    questions[`g${i}`] = {
      type: "score",
      instructions:
        `Rate the user-facing severity of finding "${f.id}" (${f.category}: ${f.summary}). ` +
        `Judge only this finding; ignore the others.`,
      criteria: [
        "Cosmetic or ignorable — no user impact",
        "Minor issue — small user impact",
        "Major breakage — important functionality impaired",
        "Critical — core journey broken, data loss, or outage",
      ],
    };
  }
  const out = await clef(
    env,
    CLEF_FLASH,
    batch.map((f) => ({ id: f.id, category: f.category, summary: f.summary, detail: f.detail?.slice(0, 300) })),
    questions
  );
  if (!out) return undefined;
  const grades: Record<string, FindingGrade> = {};
  for (let i = 0; i < batch.length; i++) {
    const a = asScore(out.res.answers[`g${i}`]);
    if (!a) return undefined;
    const sev = scoreToSeverity(a.score);
    grades[batch[i]!.id] = { severity: sev === "none" ? "info" : sev, confidence: a.confidence };
  }
  return { grades, model: "clef-flash", latencyMs: out.latencyMs };
}
