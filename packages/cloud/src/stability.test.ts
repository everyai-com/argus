import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { freezeScript, isNoiseRequest } from "./stability";
import { detectorFindings } from "./detectors";
import { failureSignature, isUntested, type ReplayOutcome } from "./flows";
import { suiteBlocks } from "./github-app";

describe("deterministic capture", () => {
  it("freezes the clock and seeds randomness identically on every load", () => {
    const run = () => {
      const sandbox = { performance: { now: () => 123.4 }, Date, Math: Object.create(Math) } as Record<string, any>;
      sandbox.globalThis = sandbox;
      runInNewContext(freezeScript(Date.parse("2026-01-02T03:04:05Z")), sandbox);
      return {
        now: sandbox.Date.now(),
        iso: new sandbox.Date().toISOString(),
        perf: [sandbox.performance.now(), sandbox.performance.now()],
        rand: [sandbox.Math.random(), sandbox.Math.random()],
        explicit: new sandbox.Date(0).getTime(),
      };
    };
    const a = run();
    expect(a.now).toBe(Date.parse("2026-01-02T03:04:05Z"));
    expect(a.iso).toBe("2026-01-02T03:04:05.000Z");
    expect(a.perf[0]).toBe(a.perf[1]);
    expect(a.rand[0]).not.toBe(a.rand[1]);
    expect(a.explicit).toBe(0); // explicit dates still construct normally
    expect(run()).toEqual(a);
  });

  it("blocks analytics/ads/chat but never the app or its CDNs", () => {
    expect(isNoiseRequest("https://www.google-analytics.com/g/collect?v=2")).toBe(true);
    expect(isNoiseRequest("https://www.googletagmanager.com/gtm.js?id=X")).toBe(true);
    expect(isNoiseRequest("https://widget.intercom.io/widget/abc")).toBe(true);
    expect(isNoiseRequest("https://app.dev/api/tasks")).toBe(false);
    expect(isNoiseRequest("https://fonts.gstatic.com/s/inter.woff2")).toBe(false);
    expect(isNoiseRequest("https://cdn.jsdelivr.net/npm/x")).toBe(false);
    expect(isNoiseRequest("not a url")).toBe(false);
  });
});

describe("layout & content detectors", () => {
  it("emits one finding per rule per viewport with samples and a consequence", () => {
    let n = 0;
    const out = detectorFindings(
      [
        { rule: "layout/occluded-control", count: 3, samples: ['button "Save" under div.footer'] },
        { rule: "content/raw-value", count: 1, samples: ['"Total: NaN"'] },
      ],
      "mobile",
      () => `f-${++n}`
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ rule: "layout/occluded-control", category: "layout", severity: "major" });
    expect(out[0]!.summary).toBe("An interactive control is covered at its centre point at mobile (3 elements)");
    expect(out[0]!.decision?.nextAction).toContain('button "Save" under div.footer');
    expect(out[1]).toMatchObject({ category: "content", severity: "major" });
  });
});

describe("only a repeated failure counts", () => {
  const fail = (over: Partial<ReplayOutcome> = {}): ReplayOutcome => ({
    flow: "add-task",
    status: "error",
    stepsRun: 3,
    failedStep: 2,
    durationMs: 1,
    decision: { verdict: "expectation_failed", whatChanged: 'text is "42 task(s)"', nextAction: "x" },
    ...over,
  });

  it("agrees on the same failure even when timestamps/ids differ", () => {
    const a = fail({ decision: { verdict: "expectation_failed", whatChanged: "error at 1791946268901", nextAction: "" } });
    const b = fail({ decision: { verdict: "expectation_failed", whatChanged: "error at 1791946271120", nextAction: "" } });
    expect(failureSignature(a)).toBe(failureSignature(b));
  });

  it("disagrees when the evidence differs (a race), the step differs, or the verdict differs", () => {
    const base = failureSignature(fail());
    expect(failureSignature(fail({ decision: { verdict: "expectation_failed", whatChanged: 'text is "2 task(s)"', nextAction: "" } }))).not.toBe(base);
    expect(failureSignature(fail({ failedStep: 1 }))).not.toBe(base);
    expect(failureSignature(fail({ decision: { verdict: "drift", whatChanged: 'text is "42 task(s)"', nextAction: "" } }))).not.toBe(base);
  });

  it("separates 'could not test' from a product failure", () => {
    expect(isUntested(fail({ decision: { verdict: "fleet_busy", whatChanged: "", nextAction: "" } }))).toBe(true);
    expect(isUntested(fail({ stepsRun: 0, failedStep: undefined, decision: { verdict: "error", whatChanged: "net::ERR_NAME_NOT_RESOLVED", nextAction: "" } }))).toBe(true);
    expect(isUntested(fail())).toBe(false);
    expect(isUntested(fail({ stepsRun: 0, failedStep: 0, decision: { verdict: "error", whatChanged: "click failed", nextAction: "" } }))).toBe(false);
  });
});

describe("GitHub check: only deterministic evidence blocks", () => {
  const f = (category: string, severity = "major") => ({ category, severity, summary: "x" });
  it("blocks on deterministic findings, confirmed flow failures, and could-not-test", () => {
    expect(suiteBlocks({ name: "Audit", status: "fail", summary: "", findings: [f("a11y")] })).toBe(true);
    expect(suiteBlocks({ name: "Flows", status: "fail", summary: "" })).toBe(true);
    expect(suiteBlocks({ name: "Smoke", status: "error", summary: "" })).toBe(true);
  });
  it("reports visual/perf-only failures and flaky flows without blocking", () => {
    expect(suiteBlocks({ name: "Audit", status: "fail", summary: "", findings: [f("visual"), f("perf"), f("a11y", "minor")] })).toBe(false);
    expect(suiteBlocks({ name: "Flows", status: "flaky", summary: "" })).toBe(false);
  });
});
