import { describe, expect, it } from "vitest";
import { FlowSchema } from "@argus/shared";
import { buildListFlows, chooseRows, findNext, findSearch, gateDecision, pickDiscriminatingValue, probeApp, type ListProbe } from "./preset";

const ROWS = [
  "Acme Corp — Invoice 1041 — Open",
  "Beta LLC — Invoice 1042 — Paid",
  "Acme West — Invoice 1043 — Overdue",
  "Gamma Inc — Invoice 1044 — Open",
];

describe("pickDiscriminatingValue", () => {
  it("returns a value some rows include and some don't", () => {
    const v = pickDiscriminatingValue(ROWS)!;
    expect(v).toBeTruthy();
    const hits = ROWS.filter((r) => r.toLowerCase().includes(v.toLowerCase()));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThan(ROWS.length);
  });

  it("refuses when nothing can split the rows", () => {
    expect(pickDiscriminatingValue(["Same row", "Same row"])).toBeUndefined();
    expect(pickDiscriminatingValue(["only one"])).toBeUndefined();
    expect(pickDiscriminatingValue([])).toBeUndefined();
  });
});

describe("findSearch / findNext", () => {
  it("prefers a testid, else matches the advertised label exactly", () => {
    expect(findSearch([{ tag: "input", name: "Search invoices", testid: "invoice-search" }])).toEqual({ testid: "invoice-search" });
    expect(findSearch([{ tag: "input", name: "Filter by customer" }])).toEqual({
      css: 'input[aria-label="Filter by customer"], input[placeholder="Filter by customer"]',
    });
    expect(findSearch([{ tag: "input", name: "Email" }])).toBeUndefined();
  });

  it("finds a pager only when its whole label says next", () => {
    expect(findNext([{ tag: "button", text: "Next" }])).toEqual({ role: "button", name: "Next" });
    expect(findNext([{ tag: "a", text: "Next steps for your team" }])).toBeUndefined();
  });
});

describe("buildListFlows", () => {
  const list: ListProbe = {
    path: "/invoices",
    item: { css: "tbody tr" },
    rows: ROWS,
    search: { testid: "invoice-search" },
    next: { role: "button", name: "Next" },
  };

  it("emits schema-valid flows that carry no row data beyond the chosen value", () => {
    const { flows, skipped } = buildListFlows({ base: "https://app.test/", list, authProfile: "default" });
    expect(skipped).toEqual([]);
    expect(flows.map((f) => f.name)).toEqual(["list-filter-applies", "list-next-page-advances"]);
    for (const f of flows) {
      expect(FlowSchema.safeParse(f).success).toBe(true);
      expect(f.auth).toBe("default");
      expect(JSON.stringify(f)).not.toContain("Beta LLC");
    }
  });

  it("guards the filter case with a precondition and judges it against the snapshot", () => {
    const filter = buildListFlows({ base: "https://app.test", list }).flows[0]!;
    expect(filter.precondition?.[0]).toMatchObject({ kind: "rows", minCount: 2 });
    expect(filter.steps[0]!.snapshot?.name).toBe("before");
    expect(filter.success[0]).toMatchObject({ kind: "rows", fewerThan: "before" });
  });

  it("skips — never guesses — what the page doesn't offer", () => {
    const bare = buildListFlows({ base: "https://app.test", list: { ...list, search: undefined, next: undefined } });
    expect(bare.flows).toEqual([]);
    expect(bare.skipped).toHaveLength(2);
    const flat = buildListFlows({ base: "https://app.test", list: { ...list, rows: ["Same", "Same"], next: undefined } });
    expect(flat.skipped[0]).toMatch(/no value splits/);
  });
});

describe("chooseRows", () => {
  it("takes the first candidate with two or more non-empty rows", () => {
    const got = chooseRows([
      { anchor: { css: "tbody tr" }, texts: ["only one"] },
      { anchor: { role: "listitem" }, texts: ["  A  ", "", "B"] },
    ]);
    expect(got).toEqual({ item: { role: "listitem" }, rows: ["A", "B"] });
    expect(chooseRows([{ anchor: { css: "tbody tr" }, texts: [] }])).toBeUndefined();
  });
});

describe("gateDecision", () => {
  const ok = { status: "ok", stepsRun: 3 };
  const fail = (evidence: string) => ({ status: "error", stepsRun: 3, decision: { verdict: "success_condition_failed", whatChanged: evidence } });

  it("keeps a case that passed twice", () => {
    expect(gateDecision(ok, ok).keep).toBe("suite");
  });

  it("holds the same failure twice as a candidate, normalising ids/timestamps", () => {
    expect(gateDecision(fail("3 row(s) — row without \"acme\" at 1793944780"), fail("3 row(s) — row without \"acme\" at 1793944999")).keep).toBe("candidate");
  });

  it("drops disagreement and anything untested", () => {
    expect(gateDecision(ok, fail("x")).keep).toBe("drop");
    expect(gateDecision(ok, { status: "error", stepsRun: 0, decision: { verdict: "precondition_unmet" } })).toMatchObject({ keep: "drop", reason: "could not test (precondition_unmet)" });
    expect(gateDecision({ status: "error", stepsRun: 0, decision: { verdict: "fleet_busy" } }, ok).keep).toBe("drop");
  });
});

describe("probeApp", () => {
  it("never reads a browser error page (empty 404) as a redirect to a real route", async () => {
    const errorPage = { url: "chrome-error://chromewebdata/", title: "", texts: ["Reload"] };
    const probe = await probeApp("https://app.test", async (path) =>
      path === "/" ? { url: "https://app.test/", title: "App", texts: ["Home"] } : errorPage
    );
    expect(probe.signin).toBeUndefined();
    expect(probe.signup).toBeUndefined();
    expect(probe.protectedPath).toBeUndefined();
  });
});
