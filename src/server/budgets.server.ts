import { and, asc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "#/db";
import { formatMinor } from "#/lib/money";
import { m } from "#/paraglide/messages";
import { checkBudgetLimit, getEntitlements } from "#/server/billing.server";
import { sendEmail } from "#/server/email";
import { env } from "#/server/env";
import { getLogger } from "#/server/logger";

//
// Monthly category budgets. Server-only — imported by budgets.functions.ts
// and by the write paths that can raise spending (transactions, imports,
// categorization). Spent amounts are always derived from transactions for
// the current UTC calendar month, so budgets reset with no scheduled job.
// A parent category's budget includes spending in all of its descendants.

type Db = typeof defaultDb;

export interface MonthRange {
  /** 'YYYY-MM' — also the value stored in budgets.last_alert_month. */
  month: string;
  /** Inclusive lower bound, 'YYYY-MM-DD' (comparable with transactions.date). */
  from: string;
  /** Exclusive upper bound: the first day of the next month. */
  toExclusive: string;
}

export interface BudgetStatus {
  id: string;
  categoryId: string;
  categoryName: string;
  categoryColor: string | null;
  /** All amounts are integer minor units (grosze/cents). */
  limitMinor: number;
  spentMinor: number;
  /** limit − spent; negative when over budget. */
  remainingMinor: number;
  /** Strictly over: spending exactly the limit is not over budget. */
  overBudget: boolean;
}

export interface BudgetsOverview {
  month: string;
  budgets: BudgetStatus[];
  usage: {
    count: number;
    /** Plan limit; null = unlimited (Pro). */
    limit: number | null;
  };
}

export type BudgetMutationResult =
  | { success: true }
  | { error: string; code?: "budget_exists" | "budget_limit_reached"; limit?: number };

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The UTC calendar month containing `now`, as date strings. */
export function monthRange(now: Date): MonthRange {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
  const nextYear = month === 11 ? year + 1 : year;
  const nextMonth = month === 11 ? 0 : month + 1;
  return {
    month: `${year}-${pad2(month + 1)}`,
    from: `${year}-${pad2(month + 1)}-01`,
    toExclusive: `${nextYear}-${pad2(nextMonth + 1)}-01`,
  };
}

/**
 * Ids of every descendant of `rootId` (children, grandchildren, ...), not
 * including the root. Category nesting is arbitrary depth; the visited guard
 * keeps a corrupt parent cycle from looping forever.
 */
export function collectDescendants(
  categories: ReadonlyArray<{ id: string; parent_id: string | null }>,
  rootId: string,
): string[] {
  const children = new Map<string, string[]>();
  for (const c of categories) {
    if (!c.parent_id) continue;
    const list = children.get(c.parent_id) ?? [];
    list.push(c.id);
    children.set(c.parent_id, list);
  }

  const visited = new Set<string>([rootId]);
  const result: string[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const child of children.get(current) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      result.push(child);
      stack.push(child);
    }
  }
  return result;
}

interface LoadedBudget extends BudgetStatus {
  lastAlertMonth: string | null;
}

/** Budgets with this month's spending rolled up over each category subtree. */
async function loadBudgets(
  userId: string,
  db: Db,
  range: MonthRange,
): Promise<LoadedBudget[]> {
  const budgetRows = await db
    .select({
      id: schema.budgets.id,
      categoryId: schema.budgets.category_id,
      categoryName: schema.categories.name,
      categoryColor: schema.categories.color,
      limitMinor: schema.budgets.limit_minor,
      lastAlertMonth: schema.budgets.last_alert_month,
    })
    .from(schema.budgets)
    .innerJoin(
      schema.categories,
      and(
        eq(schema.budgets.category_id, schema.categories.id),
        eq(schema.categories.user_id, userId),
      ),
    )
    .where(eq(schema.budgets.user_id, userId))
    .orderBy(asc(schema.categories.name), asc(schema.budgets.id));
  if (budgetRows.length === 0) return [];

  const categories = await db
    .select({
      id: schema.categories.id,
      parent_id: schema.categories.parent_id,
    })
    .from(schema.categories)
    .where(eq(schema.categories.user_id, userId));

  // Only expenses count: income and refunds never reduce the spent amount.
  const spentRows = await db
    .select({
      categoryId: schema.transactions.category_id,
      // SUM over integers is bigint in Postgres (returned as a string) — map back to number.
      spent: sql<number>`COALESCE(SUM(ABS(${schema.transactions.amount_minor})), 0)`.mapWith(Number),
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.user_id, userId),
        isNotNull(schema.transactions.category_id),
        sql`${schema.transactions.amount_minor} < 0`,
        gte(schema.transactions.date, range.from),
        lt(schema.transactions.date, range.toExclusive),
      ),
    )
    .groupBy(schema.transactions.category_id);

  const spentByCategory = new Map<string, number>();
  for (const row of spentRows) {
    if (row.categoryId) spentByCategory.set(row.categoryId, row.spent);
  }

  return budgetRows.map((row) => {
    const subtree = [row.categoryId, ...collectDescendants(categories, row.categoryId)];
    const spentMinor = subtree.reduce(
      (sum, id) => sum + (spentByCategory.get(id) ?? 0),
      0,
    );
    return {
      ...row,
      spentMinor,
      remainingMinor: row.limitMinor - spentMinor,
      overBudget: spentMinor > row.limitMinor,
    };
  });
}

