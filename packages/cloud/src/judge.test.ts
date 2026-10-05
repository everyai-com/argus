import { describe, expect, it, vi } from "vitest";
// @ts-expect-error — upng-js ships no types
import UPNG from "upng-js";
import type { Env } from "./env";
import {
  adjudicateVisualDiff,
  gradeFindings,
  pngToJudgeImage,
  scoreToSeverity,
  triageFlowFailure,
  withTimeout,
} from "./judge";

function mockEnv(run: (model: string, input: Record<string, unknown>) => unknown) {
  const AI = { run: vi.fn(run) };
  return { env: { AI } as unknown as Env, AI };
}

function testPng(w = 16, h = 16, fill = 255): ArrayBuffer {
  const rgba = new Uint8Array(w * h * 4).fill(fill);
  return UPNG.encode([rgba.buffer as ArrayBuffer], w, h, 0) as ArrayBuffer;
}

const choice = (c: string, confidence: number) => ({
  type: "choice",
  choice: c,
  probabilities: { [c]: confidence },
  confidence,
});
const score = (s: number, confidence: number) => ({
  type: "score",
  score: s,
  legend: {},
  probabilities: {},
  confidence,
});
const noul = (n: number) => ({ type: "noul", noul: n });

describe("scoreToSeverity", () => {
  it("maps rubric boundaries", () => {
    expect(scoreToSeverity(0)).toBe("none");
    expect(scoreToSeverity(0.49)).toBe("none");
    expect(scoreToSeverity(0.5)).toBe("minor");
    expect(scoreToSeverity(1.49)).toBe("minor");
    expect(scoreToSeverity(1.5)).toBe("major");
    expect(scoreToSeverity(2.49)).toBe("major");
    expect(scoreToSeverity(2.5)).toBe("critical");
    expect(scoreToSeverity(3)).toBe("critical");
  });
});

describe("withTimeout", () => {
  it("resolves fast promises", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
  });
  it("rejects slow promises", async () => {
    await expect(withTimeout(new Promise(() => {}), 10)).rejects.toThrow("judge timeout");
  });
});

describe("pngToJudgeImage", () => {
  it("encodes a small PNG as a data URL", () => {
    const url = pngToJudgeImage(testPng());
    expect(url).toMatch(/^data:image\/png;base64,/);
  });
  it("downscales large screenshots to the judge budget", () => {
    const url = pngToJudgeImage(testPng(1600, 1000))!;
    expect(url).toMatch(/^data:image\/png;base64,/);
    const bytes = Buffer.from(url.split(",")[1]!, "base64");
    const img = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(img.width).toBeLessThanOrEqual(768);
    expect(img.height).toBeLessThanOrEqual(768);
  });
  it("returns undefined for undecodable input", () => {
    expect(pngToJudgeImage(new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer)).toBeUndefined();
  });
});

describe("adjudicateVisualDiff", () => {
  const input = () => ({
    baselinePng: testPng(32, 32, 255),
    currentPng: testPng(32, 32, 0),
    diffRatio: 0.42,
    viewport: "desktop",
    url: "https://app.example.com/",
  });

  it("adjudicates a real regression on full clef with both images", async () => {
    const { env, AI } = mockEnv(async () => ({
      answers: { verdict: choice("real_regression", 0.92), severity: score(2.2, 0.88) },
    }));
    const j = await adjudicateVisualDiff(env, input());
    expect(j?.verdict).toBe("real_regression");
    expect(j?.severity).toBe("major");
    expect(j?.confidence).toBe(0.92);
    expect(j?.model).toBe("clef");
    expect(j?.latencyMs).toEqual(expect.any(Number));
    const [model, body] = AI.run.mock.calls[0] as [string, Record<string, unknown>];
    expect(model).toBe("@cf/cloudflare/clef");
    expect((body["images"] as string[]).length).toBe(2);
    expect(body["state"]).toContain("https://app.example.com/");
  });

  it("maps rendering noise to severity none", async () => {
    const { env } = mockEnv(async () => ({
      answers: { verdict: choice("rendering_noise", 0.95), severity: score(0.1, 0.9) },
    }));
    const j = await adjudicateVisualDiff(env, input());
    expect(j?.verdict).toBe("rendering_noise");
    expect(j?.severity).toBe("none");
  });

  it("reports inconclusive instead of guessing below confidence", async () => {
    const { env } = mockEnv(async () => ({
      answers: { verdict: choice("real_regression", 0.3), severity: score(2.9, 0.3) },
    }));
    const j = await adjudicateVisualDiff(env, input());
    expect(j?.verdict).toBe("inconclusive");
  });

  it("reports decisive-but-moderate verdicts with their confidence", async () => {
    const { env } = mockEnv(async () => ({
      answers: { verdict: choice("content_change", 0.53), severity: score(0.8, 0.5) },
    }));
    const j = await adjudicateVisualDiff(env, input());
    expect(j?.verdict).toBe("content_change");
    expect(j?.confidence).toBe(0.53);
  });

  it("abstains on unknown verdicts, malformed responses, and AI failures", async () => {
    const bad = testPng();
    const cases: Array<Record<string, unknown>> = [
      {},
      { AI: undefined },
      { AI: { run: async () => { throw new Error("boom"); } } },
      { AI: { run: async () => ({ nope: true }) } },
      { AI: { run: async () => ({ answers: { verdict: choice("exploded", 0.99) } }) } },
      { AI: { run: async () => ({ answers: { verdict: choice("real_regression", 0.9) } }) } },
    ];
    for (const c of cases) {
      await expect(adjudicateVisualDiff(c as unknown as Env, input())).resolves.toBeUndefined();
    }
    // Unusable images: no eyes, no judgment.
    const { env, AI } = mockEnv(async () => ({
      answers: { verdict: choice("real_regression", 0.9), severity: score(2, 0.9) },
    }));
    await expect(
      adjudicateVisualDiff(env, { ...input(), currentPng: bad.slice(0, 4) })
    ).resolves.toBeUndefined();
    expect(AI.run).not.toHaveBeenCalled();
  });
});

