import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "#/db";
import { ownedEntityExists } from "#/server/ownership.server";

//
// Every statement is scoped to the owning user: a foreign category id
// behaves exactly like a missing one.

export interface DeleteCategoryInput {
  id: string;
  reassignToCategoryId?: string | null;
}

/** Deletes a category and its descendants, cleaning up every reference. */
export async function deleteCategoryInternal(
  userId: string,
  data: DeleteCategoryInput,
): Promise<{ success: true } | { error: string }> {
  if (!(await ownedEntityExists("category", userId, data.id))) {
    return { error: "Category not found" };
  }

  // Collect all descendant category IDs (children, grandchildren, etc.)
  const allDescendantIds: string[] = [];

  async function collectChildren(parentId: string): Promise<void> {
    const children = await db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(
        and(
          eq(schema.categories.parent_id, parentId),
          eq(schema.categories.user_id, userId),
        ),
      );
    for (const child of children) {
      allDescendantIds.push(child.id);
      await collectChildren(child.id);
    }
  }

  await collectChildren(data.id);

  // All category IDs that will be deleted (descendants + target)
  const allIdsToDelete = [...allDescendantIds, data.id];

  if (data.reassignToCategoryId) {
    if (data.reassignToCategoryId === data.id) {
      return {
        error: "Cannot reassign transactions to the category being deleted",
      };
    }
    const target = await db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(
        and(
          eq(schema.categories.id, data.reassignToCategoryId),
          eq(schema.categories.user_id, userId),
        ),
      )
      .limit(1);
    if (target.length === 0) {
      return { error: "Reassignment target category does not exist" };
    }

    // Reassign transactions from deleted categories to the target
    await db
      .update(schema.transactions)
      .set({ category_id: data.reassignToCategoryId })
      .where(
        and(
          inArray(schema.transactions.category_id, allIdsToDelete),
          eq(schema.transactions.user_id, userId),
        ),
      );
  } else {
    // Reset category_id on transactions that reference any of these categories
    await db
      .update(schema.transactions)
      .set({ category_id: null })
      .where(
        and(
          inArray(schema.transactions.category_id, allIdsToDelete),
          eq(schema.transactions.user_id, userId),
        ),
      );
  }

  // Reset category_id on receipt_items that reference any of these categories
  // (no user_id column, so scoped via the user's receipts)
  await db
    .update(schema.receipt_items)
    .set({ category_id: null })
    .where(
      and(
        inArray(schema.receipt_items.category_id, allIdsToDelete),
        inArray(
          schema.receipt_items.receipt_id,
          db
            .select({ id: schema.receipts.id })
            .from(schema.receipts)
            .where(eq(schema.receipts.user_id, userId)),
        ),
      ),
    );

  // Delete categorization_rules that reference any of these categories
  await db
    .delete(schema.categorization_rules)
    .where(
      and(
        inArray(schema.categorization_rules.category_id, allIdsToDelete),
        eq(schema.categorization_rules.user_id, userId),
      ),
    );

  // Delete budgets on any of these categories — there are no FK cascades, so
  // leaving them would block the category delete.
  await db
    .delete(schema.budgets)
    .where(
      and(
        inArray(schema.budgets.category_id, allIdsToDelete),
        eq(schema.budgets.user_id, userId),
      ),
    );

  // Delete all descendant categories first, then the target
  await db
    .delete(schema.categories)
    .where(
      and(
        inArray(schema.categories.id, allIdsToDelete),
        eq(schema.categories.user_id, userId),
      ),
    );

  return { success: true };
}
