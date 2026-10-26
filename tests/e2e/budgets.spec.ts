import { test, expect, type Page } from "./fixtures";
import type { APIRequestContext, Locator } from "@playwright/test";

//
// Monthly category budgets: CRUD, validation, spend aggregation across the
// category tree, over-budget state with a single email alert per month,
// Free/Pro gating, and interaction with category deletion.
//
// Every test runs as a fresh `signedInUser` seeded with the default
// categories (Groceries → Vegetables, …, Entertainment → Dining Out, …) and a
// "Main" account, so seeded names never collide across parallel tests.
// Transactions are dated the 15th of the current UTC month at noon so the
// month boundary (and the browser timezone) never moves them out of range.

type CapturedEmail = { to: string; subject: string; text: string };

async function fetchEmails(
  request: APIRequestContext,
  to: string,
  subjectPart: string,
): Promise<CapturedEmail[]> {
  const res = await request.get(`/test-emails?to=${encodeURIComponent(to)}`);
  const { emails } = (await res.json()) as { emails: CapturedEmail[] };
  return emails.filter((e) => e.subject.includes(subjectPart));
}

async function pollEmails(
  request: APIRequestContext,
  to: string,
  subjectPart: string,
): Promise<CapturedEmail[]> {
  let matching: CapturedEmail[] = [];
  await expect
    .poll(async () => {
      matching = await fetchEmails(request, to, subjectPart);
      return matching.length;
    })
    .toBeGreaterThanOrEqual(1);
  return matching;
}

function midMonthDateTime(): string {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${now.getUTCFullYear()}-${month}-15T12:00`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Category options are rendered with "—" depth prefixes ("— Vegetables"), so
// match on the trimmed name rather than the raw label.
function categoryOption(select: Locator, name: string): Locator {
  return select
    .locator("option")
    .filter({ hasText: new RegExp(`^[—\\s]*${escapeRegExp(name)}\\s*$`) });
}

async function selectCategory(select: Locator, name: string) {
  const value = await categoryOption(select, name).first().getAttribute("value");
  expect(value, `category option "${name}"`).toBeTruthy();
  await select.selectOption(value!);
}

async function selectAccount(select: Locator, prefix: string) {
  const value = await select
    .locator("option")
    .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(prefix)}`) })
    .first()
    .getAttribute("value");
  expect(value, `account option "${prefix}"`).toBeTruthy();
  await select.selectOption(value!);
}

function budgetRow(page: Page, categoryName: string): Locator {
  return page.getByTestId("budget-row").filter({ hasText: categoryName });
}

async function gotoBudgets(page: Page) {
  await page.goto("/budgets");
  await expect(
    page.getByRole("heading", { name: "Budgets", exact: true, level: 1 }),
  ).toBeVisible();
}

