import { describe, expect, it } from "vitest";
import type { Predicate } from "@argus/shared";
import { evalPredicate, levenshtein, nearestMatch, weakestTier } from "./verify";

const buffers = {
  network: [
    { seq: 1, method: "POST", url: "https://x/api/orders", status: 201, failed: false },
  ],
  console: [],
};
// Predicates under test only reach for the page via evaluate (storage/state/signal).
const page = { url: () => "https://x/checkout", evaluate: async () => ({ present: false }) } as any;

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

describe("predicate combinators", () => {
  const order = {
    kind: "network",
    urlIncludes: "/api/orders",
    method: "POST",
    status: 201,
    minCount: 1,
    since: 0,
  } as Predicate;
  const onRoute = { kind: "route", includes: "/checkout" } as Predicate;
  const offRoute = { kind: "route", includes: "/nope" } as Predicate;

  it("allOf passes only when every child passes", async () => {
    const ok = await evalPredicate(page, buffers, { kind: "allOf", predicates: [order, onRoute] });
    expect(ok.pass).toBe(true);
    expect(ok.tier).toBe("consequence");

    const fail = await evalPredicate(page, buffers, {
      kind: "allOf",
      predicates: [order, offRoute],
    });
    expect(fail.pass).toBe(false);
    expect(fail.evidence).toContain("allOf failed");
  });

  it("anyOf passes when one child passes", async () => {
    const ok = await evalPredicate(page, buffers, {
      kind: "anyOf",
      predicates: [offRoute, order],
    });
    expect(ok.pass).toBe(true);

    const fail = await evalPredicate(page, buffers, {
      kind: "anyOf",
      predicates: [offRoute],
    });
    expect(fail.pass).toBe(false);
  });

  it("nests combinators", async () => {
    const nested = await evalPredicate(page, buffers, {
      kind: "allOf",
      predicates: [{ kind: "anyOf", predicates: [offRoute, order] }, onRoute],
    });
    expect(nested.pass).toBe(true);
  });
});

describe("storage predicate", () => {
  const storagePage = (value: string | null) =>
    ({ url: () => "https://x/", evaluate: async () => ({ present: true, value }) }) as any;

  it("matches a stored value and reports consequence tier", async () => {
    const ok = await evalPredicate(storagePage("tok-123"), buffers, {
      kind: "storage",
      area: "local",
      key: "token",
      includes: "tok",
    });
    expect(ok.pass).toBe(true);
    expect(ok.tier).toBe("consequence");
  });

  it("fails when the stored value disagrees", async () => {
    const bad = await evalPredicate(storagePage("tok-123"), buffers, {
      kind: "storage",
      area: "local",
      key: "token",
      equals: "other",
    });
    expect(bad.pass).toBe(false);
  });

  it("treats a blocked read as an honest failure, not a pass", async () => {
    const blocked = { url: () => "https://x/", evaluate: async () => ({ present: false }) } as any;
    const r = await evalPredicate(blocked, buffers, {
      kind: "storage",
      area: "local",
      key: "token",
      exists: true,
    });
    expect(r.pass).toBe(false);
    expect(r.evidence).toContain("could not read");
  });
});
