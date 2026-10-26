import { test, expect } from "./fixtures";

//
// Stripe is never configured in TEST_MODE, so these tests exercise the
// billing surface through the /test-set-plan override, which writes the same
// subscriptions row a verified webhook would. Checkout/portal redirects and
// signature verification are covered by unit tests (tests/billing.test.ts).

test.describe("billing page", () => {
  test.beforeEach(async ({ page, signedInUser: _signedInUser }) => {
    await page.goto("/billing");
  });

  test("shows the free plan with usage and no upgrade button when billing is unconfigured", async ({
    page,
  }) => {
    await expect(page.getByTestId("billing-plan")).toHaveText("Free");
    // Fixture users are seeded with one "Main" account.
    await expect(page.getByTestId("billing-accounts-usage")).toHaveText(
      "1 of 2 accounts",
    );
    await expect(page.getByTestId("billing-scans-usage")).toHaveText(
      /0 of \d+ receipt scans/,
    );
    await expect(page.getByTestId("billing-budgets-usage")).toHaveText(
      "0 of 3 budgets",
    );
    // No Stripe keys in TEST_MODE → upgrade is unavailable and says so.
    await expect(
      page.getByRole("button", { name: "Upgrade to Pro" }),
    ).toBeHidden();
    await expect(
      page.getByText(/Payments are not configured on this deployment/),
    ).toBeVisible();
  });

  test("shows the pro plan and raised limits after an upgrade", async ({
    page,
  }) => {
    const res = await page.request.post("/test-set-plan?plan=pro");
    expect(res.ok()).toBe(true);

    await page.goto("/billing");
    await expect(page.getByTestId("billing-plan")).toHaveText("Pro");
    await expect(page.getByTestId("billing-accounts-usage")).toHaveText(
      /1 accounts \(unlimited\)/,
    );
    await expect(page.getByTestId("billing-scans-usage")).toHaveText(
      /0 of 200 receipt scans/,
    );
    await expect(page.getByTestId("billing-budgets-usage")).toHaveText(
      /0 budgets \(unlimited\)/,
    );

    // Entitlements changed without re-login: the scan page shows the pro
    // limit for the same session.
    await page.goto("/receipts/scan");
    await expect(page.getByTestId("scan-usage")).toHaveText(
      /0 of 200 scans used this month/,
    );
  });

  test("keeps pro entitlements with a warning while payment is past due", async ({
    page,
  }) => {
    await page.request.post("/test-set-plan?plan=pro&status=past_due");

    await page.goto("/billing");
    await expect(page.getByTestId("billing-plan")).toHaveText("Pro");
    await expect(page.getByTestId("billing-past-due")).toBeVisible();
  });

  test("downgrades to free once the subscription is canceled", async ({
    page,
  }) => {
    await page.request.post("/test-set-plan?plan=free&status=canceled");

    await page.goto("/billing");
    await expect(page.getByTestId("billing-plan")).toHaveText("Free");
  });

  test("is reachable from the sidebar", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Billing" }).click();
    await expect(
      page.getByRole("heading", { name: "Billing", exact: true }),
    ).toBeVisible();
  });
});

test.describe("account limit gating", () => {
  const addAccount = async (page: import("./fixtures").Page, name: string) => {
    await page.getByRole("button", { name: "Add Account" }).click();
    await expect(
      page.getByRole("textbox", { name: /Account Name/i }),
    ).toBeVisible();
    await page.getByRole("textbox", { name: /Account Name/i }).fill(name);
    await page.getByRole("button", { name: "Create Account" }).click();
  };

  test("free users can hold 2 accounts and are blocked with an upgrade hint on the third", async ({
    page,
    signedInUser,
  }) => {
    const suffix = signedInUser.username;
    await page.goto("/accounts");

    // The fixture seeds "Main", so one more fits within the free limit.
    await addAccount(page, `Second ${suffix}`);
    await expect(page.getByText(`Second ${suffix}`)).toBeVisible();

    await addAccount(page, `Third ${suffix}`);
    await expect(
      page.getByText(/free plan is limited to 2 accounts/i).first(),
    ).toBeVisible();
    await expect(page.getByText(`Third ${suffix}`)).toBeHidden();
  });

  test("pro users can create accounts beyond the free limit", async ({
    page,
    signedInUser,
  }) => {
    const suffix = signedInUser.username;
    await page.request.post("/test-set-plan?plan=pro");
    await page.goto("/accounts");

    await addAccount(page, `Second ${suffix}`);
    await expect(page.getByText(`Second ${suffix}`)).toBeVisible();
    await addAccount(page, `Third ${suffix}`);
    await expect(page.getByText(`Third ${suffix}`)).toBeVisible();
  });
});

test.describe("stripe webhook endpoint", () => {
  test("returns 404 when billing is not configured", async ({ page }) => {
    const res = await page.request.post("/api/stripe-webhook", {
      data: { id: "evt_x", type: "noop", data: { object: {} } },
    });
    expect(res.status()).toBe(404);
  });
});