/** This month's status of every budget the user owns, plus plan usage. */
export async function getBudgetStatusesInternal(
  userId: string,
  db: Db = defaultDb,
  now: Date = new Date(),
): Promise<BudgetsOverview> {
  const range = monthRange(now);
  const [loaded, entitlements] = await Promise.all([
    loadBudgets(userId, db, range),
    getEntitlements(userId, db),
  ]);
  return {
    month: range.month,
    budgets: loaded.map(({ lastAlertMonth: _lastAlertMonth, ...status }) => status),
    usage: { count: loaded.length, limit: entitlements.maxBudgets },
  };
}

export async function createBudgetInternal(
  userId: string,
  data: { categoryId: string; limitMinor: number },
  db: Db = defaultDb,
): Promise<BudgetMutationResult> {
  const limit = await checkBudgetLimit(userId, db);
  if (!limit.allowed) {
    return { error: limit.error, code: limit.code, limit: limit.limit };
  }

  const category = await db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(
      and(
        eq(schema.categories.id, data.categoryId),
        eq(schema.categories.user_id, userId),
      ),
    )
    .limit(1);
  if (category.length === 0) {
    return { error: "Category not found" };
  }

  // The unique (user_id, category_id) index makes the duplicate check
  // atomic: a concurrent second insert is a no-op, not a crash.
  const inserted = await db
    .insert(schema.budgets)
    .values({
      id: crypto.randomUUID(),
      user_id: userId,
      category_id: data.categoryId,
      limit_minor: data.limitMinor,
    })
    .onConflictDoNothing({
      target: [schema.budgets.user_id, schema.budgets.category_id],
    })
    .returning({ id: schema.budgets.id });
  if (inserted.length === 0) {
    return {
      error: "This category already has a budget",
      code: "budget_exists",
    };
  }
  return { success: true };
}

/** Changes the monthly limit. The category of a budget never changes. */
export async function updateBudgetInternal(
  userId: string,
  data: { id: string; limitMinor: number },
  db: Db = defaultDb,
): Promise<BudgetMutationResult> {
  const updated = await db
    .update(schema.budgets)
    .set({ limit_minor: data.limitMinor, updated_at: new Date() })
    .where(
      and(eq(schema.budgets.id, data.id), eq(schema.budgets.user_id, userId)),
    )
    .returning({ id: schema.budgets.id });
  if (updated.length === 0) return { error: "Budget not found" };
  return { success: true };
}

export async function deleteBudgetInternal(
  userId: string,
  data: { id: string },
  db: Db = defaultDb,
): Promise<BudgetMutationResult> {
  const deleted = await db
    .delete(schema.budgets)
    .where(
      and(eq(schema.budgets.id, data.id), eq(schema.budgets.user_id, userId)),
    )
    .returning({ id: schema.budgets.id });
  if (deleted.length === 0) return { error: "Budget not found" };
  return { success: true };
}

const money = (minor: number) => `${formatMinor(minor)} ${m.analytics_currency()}`;

/**
 * Emails the user about every budget that is over its limit this month, at
 * most once per budget per month. Call after any write that can raise
 * spending. Never throws — an alert failure must not fail the user's write.
 *
 * Idempotency: the month's alert is claimed with an atomic
 * `UPDATE ... WHERE last_alert_month IS DISTINCT FROM $month RETURNING`, so
 * concurrent calls send one email. If sending fails, the claim is released
 * and the next write retries. Only verified, active users get alerts.
 */
export async function notifyBudgetOverruns(
  userId: string,
  db: Db = defaultDb,
  now: Date = new Date(),
): Promise<void> {
  try {
    const [user] = await db
      .select({
        email: schema.users.email,
        emailVerifiedAt: schema.users.email_verified_at,
        deletionRequestedAt: schema.users.deletion_requested_at,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!user?.email || !user.emailVerifiedAt || user.deletionRequestedAt) {
      return;
    }

    const range = monthRange(now);
    const overBudget = (await loadBudgets(userId, db, range)).filter(
      (b) => b.overBudget && b.lastAlertMonth !== range.month,
    );

    for (const budget of overBudget) {
      const claimed = await db
        .update(schema.budgets)
        .set({ last_alert_month: range.month })
        .where(
          and(
            eq(schema.budgets.id, budget.id),
            eq(schema.budgets.user_id, userId),
            sql`${schema.budgets.last_alert_month} IS DISTINCT FROM ${range.month}`,
          ),
        )
        .returning({ id: schema.budgets.id });
      if (claimed.length === 0) continue; // another write already alerted

      try {
        await sendEmail({
          to: user.email,
          subject: m.email_budget_exceeded_subject({
            category: budget.categoryName,
          }),
          text: m.email_budget_exceeded_body({
            category: budget.categoryName,
            limit: money(budget.limitMinor),
            spent: money(budget.spentMinor),
            month: range.month,
            link: `${env.email.baseUrl}/budgets`,
          }),
        });
        getLogger().info({ budgetId: budget.id }, "budget alert sent");
      } catch (err) {
        // Release the claim so the next spending write retries the alert.
        await db
          .update(schema.budgets)
          .set({ last_alert_month: budget.lastAlertMonth })
          .where(
            and(
              eq(schema.budgets.id, budget.id),
              eq(schema.budgets.user_id, userId),
              eq(schema.budgets.last_alert_month, range.month),
            ),
          );
        getLogger().error(
          { err, budgetId: budget.id },
          "failed to send budget alert",
        );
      }
    }
  } catch (err) {
    getLogger().error({ err }, "budget alert check failed");
  }
}
