/**
 * Negative controls. Each title starts with the verdict the test MUST fail
 * with — a runner that lets any of these pass is reporting false greens.
 */
import { expect, test } from "../../src/index.ts";

test("[console_error] a page that throws fails a test whose assertions all held", async ({ page }) => {
  await page.goto("/?throw=1");
  await expect(page.getByRole("heading", "Runner fixture")).toBeVisible();
});

test("[console_error] a failed request the test did not declare", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("ping-fail").click();
  await expect(page.getByTestId("ping-status")).toHaveText("status 500");
});

test("[horizontal_overflow] a page that scrolls sideways", async ({ page }) => {
  await page.goto("/?wide=1");
  await expect(page.getByRole("heading", "Runner fixture")).toBeVisible();
});

test("[unawaited] an expect nobody awaited cannot pass", async ({ page }) => {
  await page.goto("/");
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  expect(page.getByTestId("ping-status")).toHaveText("this is not the text");
});

test("[ambiguous_anchor] acting on an anchor that matches two elements", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", "Save").click();
});

test("[drift] acting on an anchor that matches nothing", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("no-such-thing").click();
});

test("[secure_field] asserting the value of a password field", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Password")).toHaveValue("hunter2-do-not-leak");
});

test("[expectation_failed] a request that returned 500 is not a request that succeeded", async ({ page, network, audit }) => {
  audit.allowConsoleErrors("status of 500");
  await page.goto("/");
  await page.getByTestId("ping-fail").click();
  await expect(network).toHaveRequest({ method: "POST", url: "/api/ping" });
});

test("[expectation_failed] text that never appears", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ping-status")).toHaveText("status 200");
});

test("[drift] reading an element that is not there, even negated", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("no-such-thing")).not.toHaveText("anything");
});

test("[error] clicking a disabled button", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("submit-order").click();
});

test("[assertion_failed] a plain value comparison", async () => {
  expect(1 + 1).toBe(3);
});

test("[timeout] a test that outlives its budget", { timeout: 600 }, async ({ page }) => {
  await page.goto("/");
  await page.wait(5_000);
});

test("[error] an exception thrown by the test itself", async () => {
  throw new TypeError("thrown by the test");
});
