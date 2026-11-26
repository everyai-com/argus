import { describe, expect, test } from "@argus/runner";

/**
 * The demo's injectable bugs (`?bug=`, see src/App.tsx). Unset, this is the
 * clean app and every test passes; tests/bug-matrix.mjs re-runs this file once
 * per variant and requires it to FAIL each time, with the predicted verdict.
 */
const bug = process.env.ARGUS_DEMO_BUG;
const home = bug ? `/?bug=${bug}` : "/";

describe("task board", () => {
  test("loads the seeded tasks", async ({ page }) => {
    await page.goto(home);

    await expect(page.getByRole("heading", "Task Board")).toBeVisible();
    await expect(page.getByTestId("task-count")).toHaveText("2 task(s)");
    await expect(page.getByRole("listitem")).toHaveText(["Ship Argus", "Test everything"]);
  });

  test("Add posts the task and lists it", async ({ page, network }) => {
    await page.goto(home);
    await expect(page.getByTestId("task-count")).toHaveText("2 task(s)");

    await page.getByPlaceholder("New task title").fill("Write the local runner");
    await page.getByRole("button", "Add").click();

    // Consequence first (the POST really succeeded, exactly once), then what the user sees.
    await expect(network).toHaveRequest({ method: "POST", url: "/api/tasks", status: 201, times: 1 });
    await expect(page.getByRole("listitem")).toHaveText([
      "Ship Argus",
      "Test everything",
      "Write the local runner",
    ]);
    await expect(page.getByTestId("task-count")).toHaveText("3 task(s)");
    await expect(page.getByPlaceholder("New task title")).toHaveValue("");
  });

  test("Enter in the title field adds the task", async ({ page, network }) => {
    await page.goto(home);
    await expect(page.getByTestId("task-count")).toHaveText("2 task(s)");

    const title = page.getByPlaceholder("New task title");
    await title.fill("Added with Enter");
    await title.press("Enter");

    await expect(network).toHaveRequest({ method: "POST", url: "/api/tasks", status: 201, times: 1 });
    await expect(page.getByText("Added with Enter")).toBeVisible();
    await expect(page.getByTestId("task-count")).toHaveText("3 task(s)");
  });

  test("a blank title adds nothing and sends no request", async ({ page, network }) => {
    await page.goto(home);
    await expect(page.getByTestId("task-count")).toHaveText("2 task(s)");

    await page.getByPlaceholder("New task title").fill("   ");
    await page.getByRole("button", "Add").click();

    await expect(network).not.toHaveRequest({ method: "POST", url: "/api/tasks" });
    await expect(page.getByRole("listitem")).toHaveCount(2);
    await expect(page.getByTestId("task-count")).toHaveText("2 task(s)");
  });
});
