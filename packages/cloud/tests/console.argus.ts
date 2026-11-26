import { describe, expect, test } from "@argus/runner";

// Must match tests/serve-console.mjs — a local-only value, not a secret.
const ADMIN_TOKEN = "local-console-admin-token";

describe("console", () => {
  test("a signed-out visitor lands on account creation", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", "Create your Argus account")).toBeVisible();
    const create = page.getByRole("button", "Create account");
    await expect(create).toBeDisabled();

    await page.getByLabel("Email").fill("short-pass@example.test");
    await page.getByLabel("Password").fill("1234567");
    await expect(create).toBeDisabled();

    await page.getByLabel("Password").fill("12345678");
    await expect(create).toBeEnabled();
  });

  test("sign up, mint an MCP token, and read the fleet with it", async ({ page, network }) => {
    const email = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    await page.goto("/");

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("correct-horse-battery");
    await page.getByRole("button", "Create account").click();

    await expect(page.getByText("signed in")).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();

    await page.getByRole("button", "Create MCP token").click();
    await expect(network).toHaveRequest({ method: "POST", url: "/api/mcp-token", status: 200, times: 1 });

    await expect(page.getByText("Copy it now — it is not shown again.")).toBeVisible();
    // The token is shown once. It also lands in the rail's password field, whose
    // value the runner refuses to read — so assert what is on screen, and the
    // consequence: the rail now offers "Clear token".
    await expect(page.locator("code.mono")).toHaveText(/^argus_[A-Za-z0-9_-]{16,}$/);
    await expect(page.getByRole("button", "Clear token")).toBeVisible();

    // The real /v1 API accepts the minted token: the fleet view renders its
    // empty state instead of the "Token rejected" alert.
    await page.getByRole("button", "Fleet").click();
    await expect(page.getByRole("heading", "Fleet")).toBeVisible();
    await expect(page.getByText("No tagged runs yet")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("a wrong token is rejected with a way out", async ({ page, audit }) => {
    // This test provokes 401s on purpose; any other console error still fails it.
    audit.allowConsoleErrors("status of 401");
    await page.goto("/?tab=runs");

    await page.getByLabel("API token").fill("argus_not-a-real-token");

    const alert = page.getByRole("alert");
    // Text is what the user sees, and this label is CSS-uppercased.
    await expect(alert).toContainText("token rejected", { ignoreCase: true });
    await expect(alert).toContainText("401");
    await page.getByRole("button", "Open Account").click();
    await expect(page.getByRole("heading", "Create your Argus account")).toBeVisible();
  });

  test("the admin token reads live capacity", async ({ page }) => {
    await page.goto("/?tab=capacity");

    await page.getByLabel("API token").fill(ADMIN_TOKEN);

    await expect(page.getByRole("heading", "Capacity")).toBeVisible();
    await expect(page.getByRole("heading", "Tenants")).toBeVisible();
    await expect(page.getByText("60 browser slots free")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
