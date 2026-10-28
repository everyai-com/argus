import { describe, expect, it } from "vitest";
import type { Predicate } from "@argus/shared";
import { evalPredicate, levenshtein, nearestMatch, tailUrl, weakestTier, type EventBuffers } from "./verify";

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

  it("shortens request URLs without passing off a cut as the real URL", () => {
    // The live silent500 verdict used to read "saw: POST s://argus-demo…".
    expect(tailUrl("https://argus-demo.everyai-com.workers.dev/api/tasks?fail=1")).toBe(
      "https://argus-demo.everyai-com.workers.dev/api/tasks"
    );
    const long = tailUrl(`https://example.com/${"a".repeat(100)}/api/tasks`);
    expect(long.startsWith("…")).toBe(true);
    expect(long.endsWith("/api/tasks")).toBe(true);
    expect(long.length).toBe(80);
  });

  describe("evidence gaps (ring eviction / DO restart)", () => {
    const gapped: EventBuffers = { ...buffers, lostThrough: { network: 50, console: 50 } };

    it("refuses to call a window clean when its events may be missing", async () => {
      const r = await evalPredicate(page, gapped, { kind: "console-clean", since: 10 } as Predicate);
      expect(r.pass).toBe(false);
      expect(r.evidence).toContain("unverifiable");
      // A cursor past the gap sees everything — clean stands.
      const fresh = await evalPredicate(page, gapped, { kind: "console-clean", since: 60 } as Predicate);
      expect(fresh.pass).toBe(true);
    });

    it("keeps positive evidence but not absence or ceiling claims", async () => {
      const seen = { kind: "network", urlIncludes: "/api/orders", minCount: 1, since: 0 } as Predicate;
      expect((await evalPredicate(page, gapped, seen)).pass).toBe(true);
      const capped = { ...seen, maxCount: 1 } as Predicate;
      expect((await evalPredicate(page, gapped, capped)).pass).toBe(false);
      const missing = { kind: "network", urlIncludes: "/api/never", minCount: 1, since: 0 } as Predicate;
      const r = await evalPredicate(page, gapped, missing);
      expect(r.pass).toBe(false);
      expect(r.evidence).toContain("unverifiable");
    });
  });

  it("fails `hidden` when the anchor cannot be evaluated at all", async () => {
    // e.g. "Execution context was destroyed" mid-navigation — used to read as hidden ✓.
    const broken = {
      ...page,
      getByTestId: () => ({
        count: async () => {
          throw new Error("Execution context was destroyed");
        },
      }),
    } as any;
    const r = await evalPredicate(broken, buffers, { kind: "hidden", anchor: { testid: "modal" } } as Predicate);
    expect(r.pass).toBe(false);
    expect(r.evidence).toContain("could not evaluate");
  });

  it("names what it saw when a network expectation fails", async () => {
    const failed = await evalPredicate(
      page,
      { network: [{ seq: 1, method: "POST", url: "https://x/api/orders?retry=1", status: 500, failed: false }], console: [] },
      { kind: "network", urlIncludes: "/api/orders", method: "POST", status: 201, minCount: 1, since: 0 } as Predicate
    );
    expect(failed.pass).toBe(false);
    expect(failed.evidence).toContain("saw: POST https://x/api/orders → 500");
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

describe("stream predicate", () => {
  const withStream: EventBuffers = {
    ...buffers,
    stream: [
      {
        seq: 2,
        stream: "websocket",
        url: "wss://x/socket",
        direction: "received",
        data: '{"ok":true}',
        at: 1,
      },
      { seq: 3, stream: "sse", url: "https://x/events", direction: "open", at: 2 },
    ],
  };

  it("matches a WebSocket frame including its payload", async () => {
    const r = await evalPredicate(page, withStream, {
      kind: "stream",
      urlIncludes: "wss://x/socket",
      direction: "received",
      dataIncludes: '"ok"',
      minCount: 1,
      since: 0,
      cumulative: false,
    });
    expect(r.pass).toBe(true);
    expect(r.tier).toBe("consequence");
  });

  it("enforces cardinality and says what it saw on failure", async () => {
    const r = await evalPredicate(page, withStream, {
      kind: "stream",
      urlIncludes: "wss://x/socket",
      direction: "sent",
      minCount: 1,
      since: 0,
      cumulative: false,
    });
    expect(r.pass).toBe(false);
    expect(r.evidence).toContain("stream event(s)");
  });

  it("does not crash when a session never observed a stream", async () => {
    const r = await evalPredicate(page, buffers, {
      kind: "stream",
      urlIncludes: "/socket",
      minCount: 1,
      since: 0,
      cumulative: false,
    });
    expect(r.pass).toBe(false);
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
