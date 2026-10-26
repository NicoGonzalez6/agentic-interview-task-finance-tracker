import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUserId } from "#/server/session";
import {
  createBudgetInternal,
  deleteBudgetInternal,
  getBudgetStatusesInternal,
  notifyBudgetOverruns,
  updateBudgetInternal,
} from "./budgets.server";

export type {
  BudgetMutationResult,
  BudgetStatus,
  BudgetsOverview,
} from "./budgets.server";

// --- Schemas ---

// Integer minor units; the cap keeps sums far below Postgres integer limits.
const limitMinorSchema = z.number().int().positive().max(1_000_000_000);

const createBudgetSchema = z.object({
  categoryId: z.string().min(1),
  limitMinor: limitMinorSchema,
});

const updateBudgetSchema = z.object({
  id: z.string().min(1),
  limitMinor: limitMinorSchema,
});

const deleteBudgetSchema = z.object({
  id: z.string().min(1),
});

// --- Server Functions ---

/**
 * Fetches this month's status of every budget (limit, spent, remaining,
 * over budget) plus the plan usage for the "x of y budgets" display.
 */
export const getBudgets = createServerFn({ method: "GET" }).handler(
  async () => {
    const userId = await requireUserId();
    return getBudgetStatusesInternal(userId);
  },
);

/**
 * Creates a budget. Creating one that is already exceeded sends the
 * over-budget alert right away.
 */
export const createBudget = createServerFn({ method: "POST" })
  .inputValidator(createBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    const result = await createBudgetInternal(userId, data);
    if ("success" in result) await notifyBudgetOverruns(userId);
    return result;
  });

/**
 * Changes a budget's monthly limit. Lowering it below this month's spending
 * sends the over-budget alert right away.
 */
export const updateBudget = createServerFn({ method: "POST" })
  .inputValidator(updateBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    const result = await updateBudgetInternal(userId, data);
    if ("success" in result) await notifyBudgetOverruns(userId);
    return result;
  });

export const deleteBudget = createServerFn({ method: "POST" })
  .inputValidator(deleteBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    return deleteBudgetInternal(userId, data);
  });
