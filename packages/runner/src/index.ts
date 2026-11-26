/**
 * @argus/runner — code-first tests on a local Chromium.
 *
 *   import { test, expect } from "@argus/runner";
 *
 *   test("adds a task", async ({ page, network }) => {
 *     await page.goto("/");
 *     await page.getByPlaceholder("New task title").fill("Buy milk");
 *     await page.getByRole("button", "Add").click();
 *     await expect(network).toHaveRequest({ method: "POST", url: "/api/tasks", status: 201 });
 *     await expect(page.getByTestId("task-count")).toHaveText("3 task(s)");
 *   });
 *
 * Run with `argus run`. No model, no Argus token, no tunnel.
 */
export { test, describe, beforeEach, afterEach, type TestFn } from "./registry.ts";
export { expect, type ExpectOptions, type PredicateInput, type RequestExpectation } from "./expect.ts";
export { defineConfig, type ArgusConfig, type AppConfig, type BrowserConfig } from "./config.ts";
export {
  Audit,
  Locator,
  Network,
  Page,
  type ActionOptions,
  type AuditGates,
  type Fixtures,
  type RequestMatch,
  type TestOptions,
} from "./api.ts";
export { ArgusTestError, RunnerError, type Decision, type TestVerdict } from "./errors.ts";
export type { Driver, ElementCheck, CheckOutcome, ObservedEvents } from "./driver.ts";
export { run, type RunOptions, type RunResult, type TestResult, type TestFailure } from "./run.ts";
export type { Anchor, Predicate } from "@argus/shared";
