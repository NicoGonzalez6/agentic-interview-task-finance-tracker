// @vitest-environment node
// Required: TanStack Start's import protection mocks server modules in jsdom (client) environment.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import {
  collectDescendants,
  createBudgetInternal,
  deleteBudgetInternal,
  getBudgetStatusesInternal,
  monthRange,
  notifyBudgetOverruns,
  updateBudgetInternal,
} from "../src/server/budgets.server.ts";
import { getCapturedEmails } from "../src/server/email.ts";
import { env } from "../src/server/env.ts";

// Lets a test make the email provider fail; every other call goes through
// to the real in-memory capture used by getCapturedEmails.
const emailControl = vi.hoisted(() => ({ fail: false }));
vi.mock("../src/server/email.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/email.ts")>();
  return {
    ...actual,
    sendEmail: async (message: Parameters<typeof actual.sendEmail>[0]) => {
      if (emailControl.fail) throw new Error("email provider down");
      return actual.sendEmail(message);
    },
  };
});

describe("budgets", () => {
  const userId = "budgets-test-user";
  const otherUserId = "budgets-other-user";
  const accountId = "budgets-acc";
  const otherAccountId = "budgets-other-acc";
  const now = new Date("2026-07-15T12:00:00Z");

  // Unique recipient per test: captured emails are process-wide.
  let email = "";
  let emailSeq = 0;

  const insertCategory = (
    id: string,
    name: string,
    parentId: string | null = null,
    owner = userId,
  ) =>
    db
      .insert(schema.categories)
      .values({ id, user_id: owner, name, parent_id: parentId });

  let txnSeq = 0;
  const insertTransaction = (
    categoryId: string | null,
    amountMinor: number,
    date = "2026-07-10",
    owner = userId,
  ) =>
    db.insert(schema.transactions).values({
      id: `budgets-txn-${++txnSeq}`,
      user_id: owner,
      account_id: owner === userId ? accountId : otherAccountId,
      date,
      amount_minor: amountMinor,
      category_id: categoryId,
    });

  const insertBudget = (
    id: string,
    categoryId: string,
    limitMinor: number,
    owner = userId,
  ) =>
    db.insert(schema.budgets).values({
      id,
      user_id: owner,
      category_id: categoryId,
      limit_minor: limitMinor,
    });

  const statusOf = async (budgetId: string, at = now) => {
    const { budgets } = await getBudgetStatusesInternal(userId, db, at);
    const status = budgets.find((b) => b.id === budgetId);
    if (!status) throw new Error(`budget ${budgetId} missing`);
    return status;
  };

  beforeEach(async () => {
    email = `budgets-${++emailSeq}@example.com`;
    emailControl.fail = false;
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
    await db.insert(schema.accounts).values([
      { id: accountId, user_id: userId, name: "Checking" },
      { id: otherAccountId, user_id: otherUserId, name: "Other" },
    ]);
  });

  afterEach(async () => {
    // Dependency order: budgets and transactions reference categories.
    await db.delete(schema.budgets);
    await db.delete(schema.transactions);
    await db.delete(schema.categories);
    await db.delete(schema.accounts);
    await db.delete(schema.subscriptions);
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
  });

  describe("monthRange", () => {
    it("covers the UTC calendar month containing now", () => {
      expect(monthRange(now)).toEqual({
        month: "2026-07",
        from: "2026-07-01",
        toExclusive: "2026-08-01",
      });
      // Late on the last day in UTC is still the same month.
      expect(monthRange(new Date("2026-02-28T23:59:59Z")).month).toBe(
        "2026-02",
      );
    });

    it("rolls December over into January of the next year", () => {
      expect(monthRange(new Date("2026-12-31T10:00:00Z"))).toEqual({
        month: "2026-12",
        from: "2026-12-01",
        toExclusive: "2027-01-01",
      });
    });
  });

  describe("collectDescendants", () => {
    it("walks every level and survives cycles", () => {
      const categories = [
        { id: "a", parent_id: null },
        { id: "b", parent_id: "a" },
        { id: "c", parent_id: "b" },
        { id: "d", parent_id: null },
        // Corrupt cycle: must not loop forever.
        { id: "x", parent_id: "y" },
        { id: "y", parent_id: "x" },
      ];
      expect(collectDescendants(categories, "a").sort()).toEqual(["b", "c"]);
      expect(collectDescendants(categories, "d")).toEqual([]);
      expect(collectDescendants(categories, "x")).toEqual(["y"]);
    });
  });

  describe("spent amount", () => {
    it("is zero with no transactions", async () => {
      await insertCategory("cat-food", "Food");
      await insertBudget("bud-food", "cat-food", 10_000);
      expect(await statusOf("bud-food")).toEqual({
        id: "bud-food",
        categoryId: "cat-food",
        categoryName: "Food",
        categoryColor: "#6b7280",
        limitMinor: 10_000,
        spentMinor: 0,
        remainingMinor: 10_000,
        overBudget: false,
      });
    });

    it("counts only spending — income and refunds do not reduce it", async () => {
      await insertCategory("cat-food", "Food");
      await insertBudget("bud-food", "cat-food", 10_000);
      await insertTransaction("cat-food", -3_000);
      await insertTransaction("cat-food", -1_500);
      await insertTransaction("cat-food", 2_000); // refund
      const status = await statusOf("bud-food");
      expect(status.spentMinor).toBe(4_500);
      expect(status.remainingMinor).toBe(5_500);
    });

    it("ignores other months and other users", async () => {
      await insertCategory("cat-food", "Food");
      await insertBudget("bud-food", "cat-food", 10_000);
      await insertTransaction("cat-food", -1_000, "2026-07-01");
      await insertTransaction("cat-food", -1_000, "2026-07-31");
      await insertTransaction("cat-food", -9_000, "2026-06-30");
      await insertTransaction("cat-food", -9_000, "2026-08-01");
      // Another user's spending — even if it pointed at this category id.
      await insertTransaction("cat-food", -9_000, "2026-07-10", otherUserId);
      expect((await statusOf("bud-food")).spentMinor).toBe(2_000);

      // Budgets reset each month: the same budget in August starts fresh.
      const august = new Date("2026-08-05T00:00:00Z");
      expect((await statusOf("bud-food", august)).spentMinor).toBe(9_000);
      const september = new Date("2026-09-05T00:00:00Z");
      expect((await statusOf("bud-food", september)).spentMinor).toBe(0);
    });

    it("includes every level of subcategories", async () => {
      await insertCategory("cat-home", "Home");
      await insertCategory("cat-utilities", "Utilities", "cat-home");
      await insertCategory("cat-power", "Power", "cat-utilities");
      await insertBudget("bud-home", "cat-home", 50_000);
      await insertBudget("bud-utilities", "cat-utilities", 20_000);
      await insertTransaction("cat-home", -1_000);
      await insertTransaction("cat-utilities", -2_000);
      await insertTransaction("cat-power", -4_000);
      expect((await statusOf("bud-home")).spentMinor).toBe(7_000);
      expect((await statusOf("bud-utilities")).spentMinor).toBe(6_000);
    });

    it("moves with a subcategory that changes parent", async () => {
      await insertCategory("cat-home", "Home");
      await insertCategory("cat-fun", "Fun");
      await insertCategory("cat-games", "Games", "cat-home");
      await insertBudget("bud-home", "cat-home", 50_000);
      await insertBudget("bud-fun", "cat-fun", 50_000);
      await insertTransaction("cat-games", -3_000);
      expect((await statusOf("bud-home")).spentMinor).toBe(3_000);

      await db
        .update(schema.categories)
        .set({ parent_id: "cat-fun" })
        .where(eq(schema.categories.id, "cat-games"));
      expect((await statusOf("bud-home")).spentMinor).toBe(0);
      expect((await statusOf("bud-fun")).spentMinor).toBe(3_000);
    });

    it("is not over budget when spent equals the limit", async () => {
      await insertCategory("cat-food", "Food");
      await insertBudget("bud-food", "cat-food", 5_000);
      await insertTransaction("cat-food", -5_000);
      let status = await statusOf("bud-food");
      expect(status.remainingMinor).toBe(0);
      expect(status.overBudget).toBe(false);

      await insertTransaction("cat-food", -1);
      status = await statusOf("bud-food");
      expect(status.remainingMinor).toBe(-1);
      expect(status.overBudget).toBe(true);
    });

    it("lists budgets by category name with plan usage", async () => {
      await insertCategory("cat-z", "Zoo");
      await insertCategory("cat-a", "Art");
      await insertBudget("bud-z", "cat-z", 1_000);
      await insertBudget("bud-a", "cat-a", 1_000);
      // Another user's budget never shows up.
      await insertCategory("cat-other", "Other", null, otherUserId);
      await insertBudget("bud-other", "cat-other", 1_000, otherUserId);

      const overview = await getBudgetStatusesInternal(userId, db, now);
      expect(overview.month).toBe("2026-07");
      expect(overview.budgets.map((b) => b.id)).toEqual(["bud-a", "bud-z"]);
      expect(overview.usage).toEqual({
        count: 2,
        limit: env.billing.freeMaxBudgets,
      });
    });
  });

  describe("create, update and delete", () => {
    it("creates a budget for an owned category", async () => {
      await insertCategory("cat-food", "Food");
      const result = await createBudgetInternal(
        userId,
        { categoryId: "cat-food", limitMinor: 12_345 },
        db,
      );
      expect(result).toMatchObject({ success: true });
      const overview = await getBudgetStatusesInternal(userId, db, now);
      expect(overview.budgets).toHaveLength(1);
      expect(overview.budgets[0]).toMatchObject({
        categoryId: "cat-food",
        limitMinor: 12_345,
      });
    });

    it("rejects another user's category as not found", async () => {
      await insertCategory("cat-other", "Other", null, otherUserId);
      expect(
        await createBudgetInternal(
          userId,
          { categoryId: "cat-other", limitMinor: 1_000 },
          db,
        ),
      ).toEqual({ error: "Category not found" });
      expect(
        await createBudgetInternal(
          userId,
          { categoryId: "no-such-category", limitMinor: 1_000 },
          db,
        ),
      ).toEqual({ error: "Category not found" });
    });

    it("rejects a second budget for the same category", async () => {
      await insertCategory("cat-food", "Food");
      await insertBudget("bud-food", "cat-food", 1_000);
      expect(
        await createBudgetInternal(
          userId,
          { categoryId: "cat-food", limitMinor: 2_000 },
          db,
        ),
      ).toMatchObject({ code: "budget_exists" });
    });

    it("enforces the free plan limit and lets pro go beyond it", async () => {
      const max = env.billing.freeMaxBudgets;
      for (let i = 0; i <= max; i++) {
        await insertCategory(`cat-${i}`, `Category ${i}`);
      }
      for (let i = 0; i < max; i++) {
        expect(
          await createBudgetInternal(
            userId,
            { categoryId: `cat-${i}`, limitMinor: 1_000 },
            db,
          ),
        ).toMatchObject({ success: true });
      }
      expect(
        await createBudgetInternal(
          userId,
          { categoryId: `cat-${max}`, limitMinor: 1_000 },
          db,
        ),
      ).toMatchObject({ code: "budget_limit_reached", limit: max });

      await db.insert(schema.subscriptions).values({
        user_id: userId,
        plan: "pro",
        status: "active",
      });
      expect(
        await createBudgetInternal(
          userId,
          { categoryId: `cat-${max}`, limitMinor: 1_000 },
          db,
        ),
      ).toMatchObject({ success: true });
      const overview = await getBudgetStatusesInternal(userId, db, now);
      expect(overview.usage).toEqual({ count: max + 1, limit: null });
    });

    it("updates and deletes only the owner's budgets", async () => {
      await insertCategory("cat-food", "Food");
      await insertBudget("bud-food", "cat-food", 1_000);

      expect(
        await updateBudgetInternal(
          otherUserId,
          { id: "bud-food", limitMinor: 1 },
          db,
        ),
      ).toEqual({ error: "Budget not found" });
      expect(
        await deleteBudgetInternal(otherUserId, { id: "bud-food" }, db),
      ).toEqual({ error: "Budget not found" });
      expect((await statusOf("bud-food")).limitMinor).toBe(1_000);

      expect(
        await updateBudgetInternal(
          userId,
          { id: "bud-food", limitMinor: 2_500 },
          db,
        ),
      ).toEqual({ success: true });
      expect((await statusOf("bud-food")).limitMinor).toBe(2_500);

      expect(
        await deleteBudgetInternal(userId, { id: "bud-food" }, db),
      ).toEqual({ success: true });
      expect(
        (await getBudgetStatusesInternal(userId, db, now)).budgets,
      ).toEqual([]);
      expect(
        await deleteBudgetInternal(userId, { id: "bud-food" }, db),
      ).toEqual({ error: "Budget not found" });
    });
  });

  describe("over-budget alerts", () => {
    const setupOverBudget = async () => {
      await insertCategory("cat-food", "Food");
      await insertBudget("bud-food", "cat-food", 5_000);
      await insertTransaction("cat-food", -6_000);
    };

    it("sends one email when a budget goes over", async () => {
      await insertCategory("cat-food", "Food");
      await insertBudget("bud-food", "cat-food", 5_000);
      await insertTransaction("cat-food", -4_000);
      await notifyBudgetOverruns(userId, db, now);
      expect(getCapturedEmails(email)).toHaveLength(0);

      await insertTransaction("cat-food", -2_000);
      await notifyBudgetOverruns(userId, db, now);
      const emails = getCapturedEmails(email);
      expect(emails).toHaveLength(1);
      expect(emails[0].subject).toContain("Food");
      expect(emails[0].text).toContain("60.00");
      expect(emails[0].text).toContain("50.00");
      expect(emails[0].text).toContain("2026-07");
      expect(emails[0].text).toContain(`${env.email.baseUrl}/budgets`);
    });

    it("does not resend in the same month", async () => {
      await setupOverBudget();
      await notifyBudgetOverruns(userId, db, now);
      await insertTransaction("cat-food", -1_000);
      await notifyBudgetOverruns(userId, db, now);
      await notifyBudgetOverruns(userId, db, new Date("2026-07-31T23:00:00Z"));
      expect(getCapturedEmails(email)).toHaveLength(1);
    });

    it("sends a new email when going over again next month", async () => {
      await setupOverBudget();
      await notifyBudgetOverruns(userId, db, now);
      await insertTransaction("cat-food", -7_000, "2026-08-03");
      await notifyBudgetOverruns(userId, db, new Date("2026-08-04T00:00:00Z"));
      const emails = getCapturedEmails(email);
      expect(emails).toHaveLength(2);
      expect(emails[1].text).toContain("2026-08");
    });

    it("skips unverified users and users pending deletion", async () => {
      await setupOverBudget();
      await db
        .update(schema.users)
        .set({ email_verified_at: null })
        .where(eq(schema.users.id, userId));
      await notifyBudgetOverruns(userId, db, now);
      expect(getCapturedEmails(email)).toHaveLength(0);

      await db
        .update(schema.users)
        .set({
          email_verified_at: new Date("2026-01-01T00:00:00Z"),
          deletion_requested_at: new Date("2026-07-14T00:00:00Z"),
        })
        .where(eq(schema.users.id, userId));
      await notifyBudgetOverruns(userId, db, now);
      expect(getCapturedEmails(email)).toHaveLength(0);

      // Skipping must not consume the month's alert.
      const [row] = await db
        .select({ last: schema.budgets.last_alert_month })
        .from(schema.budgets)
        .where(eq(schema.budgets.id, "bud-food"));
      expect(row.last).toBeNull();
    });

    it("releases the alert when sending fails so the next write retries", async () => {
      await setupOverBudget();
      emailControl.fail = true;
      await expect(notifyBudgetOverruns(userId, db, now)).resolves.toBeUndefined();
      expect(getCapturedEmails(email)).toHaveLength(0);

      emailControl.fail = false;
      await notifyBudgetOverruns(userId, db, now);
      expect(getCapturedEmails(email)).toHaveLength(1);
    });

    it("never throws, even when the database fails", async () => {
      const broken = {
        select: () => {
          throw new Error("connection refused");
        },
      } as unknown as typeof db;
      await expect(
        notifyBudgetOverruns(userId, broken, now),
      ).resolves.toBeUndefined();
    });
  });
});