describe("triageFlowFailure", () => {
  const input = () => ({
    verdict: "expectation_failed",
    whatChanged: "step 2: 0 matching request(s) for \"/api/checkout\"",
    failedStep: 2,
    stepsRun: 3,
    consoleErrors: ["Uncaught TypeError: Cannot read properties of null"],
    failedRequests: ["POST https://app.example.com/api/checkout → 500"],
    screenshotPng: testPng(),
  });

  it("triages on clef-flash with class, severity, and needs-human", async () => {
    const { env, AI } = mockEnv(async () => ({
      answers: {
        bug_class: choice("network_failure", 0.8),
        severity: choice("major", 0.75),
        needs_human: noul(0.9),
      },
    }));
    const t = await triageFlowFailure(env, input());
    expect(t?.bugClass).toBe("network_failure");
    expect(t?.severity).toBe("major");
    expect(t?.needsHuman).toBe(true);
    expect(t?.confidence).toBe(0.75);
    expect(t?.model).toBe("clef-flash");
    const model = AI.run.mock.calls[0]?.[0];
    expect(model).toBe("@cf/cloudflare/clef-flash");
  });

  it("judges text-only when no screenshot is available", async () => {
    const { env, AI } = mockEnv(async () => ({
      answers: {
        bug_class: choice("flaky_infra", 0.7),
        severity: choice("info", 0.7),
        needs_human: noul(0.1),
      },
    }));
    const { screenshotPng: _shot, ...rest } = input();
    void _shot;
    const t = await triageFlowFailure(env, rest);
    expect(t?.bugClass).toBe("flaky_infra");
    expect(t?.needsHuman).toBe(false);
    const [, body] = AI.run.mock.calls[0] as [string, Record<string, unknown>];
    expect(body["images"]).toBeUndefined();
  });

  it("abstains on invalid classes and AI failures", async () => {
    const { env } = mockEnv(async () => ({
      answers: {
        bug_class: choice("gremlins", 0.99),
        severity: choice("major", 0.9),
        needs_human: noul(0.1),
      },
    }));
    await expect(triageFlowFailure(env, input())).resolves.toBeUndefined();
    await expect(triageFlowFailure({} as unknown as Env, input())).resolves.toBeUndefined();
  });
});

describe("gradeFindings", () => {
  const findings = [
    { id: "f-1", category: "console-error", summary: "Console error: null ref", detail: "TypeError" },
    { id: "f-2", category: "network-failure", summary: "Failed request: favicon 404" },
  ];

  it("grades a batch in one flash call", async () => {
    const { env, AI } = mockEnv(async () => ({
      answers: { g0: score(2.6, 0.9), g1: score(0.2, 0.95) },
    }));
    const out = await gradeFindings(env, findings);
    expect(out?.model).toBe("clef-flash");
    expect(out?.grades["f-1"]).toEqual({ severity: "critical", confidence: 0.9 });
    expect(out?.grades["f-2"]).toEqual({ severity: "info", confidence: 0.95 });
    expect(AI.run).toHaveBeenCalledTimes(1);
    const model = AI.run.mock.calls[0]?.[0];
    expect(model).toBe("@cf/cloudflare/clef-flash");
  });

  it("returns undefined for empty batches and malformed answers", async () => {
    const { env } = mockEnv(async () => ({ answers: { g0: score(1, 0.8) } }));
    await expect(gradeFindings(env, [])).resolves.toBeUndefined();
    await expect(gradeFindings(env, findings)).resolves.toBeUndefined();
    await expect(gradeFindings({} as unknown as Env, findings)).resolves.toBeUndefined();
  });
});
