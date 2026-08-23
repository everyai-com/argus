import { describe, expect, it } from "vitest";
import { levenshtein, nearestMatch, weakestTier } from "./verify";

describe("verification helpers", () => {
  it("computes edit distance deterministically", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "argus")).toBe(5);
    expect(levenshtein("same", "same")).toBe(0);
  });

  it("proposes only confident nearest matches", () => {
    expect(nearestMatch("submit-button", ["cancel-button", "submit-btn"])?.value).toBe(
      "submit-btn"
    );
    expect(nearestMatch("submit-button", ["unrelated", "other"])).toBeUndefined();
  });

  it("reports the weakest evidence used by a verdict", () => {
    expect(
      weakestTier([
        { pass: true, tier: "signal", evidence: "event" },
        { pass: true, tier: "dom", evidence: "text" },
        { pass: true, tier: "consequence", evidence: "request" },
      ])
    ).toBe("dom");
    expect(weakestTier([])).toBe("dom");
  });
});