async function openNewBudgetDialog(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Add Budget" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New Budget" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function createBudget(page: Page, categoryName: string, limit: string) {
  const dialog = await openNewBudgetDialog(page);
  await selectCategory(dialog.getByLabel("Category"), categoryName);
  await dialog.getByLabel("Monthly limit").fill(limit);
  await dialog.getByRole("button", { name: "Create Budget" }).click();
}

async function createTransaction(
  page: Page,
  opts: {
    description: string;
    amount: string;
    category: string;
    isIncome?: boolean;
  },
) {
  await page.goto("/transactions");
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Add Transaction" })
    .click();
  const modal = page.getByRole("dialog", { name: "New Transaction" });
  await modal.getByLabel("Date").fill(midMonthDateTime());
  await modal.getByLabel("Description").fill(opts.description);
  await modal
    .getByRole("spinbutton", { name: "Amount", exact: true })
    .fill(opts.amount);
  await selectAccount(modal.getByLabel("Account"), "Main");
  await selectCategory(modal.getByLabel("Category"), opts.category);
  if (opts.isIncome) {
    await modal.getByLabel("Income").check();
  }
  await modal.getByRole("button", { name: "Create Transaction" }).click();
  await expect(modal).toBeHidden();
  await expect(
    page.getByRole("table").getByText(opts.description),
  ).toBeVisible();
}

async function createCategory(page: Page, name: string) {
  await page.goto("/categories");
  await page.getByRole("button", { name: "Add Category" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create Category" }).click();
  await expect(
    page.getByRole("row").filter({ hasText: name }).first(),
  ).toBeVisible();
}

async function deleteCategory(page: Page, name: string) {
  await page.goto("/categories");
  const row = page.getByRole("row").filter({ hasText: name }).first();
  await row.getByTestId("delete-category").click();
  await page
    .getByRole("alertdialog", { name: "Delete Category" })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(page.getByRole("main").getByText(name)).toBeHidden();
}

test.describe("Budgets page", () => {
  test("is reachable from the sidebar and shows the empty state", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Budgets" }).click();
    await expect(page).toHaveURL(/\/budgets$/);
    await expect(
      page.getByRole("heading", { name: "Budgets", exact: true, level: 1 }),
    ).toBeVisible();

    await expect(page.getByTestId("budget-row")).toHaveCount(0);
    await expect(
      page.getByRole("main").getByRole("heading", { level: 3 }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add Budget" }).first(),
    ).toBeVisible();
  });

  test("creates, edits and deletes a budget", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await gotoBudgets(page);

    await createBudget(page, "Groceries", "500");
    await expect(page.getByRole("dialog", { name: "New Budget" })).toBeHidden();

    const row = budgetRow(page, "Groceries");
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("budget-limit")).toContainText("500.00");
    await expect(row.getByTestId("budget-spent")).toContainText("0.00");
    await expect(row.getByTestId("budget-remaining")).toContainText("500.00");
    // Nothing spent yet: the bar is empty and no over-budget badge shows.
    await expect(row.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
    await expect(row.getByText("Over budget")).toBeHidden();

    // Edit the limit; the category is fixed while editing.
    await row.getByTestId("edit-budget").click();
    const editDialog = page.getByRole("dialog", { name: "Edit Budget" });
    await expect(editDialog).toBeVisible();
    await expect(editDialog.getByLabel("Category")).toBeDisabled();
    await editDialog.getByLabel("Monthly limit").fill("750");
    await editDialog.getByRole("button", { name: "Save Changes" }).click();
    await expect(editDialog).toBeHidden();
    await expect(row.getByTestId("budget-limit")).toContainText("750.00");
    await expect(row.getByTestId("budget-remaining")).toContainText("750.00");

    // Survives a reload — state is server-side.
    await page.reload();
    await expect(budgetRow(page, "Groceries")).toContainText("750.00");

    // Cancel keeps the budget, confirming deletes it.
    await budgetRow(page, "Groceries").getByTestId("delete-budget").click();
    const confirm = page.getByRole("alertdialog", { name: "Delete Budget" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(budgetRow(page, "Groceries")).toHaveCount(1);

    await budgetRow(page, "Groceries").getByTestId("delete-budget").click();
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByTestId("budget-row")).toHaveCount(0);
  });

  test("cancelling the new budget dialog creates nothing", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await gotoBudgets(page);
    const dialog = await openNewBudgetDialog(page);
    await selectCategory(dialog.getByLabel("Category"), "Housing");
    await dialog.getByLabel("Monthly limit").fill("100");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("budget-row")).toHaveCount(0);
  });
});

test.describe("Budget validation", () => {
  for (const [label, value, message] of [
    ["empty", "", "Enter a monthly limit greater than 0."],
    ["zero", "0", "Enter a monthly limit greater than 0."],
    ["negative", "-25", "Enter a monthly limit greater than 0."],
    ["too large", "10000001", "Monthly limit is too large."],
  ] as const) {
    test(`rejects a ${label} monthly limit`, async ({
      page,
      signedInUser: _signedInUser,
    }) => {
      await gotoBudgets(page);
      const dialog = await openNewBudgetDialog(page);
      await selectCategory(dialog.getByLabel("Category"), "Transport");
      await dialog.getByLabel("Monthly limit").fill(value);
      await dialog.getByRole("button", { name: "Create Budget" }).click();

      // The form opts out of native validation, so the app's own message
      // shows; the dialog stays open and nothing is persisted.
      await expect(dialog.getByRole("alert")).toContainText(message);
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByTestId("budget-row")).toHaveCount(0);
      await page.reload();
      await expect(page.getByTestId("budget-row")).toHaveCount(0);
    });
  }

  test("requires a category to be chosen", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await gotoBudgets(page);
    const dialog = await openNewBudgetDialog(page);
    await dialog.getByLabel("Monthly limit").fill("100");
    await dialog.getByRole("button", { name: "Create Budget" }).click();

    await expect(dialog.getByRole("alert")).toContainText(
      "Please choose a category.",
    );
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("budget-row")).toHaveCount(0);
  });

  test("does not offer a category that already has a budget", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await gotoBudgets(page);
    await createBudget(page, "Housing", "1200");
    await expect(budgetRow(page, "Housing")).toHaveCount(1);

    const dialog = await openNewBudgetDialog(page);
    const select = dialog.getByLabel("Category");
    await expect(categoryOption(select, "Housing")).toHaveCount(0);
    // Other categories (and Housing's own subcategories) are still offered.
    await expect(categoryOption(select, "Transport")).toHaveCount(1);
    await expect(categoryOption(select, "Utilities")).toHaveCount(1);
  });
});

