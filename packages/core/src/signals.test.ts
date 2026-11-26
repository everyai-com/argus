import { describe, expect, it } from "vitest";
import type { ConsoleEvent } from "@argus/shared";
import { firstPartyConsoleErrors, readHorizontalOverflow } from "./signals.ts";

const events: ConsoleEvent[] = [
  { seq: 1, level: "log", text: "hello", sourceUrl: "https://app.test/main.js" },
  { seq: 2, level: "error", text: "first-party", sourceUrl: "https://app.test/main.js" },
  { seq: 3, level: "error", text: "widget", sourceUrl: "https://cdn.other.test/widget.js" },
  { seq: 4, level: "error", text: "Uncaught: boom" },
];

describe("console errors", () => {
  it("counts first-party errors and errors with no source, and says what it left out", () => {
    const scan = firstPartyConsoleErrors(events, "https://app.test/checkout");
    expect(scan.errors.map((e) => e.text)).toEqual(["first-party", "Uncaught: boom"]);
    expect(scan.thirdPartySkipped).toBe(true);
  });

  it("counts third-party errors on request", () => {
    const scan = firstPartyConsoleErrors(events, "https://app.test/", { includeThirdParty: true });
    expect(scan.errors).toHaveLength(3);
    expect(scan.thirdPartySkipped).toBe(false);
  });

  it("windows by sequence number", () => {
    const scan = firstPartyConsoleErrors(events, "https://app.test/", { since: 2 });
    expect(scan.errors.map((e) => e.text)).toEqual(["Uncaught: boom"]);
  });
});

describe("horizontal overflow", () => {
  it("returns whatever the page measured", async () => {
    const reading = { overflow: true, scrollWidth: 1600, viewportWidth: 1280, offenders: ["div (1600px wide)"] };
    expect(await readHorizontalOverflow({ evaluate: async () => reading })).toEqual(reading);
  });
});
