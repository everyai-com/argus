import { ArgusTestError, beforeEach, describe, expect, test } from "../src/index.ts";

/** Run something that must be refused, and hand back the refusal. */
async function refusal(attempt: Promise<unknown>): Promise<ArgusTestError> {
  try {
    await attempt;
  } catch (err) {
    if (err instanceof ArgusTestError) return err;
    throw err;
  }
  throw new Error("expected the runner to refuse, but the call succeeded");
}

beforeEach(async ({ page }) => {
  await page.goto("/");
});

describe("anchors", () => {
  test("every rung of the ladder resolves", async ({ page }) => {
    await expect(page.getByTestId("display-name")).toHaveValue("Ada");
    await expect(page.getByRole("heading", "Runner fixture")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Runner fixture" })).toBeVisible();
    await expect(page.getByLabel("Display name")).toHaveValue("Ada");
    await expect(page.getByPlaceholder("Your name")).toHaveValue("Ada");
    await expect(page.getByText("plan: free")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Runner fixture");
    await expect(page.anchor({ testid: "plan-note" })).toHaveText("plan: free");
  });

  test("an ambiguous anchor is refused and names its candidates", async ({ page }) => {
    const err = await refusal(page.getByRole("button", "Save").click());
    expect(err.decision.verdict).toBe("ambiguous_anchor");
    expect(err.decision.whatChanged).toContain('anchor "button/Save" (via role) matched 2 elements');
    expect(err.decision.whatChanged).toContain('button "Save"');
    expect(err.decision.suggestedFix).toContain("data-testid");
  });

  test("an assertion on one element refuses an ambiguous anchor too", async ({ page }) => {
    const err = await refusal(expect(page.getByRole("button", "Save")).toBeVisible());
    expect(err.decision.verdict).toBe("ambiguous_anchor");
  });

  test("counting and listing may answer for many elements", async ({ page }) => {
    await expect(page.getByRole("button", "Save")).toHaveCount(2);
    await expect(page.getByRole("listitem")).toHaveText(["alpha", "beta", "gamma"]);
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(await page.getByRole("listitem").count()).toBe(3);
  });

  test("a missing anchor is drift, with the nearest surviving testid", async ({ page }) => {
    const err = await refusal(page.getByTestId("submit-ordr").click({ timeout: 300 }));
    expect(err.decision.verdict).toBe("drift");
    expect(err.decision.suggestedFix).toContain('"submit-order"');
  });
});

describe("secure fields", () => {
  test("the value of a password field is never returned", async ({ page }) => {
    const read = await refusal(page.getByLabel("Password").value());
    expect(read.decision.verdict).toBe("secure_field");
    expect(read.decision.whatChanged).not.toContain("hunter2");

    const asserted = await refusal(expect(page.getByLabel("Password")).toHaveValue("hunter2-do-not-leak"));
    expect(asserted.decision.verdict).toBe("secure_field");
    expect(asserted.message).not.toContain("hunter2");

    const attribute = await refusal(expect(page.getByLabel("Password")).toHaveAttribute("value", /hunter2/));
    expect(attribute.decision.verdict).toBe("secure_field");
  });

  test("a one-time code is secure even in a text input", async ({ page }) => {
    const err = await refusal(page.getByLabel("One-time code").value());
    expect(err.decision.verdict).toBe("secure_field");
    expect(err.message).not.toContain("424242");
  });

  test("a secure field can still be filled, and a failed fill does not echo the value", async ({ page }) => {
    await page.getByLabel("Password").fill("a-new-secret");
    const err = await refusal(page.getByTestId("submit-order").fill("s3cret-value", { timeout: 300 }));
    expect(err.decision.verdict).toBe("error");
    expect(err.message).not.toContain("s3cret-value");
  });
});

describe("actions and assertions", () => {
  test("fill, select, press, hover and the states they leave", async ({ page }) => {
    const name = page.getByLabel("Display name");
    await name.fill("Grace");
    await expect(name).toHaveValue("Grace");
    await name.clear();
    await expect(name).toHaveValue("");
    expect(await name.value()).toBe("");

    await page.getByRole("combobox", "Plan").selectOption("pro");
    await expect(page.getByTestId("plan-note")).toHaveText("plan: pro");

    await page.getByTestId("ping").hover();
    await expect(page.getByTestId("submit-order")).toBeDisabled();
    await expect(page.getByTestId("ping")).toBeEnabled();
    await expect(page.getByTestId("submit-order")).not.toBeEnabled();
  });

  test("text is what the user sees", async ({ page }) => {
    await expect(page.getByTestId("shout")).toHaveText("TOKEN REJECTED");
    await expect(page.getByTestId("shout")).toContainText("token rejected", { ignoreCase: true });
    await expect(page.getByTestId("shout")).toHaveText(/token rejected/i);
    await expect(page.getByTestId("spaced")).toHaveText("many spaces here");
    await expect(page.getByTestId("spaced")).not.toContainText("absent");
    expect(await page.getByTestId("spaced").text()).toBe("many spaces here");
  });

  test("assertions wait for what is not there yet", async ({ page }) => {
    await expect(page.getByTestId("late")).toBeHidden();
    expect(await page.getByTestId("late").isVisible()).toBe(false);
    await page.getByTestId("reveal").click();
    await expect(page.getByTestId("late")).toHaveText("here now");
  });

  test("navigation, URL and title", async ({ page }) => {
    await expect(page).toHaveTitle("Runner fixture");
    await page.goto("/second?x=1");
    await expect(page).toHaveURL("/second?x=1");
    await expect(page).toHaveURL(/\/second\?x=1$/);
    await page.back();
    await expect(page).not.toHaveURL("/second");
    await page.reload();
    await expect(page.getByRole("heading", "Runner fixture")).toBeVisible();
  });
});

describe("network", () => {
  test("a request is asserted as a consequence, with status and cardinality", async ({ page, network }) => {
    await expect(network).not.toHaveRequest({ method: "POST", url: "/api/ping" });
    await page.getByTestId("ping").click();
    await expect(network).toHaveRequest({ method: "POST", url: "/api/ping", status: 200, times: 1 });
    await expect(page.getByTestId("ping-status")).toHaveText("status 200");
    expect(await network.requests({ url: "/api/ping" })).toHaveLength(1);
  });

  test("a watermark scopes an assertion to what happened after it", async ({ page, network }) => {
    await page.getByTestId("ping").click();
    await expect(network).toHaveRequest({ method: "POST", url: "/api/ping", times: 1 });
    const mark = await network.mark();
    await expect(network).not.toHaveRequest({ method: "POST", url: "/api/ping", since: mark });
    await page.getByTestId("ping").click();
    await expect(network).toHaveRequest({ method: "POST", url: "/api/ping", times: 1, since: mark });
    await expect(network).toHaveRequest({ method: "POST", url: "/api/ping", times: 2 });
  });

  test("wire predicates run as written in a saved flow", async ({ page }) => {
    await page.getByTestId("ping").click();
    await expect(page).toSatisfy([
      { kind: "network", urlIncludes: "/api/ping", method: "POST", status: 200, maxCount: 1 },
      { kind: "text", anchor: { testid: "ping-status" }, includes: "status 200" },
      { kind: "route", includes: "127.0.0.1" },
      { kind: "console-clean" },
    ]);
  });
});

describe("audit signals", () => {
  test("a clean page has no console errors and no overflow", async ({ page, audit }) => {
    await expect(page).toHaveNoConsoleErrors();
    await expect(page).toHaveNoHorizontalOverflow();
    expect(await audit.consoleErrors()).toHaveLength(0);
    expect((await audit.horizontalOverflow()).overflow).toBe(false);
  });

  test("an expected console error is declared, not ignored wholesale", async ({ page, audit }) => {
    audit.allowConsoleErrors("fixture: boom", /status of 500/);
    await page.getByTestId("boom").click();
    await page.getByTestId("ping-fail").click();
    await expect(page.getByTestId("ping-status")).toHaveText("status 500");
    await expect(page).toHaveNoConsoleErrors();
  });

  test("overflow is readable, and names what is too wide", { audit: { horizontalOverflow: false } }, async ({ page, audit }) => {
    await page.goto("/?wide=1");
    const reading = await audit.horizontalOverflow();
    expect(reading.overflow).toBe(true);
    expect(reading.offenders[0]).toContain("too-wide");
    const err = await refusal(expect(page).toHaveNoHorizontalOverflow());
    expect(err.decision.verdict).toBe("horizontal_overflow");
  });

  test("the mobile viewport is the wire contract's", { viewport: "mobile" }, async ({ page, audit }) => {
    expect((await audit.horizontalOverflow()).viewportWidth).toBe(375);
    await expect(page.getByRole("heading", "Runner fixture")).toBeVisible();
  });
});

test.skip("a skipped test is reported, not run", async () => {
  throw new Error("must not run");
});
