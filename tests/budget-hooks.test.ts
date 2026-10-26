// @vitest-environment node
// Required: TanStack Start's import protection mocks server modules in jsdom (client) environment.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { notifyBudgetOverruns } from "../src/server/budgets.server.ts";
import { deleteCategoryInternal } from "../src/server/categories.server.ts";
import { getCapturedEmails } from "../src/server/email.ts";

// Category writes that touch budgets. There are no FK cascades, so deleting a
// category must remove its budgets itself; reassigning its transactions can
// push the target category over budget.
describe("budget hooks on category writes", () => {
  const userId = "budget-hooks-user";
  const otherUserId = "budget-hooks-other";
  const accountId = "budget-hooks-acc";
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  let email = "";
  let emailSeq = 0;

  const budgetIds = async (owner: string) =>
    (
      await db
        .select({ id: schema.budgets.id })
        .from(schema.budgets)
        .where(eq(schema.budgets.user_id, owner))
    ).map((b) => b.id);

  beforeEach(async () => {
    email = `budget-hooks-${++emailSeq}@example.com`;
    await db.insert(schema.users).values([
      {
        id: userId,
        username: userId,
        email,
        email_verified_at: new Date("2026-01-01T00:00:00Z"),
        password_hash: "x",
      },
      { id: otherUserId, username: otherUserId, password_hash: "x" },
    ]);
    await db
      .insert(schema.accounts)
      .values({ id: accountId, user_id: userId, name: "Checking" });
    await db.insert(schema.categories).values([
      { id: "bh-food", user_id: userId, name: "Food" },
      { id: "bh-snacks", user_id: userId, name: "Snacks", parent_id: "bh-food" },
      { id: "bh-misc", user_id: userId, name: "Misc" },
      { id: "bh-other-cat", user_id: otherUserId, name: "Other's" },
    ]);
  });

  afterEach(async () => {
    const users = [userId, otherUserId];
    await db.delete(schema.budgets).where(inArray(schema.budgets.user_id, users));
    await db
      .delete(schema.transactions)
      .where(inArray(schema.transactions.user_id, users));
    await db
      .delete(schema.categories)
      .where(inArray(schema.categories.user_id, users));
    await db.delete(schema.accounts).where(eq(schema.accounts.id, accountId));
    await db.delete(schema.users).where(inArray(schema.users.id, users));
  });

  it("deleting a category removes its budgets and its descendants' budgets", async () => {
    await db.insert(schema.budgets).values([
      { id: "bh-b-food", user_id: userId, category_id: "bh-food", limit_minor: 10000 },
      { id: "bh-b-snacks", user_id: userId, category_id: "bh-snacks", limit_minor: 2000 },
      { id: "bh-b-misc", user_id: userId, category_id: "bh-misc", limit_minor: 5000 },
      {
        id: "bh-b-other",
        user_id: otherUserId,
        category_id: "bh-other-cat",
        limit_minor: 5000,
      },
    ]);

    expect(await deleteCategoryInternal(userId, { id: "bh-food" })).toEqual({
      success: true,
    });

    expect(await budgetIds(userId)).toEqual(["bh-b-misc"]);
    expect(await budgetIds(otherUserId)).toEqual(["bh-b-other"]);
    const remaining = await db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(inArray(schema.categories.id, ["bh-food", "bh-snacks"]));
    expect(remaining).toHaveLength(0);
  });

  it("does not delete budgets of a category the user does not own", async () => {
    await db.insert(schema.budgets).values({
      id: "bh-b-other",
      user_id: otherUserId,
      category_id: "bh-other-cat",
      limit_minor: 5000,
    });

    expect(await deleteCategoryInternal(userId, { id: "bh-other-cat" })).toEqual({
      error: "Category not found",
    });
    expect(await budgetIds(otherUserId)).toEqual(["bh-b-other"]);
  });

  it("reassigning transactions can push the target over budget and alerts once", async () => {
    await db.insert(schema.budgets).values({
      id: "bh-b-misc",
      user_id: userId,
      category_id: "bh-misc",
      limit_minor: 5000,
    });
    await db.insert(schema.transactions).values({
      id: "bh-txn-1",
      user_id: userId,
      account_id: accountId,
      date: today,
      amount_minor: -8000,
      category_id: "bh-snacks",
    });

    expect(
      await deleteCategoryInternal(userId, {
        id: "bh-food",
        reassignToCategoryId: "bh-misc",
      }),
    ).toEqual({ success: true });
    // What deleteCategory does after a successful reassignment.
    await notifyBudgetOverruns(userId, db, now);
    await notifyBudgetOverruns(userId, db, now);

    expect(getCapturedEmails(email)).toHaveLength(1);
  });
});