test.describe("Budget spending", () => {
  test("counts subcategory expenses toward the parent and ignores income", async ({
    page,
    signedInUser,
  }) => {
    const suffix = signedInUser.username;
    await gotoBudgets(page);
    await createBudget(page, "Groceries", "500");
    await expect(budgetRow(page, "Groceries")).toHaveCount(1);

    await createTransaction(page, {
      description: `Veg ${suffix}`,
      amount: "120.00",
      category: "Vegetables",
    });

    await gotoBudgets(page);
    const row = budgetRow(page, "Groceries");
    await expect(row.getByTestId("budget-spent")).toContainText("120.00");
    await expect(row.getByTestId("budget-remaining")).toContainText("380.00");

    // A refund/income in the same category must not reduce the spend.
    await createTransaction(page, {
      description: `Refund ${suffix}`,
      amount: "50.00",
      category: "Groceries",
      isIncome: true,
    });

    await gotoBudgets(page);
    await expect(row.getByTestId("budget-spent")).toContainText("120.00");
    await expect(row.getByTestId("budget-remaining")).toContainText("380.00");
    await expect(row.getByText("Over budget")).toBeHidden();
  });

  test("shows the over-budget state and emails exactly once per month", async ({
    page,
    signedInUser,
  }) => {
    const suffix = signedInUser.username;
    const email = `${signedInUser.username}@example.com`;
    const subjectPart = "over your Entertainment budget";

    await gotoBudgets(page);
    await createBudget(page, "Entertainment", "10");
    await expect(budgetRow(page, "Entertainment")).toHaveCount(1);

    await createTransaction(page, {
      description: `Dinner ${suffix}`,
      amount: "25.00",
      category: "Dining Out",
    });

    await gotoBudgets(page);
    const row = budgetRow(page, "Entertainment");
    await expect(row.getByText("Over budget")).toBeVisible();
    await expect(row.getByRole("progressbar")).toBeVisible();
    await expect(row.getByTestId("budget-spent")).toContainText("25.00");
    await expect(row.getByTestId("budget-remaining")).toContainText(
      /Over by .*15\.00/,
    );

    const first = await pollEmails(page.request, email, subjectPart);
    expect(first[0].text).toContain("Entertainment");

    // A second overspending write in the same month does not re-alert. The
    // alert hook is awaited inside createTransaction, so once the row is
    // visible the check has already run — read the inbox once.
    await createTransaction(page, {
      description: `Movie ${suffix}`,
      amount: "5.00",
      category: "Hobbies",
    });
    const after = await fetchEmails(page.request, email, subjectPart);
    expect(after).toHaveLength(1);
  });
});

