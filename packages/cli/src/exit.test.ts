import { describe, expect, it } from "vitest";
import { EXIT, exitCodeFor, exitCodeForApiStatus } from "./exit";

describe("exit codes", () => {
  it("only a confirmed regression exits 1", () => {
    expect(exitCodeFor(["pass", "skipped"])).toBe(EXIT.pass);
    expect(exitCodeFor(["pass", "fail", "untested"])).toBe(EXIT.regression);
    expect(exitCodeFor(["pass", "error"])).toBe(EXIT.untested);
    expect(exitCodeFor(["untested"])).toBe(EXIT.untested);
  });
  it("flaky warns but passes unless strict", () => {
    expect(exitCodeFor(["pass", "flaky"])).toBe(EXIT.pass);
    expect(exitCodeFor(["pass", "flaky"], true)).toBe(EXIT.regression);
    expect(exitCodeFor(["flaky", "error"])).toBe(EXIT.untested);
  });
  it("capacity refusals and server errors mean 'could not test'", () => {
    expect(exitCodeForApiStatus(429)).toBe(EXIT.untested);
    expect(exitCodeForApiStatus(503)).toBe(EXIT.untested);
    expect(exitCodeForApiStatus(400)).toBe(EXIT.regression);
  });
});