test.describe("Budget alerts on limit changes", () => {
  test("lowering the limit below current spending sends exactly one alert", async ({
    page,
    signedInUser,
  }) => {
    const suffix = signedInUser.username;
    const email = `${signedInUser.username}@example.com`;
    const subjectPart = "over your Transport budget";

    await gotoBudgets(page);
    await createBudget(page, "Transport", "100");
    await expect(budgetRow(page, "Transport")).toHaveCount(1);

    await createTransaction(page, {
      description: `Fuel ${suffix}`,
      amount: "40.00",
      category: "Fuel",
    });

    await gotoBudgets(page);
    const row = budgetRow(page, "Transport");
    await expect(row.getByTestId("budget-spent")).toContainText("40.00");
    await expect(row.getByTestId("budget-over-badge")).toBeHidden();
    // Under the limit: no alert yet.
    expect(await fetchEmails(page.request, email, subjectPart)).toHaveLength(0);

    // Deliberate behaviour: lowering the limit under the month's spending
    // counts as going over budget and alerts once.
    await row.getByTestId("edit-budget").click();
    const editDialog = page.getByRole("dialog", { name: "Edit Budget" });
    await editDialog.getByLabel("Monthly limit").fill("30");
    await editDialog.getByRole("button", { name: "Save Changes" }).click();
    await expect(editDialog).toBeHidden();

    await expect(row.getByTestId("budget-over-badge")).toBeVisible();
    await expect(row.getByTestId("budget-remaining")).toContainText(
      /Over by .*10\.00/,
    );
    await pollEmails(page.request, email, subjectPart);
    expect(await fetchEmails(page.request, email, subjectPart)).toHaveLength(1);
  });
});

test.describe("Budget plan limits", () => {
  test("free users can hold 3 budgets and are blocked with an upgrade hint on the 4th", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await gotoBudgets(page);
    for (const name of ["Groceries", "Housing", "Transport"]) {
      await createBudget(page, name, "100");
      await expect(budgetRow(page, name)).toHaveCount(1);
    }

    await createBudget(page, "Health", "100");
    await expect(
      page.getByText(/free plan is limited to 3 budgets/i).first(),
    ).toBeVisible();
    await page.goto("/budgets");
    await expect(page.getByTestId("budget-row")).toHaveCount(3);
    await expect(budgetRow(page, "Health")).toHaveCount(0);
  });

  test("pro users can create budgets beyond the free limit", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    const res = await page.request.post("/test-set-plan?plan=pro");
    expect(res.ok()).toBe(true);

    await gotoBudgets(page);
    for (const name of ["Groceries", "Housing", "Transport", "Health"]) {
      await createBudget(page, name, "100");
      await expect(budgetRow(page, name)).toHaveCount(1);
    }
    await expect(page.getByTestId("budget-row")).toHaveCount(4);
  });
});

test.describe("Budgets and category lifecycle", () => {
  test("shows 'Category not found' when the category was deleted elsewhere", async ({
    page,
    signedInUser,
  }) => {
    const name = `Stale ${signedInUser.username}`;
    await createCategory(page, name);

    await gotoBudgets(page);
    const dialog = await openNewBudgetDialog(page);
    await selectCategory(dialog.getByLabel("Category"), name);
    await dialog.getByLabel("Monthly limit").fill("80");

    // Same session, another tab: delete the category behind the dialog's back.
    const other = await page.context().newPage();
    await deleteCategory(other, name);
    await other.close();

    await dialog.getByRole("button", { name: "Create Budget" }).click();
    await expect(page.getByText("Category not found").first()).toBeVisible();
    await page.goto("/budgets");
    await expect(page.getByTestId("budget-row")).toHaveCount(0);
  });

  test("deleting a category removes its budget", async ({
    page,
    signedInUser,
  }) => {
    const name = `Budgeted ${signedInUser.username}`;
    await createCategory(page, name);

    await gotoBudgets(page);
    await createBudget(page, name, "60");
    await expect(budgetRow(page, name)).toHaveCount(1);

    await deleteCategory(page, name);

    await gotoBudgets(page);
    await expect(budgetRow(page, name)).toHaveCount(0);
    await expect(page.getByTestId("budget-row")).toHaveCount(0);
  });
});
