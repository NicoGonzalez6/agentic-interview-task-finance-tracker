import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useMemo } from "react";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import { formatMinor, parseAmountToMinor } from "#/lib/money";
import { EditButton, DeleteButton } from "#/components/ui/action-buttons";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { CategoryBadge } from "#/components/ui/category-badge";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Select, SelectItem } from "#/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import {
  getBudgets,
  createBudget,
  updateBudget,
  deleteBudget,
} from "#/server/budgets.functions";
import { getCategories } from "#/server/categories.functions";

type BudgetsOverview = Awaited<ReturnType<typeof getBudgets>>;
type BudgetRow = BudgetsOverview["budgets"][number];
type BudgetMutationResult = Awaited<ReturnType<typeof createBudget>>;
type CategoryRow =
  ReturnType<typeof getCategories> extends Promise<(infer T)[]> ? T : unknown;

type CategoryTreeNode = CategoryRow & {
  children: CategoryTreeNode[];
};

// Mirrors the server-side cap on limitMinor in budgets.functions.ts so an
// oversized limit gets a friendly message instead of a schema error.
const MAX_LIMIT_MINOR = 1_000_000_000;

export const Route = createFileRoute("/_authed/budgets")({
  component: BudgetsPage,
});

function buildCategoryTree(categories: CategoryRow[]): CategoryTreeNode[] {
  const map = new Map<string, CategoryTreeNode>();
  for (const cat of categories) {
    map.set(cat.id, { ...cat, children: [] });
  }
  const roots: CategoryTreeNode[] = [];
  for (const cat of categories) {
    const node = map.get(cat.id)!;
    if (cat.parent_id) {
      const parent = map.get(cat.parent_id);
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    } else {
      roots.push(node);
    }
  }
  roots.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  for (const node of map.values()) {
    node.children.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  }
  return roots;
}

/** Maps a failed mutation result to a translated, user-facing message. */
function mutationErrorMessage(result: BudgetMutationResult): string | null {
  if (!("error" in result)) return null;
  if (result.code === "budget_limit_reached") {
    return m.budget_limit_reached({ limit: result.limit ?? 0 });
  }
  if (result.code === "budget_exists") {
    return m.budget_exists();
  }
  return result.error;
}

/** "2026-10" → "October 2026" in the active locale (UTC, no day shift). */
function formatMonth(month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return month;
  return date.toLocaleDateString(getLocale(), {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatAmount(minor: number): string {
  return `${formatMinor(minor)} ${m.analytics_currency()}`;
}

// --- Budget Row Component ---

function BudgetRowItem({
  budget,
  onEdit,
  onDelete,
}: {
  budget: BudgetRow;
  onEdit: (budget: BudgetRow) => void;
  onDelete: (id: string) => void;
}) {
  const percent =
    budget.limitMinor > 0
      ? Math.round((budget.spentMinor * 100) / budget.limitMinor)
      : 0;
  const barPercent = Math.min(Math.max(percent, 0), 100);

  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 hover:bg-accent/50 transition-colors group/row"
      role="row"
      data-testid="budget-row"
    >
      {/* Category + progress */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <CategoryBadge
            name={budget.categoryName}
            color={budget.categoryColor}
            className="truncate"
          />
          {budget.overBudget && (
            <Badge
              variant="ghost"
              className="bg-destructive/10 text-destructive border-destructive/30"
              data-testid="budget-over-badge"
            >
              {m.budgets_over_budget()}
            </Badge>
          )}
        </div>
        <div
          className="w-full bg-muted rounded-full h-2 mt-2"
          role="progressbar"
          aria-valuenow={barPercent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={m.budgets_progress_label({
            category: budget.categoryName,
            percent,
          })}
        >
          <div
            className={`${budget.overBudget ? "bg-destructive" : "bg-primary"} h-2 rounded-full transition-all duration-300`}
            style={{ width: `${barPercent}%` }}
          />
        </div>
      </div>

      {/* Limit */}
      <span
        className="w-28 text-right text-sm tabular-nums"
        data-testid="budget-limit"
      >
        {formatAmount(budget.limitMinor)}
      </span>

      {/* Spent */}
      <span
        className="w-28 text-right text-sm tabular-nums"
        data-testid="budget-spent"
      >
        {formatAmount(budget.spentMinor)}
      </span>

      {/* Remaining / Over by */}
      <span
        className={`w-32 text-right text-sm tabular-nums ${budget.overBudget ? "text-destructive font-medium" : "text-muted-foreground"}`}
        data-testid="budget-remaining"
      >
        {budget.overBudget
          ? m.budgets_over_by({
              amount: formatAmount(Math.abs(budget.remainingMinor)),
            })
          : formatAmount(budget.remainingMinor)}
      </span>

      {/* Actions */}
      <div className="flex items-center gap-1 w-32 justify-end">
        <EditButton onClick={() => onEdit(budget)} data-testid="edit-budget" />
        <DeleteButton
          onClick={() => onDelete(budget.id)}
          data-testid="delete-budget"
        />
      </div>
    </div>
  );
}

// --- Budget Form Modal ---

interface BudgetFormData {
  categoryId: string;
  limitMinor: number;
}

function BudgetForm({
  isOpen,
  editingBudget,
  categories,
  budgetedCategoryIds,
  onClose,
  onSubmit,
  error,
}: {
  isOpen: boolean;
  editingBudget: BudgetRow | null;
  categories: CategoryRow[];
  budgetedCategoryIds: Set<string>;
  onClose: () => void;
  onSubmit: (data: BudgetFormData) => Promise<void>;
  error: string | null;
}) {
  const [categoryId, setCategoryId] = useState("");
  const [limit, setLimit] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      if (editingBudget) {
        setCategoryId(editingBudget.categoryId);
        setLimit(formatMinor(editingBudget.limitMinor));
      } else {
        setCategoryId("");
        setLimit("");
      }
      setValidationError(null);
      setSubmitting(false);
    }
  }, [isOpen, editingBudget]);

  const categoryTree = useMemo(
    () => buildCategoryTree(categories),
    [categories],
  );

  // A category is selectable unless another budget already uses it. Its
  // children stay listed even when the parent itself is excluded.
  const isSelectable = (id: string) =>
    !budgetedCategoryIds.has(id) || editingBudget?.categoryId === id;

  function renderCategoryOptions(
    cats: CategoryTreeNode[],
    depth: number,
  ): React.ReactNode[] {
    return cats.flatMap((cat) => [
      ...(isSelectable(cat.id)
        ? [
            <SelectItem key={cat.id} value={cat.id}>
              {"—".repeat(depth)} {cat.name}
            </SelectItem>,
          ]
        : []),
      ...renderCategoryOptions(cat.children, depth + 1),
    ]);
  }

  const categoryOptions = renderCategoryOptions(categoryTree, 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!categoryId) {
      setValidationError(m.budgets_category_required());
      return;
    }
    const limitMinor = parseAmountToMinor(limit);
    if (limitMinor === null || limitMinor <= 0) {
      setValidationError(m.budgets_limit_invalid());
      return;
    }
    if (limitMinor > MAX_LIMIT_MINOR) {
      setValidationError(m.budgets_limit_too_large());
      return;
    }
    setSubmitting(true);
    setValidationError(null);
    try {
      await onSubmit({ categoryId, limitMinor });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editingBudget ? m.budgets_edit_title() : m.budgets_new_title()}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {/* Category */}
          <div>
            <Label htmlFor="budget-category" className="mb-1">
              {m.category_label()}
            </Label>
            <Select
              id="budget-category"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              disabled={!!editingBudget}
            >
              <SelectItem value="">{m.budgets_category_placeholder()}</SelectItem>
              {categoryOptions}
            </Select>
            {!editingBudget && categoryOptions.length === 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                {m.budgets_no_categories_left()}
              </p>
            )}
          </div>

          {/* Monthly limit */}
          <div>
            <Label htmlFor="budget-limit" className="mb-1">
              {m.budgets_limit_label()}
            </Label>
            <Input
              id="budget-limit"
              type="number"
              step="0.01"
              min="0.01"
              inputMode="decimal"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="0.00"
              autoFocus={!!editingBudget}
            />
          </div>

          {/* Error */}
          {error && (
            <div className="text-destructive text-sm" role="alert">
              {error}
            </div>
          )}
          {validationError && (
            <div className="text-destructive text-sm" role="alert">
              {validationError}
            </div>
          )}

          {/* Actions */}
          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={submitting}
            >
              {m.cancel()}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting
                ? editingBudget
                  ? m.saving()
                  : m.creating()
                : editingBudget
                  ? m.save_changes()
                  : m.budgets_create_btn()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Delete Confirmation ---

function DeleteConfirm({
  isOpen,
  categoryName,
  error,
  onConfirm,
  onCancel,
}: {
  isOpen: boolean;
  categoryName: string;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent className="sm:max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{m.budgets_delete_title()}</AlertDialogTitle>
          <AlertDialogDescription>
            {m.budgets_delete_confirm({ category: categoryName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <div
            className="text-destructive text-sm p-3 rounded-md bg-destructive/10"
            role="alert"
          >
            {error}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{m.cancel()}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(e) => {
              // Keep the dialog open until the server confirms the delete.
              e.preventDefault();
              onConfirm();
            }}
          >
            {m.delete()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// --- Main Page ---

const BUDGETS_QUERY_KEY = ["budgets"] as const;
const CATEGORIES_QUERY_KEY = ["categories"] as const;
const BILLING_QUERY_KEY = ["billing"] as const;

function BudgetsPage() {
  const queryClient = useQueryClient();
  const getBudgetsFn = useServerFn(getBudgets);
  const getCategoriesFn = useServerFn(getCategories);
  const createBudgetFn = useServerFn(createBudget);
  const updateBudgetFn = useServerFn(updateBudget);
  const deleteBudgetFn = useServerFn(deleteBudget);

  const { data: overview, isLoading } = useQuery({
    queryKey: BUDGETS_QUERY_KEY,
    queryFn: () => getBudgetsFn(),
    refetchOnMount: true,
    staleTime: 0,
  });

  const { data: categories = [] } = useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: () => getCategoriesFn(),
    refetchOnMount: true,
    staleTime: 0,
  });

  const invalidateBudgets = () => {
    queryClient.invalidateQueries({ queryKey: BUDGETS_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: BILLING_QUERY_KEY });
  };

  const createMutation = useMutation({
    mutationFn: (data: { categoryId: string; limitMinor: number }) =>
      createBudgetFn({ data }),
    onSuccess: invalidateBudgets,
  });

  const updateMutation = useMutation({
    mutationFn: (data: { id: string; limitMinor: number }) =>
      updateBudgetFn({ data }),
    onSuccess: invalidateBudgets,
  });

  const deleteMutation = useMutation({
    mutationFn: (data: { id: string }) => deleteBudgetFn({ data }),
    onSuccess: invalidateBudgets,
  });

  const budgets = overview?.budgets ?? [];
  const budgetedCategoryIds = useMemo(
    () => new Set(budgets.map((b) => b.categoryId)),
    [budgets],
  );

  // Form state
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingBudget, setEditingBudget] = useState<BudgetRow | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // Delete state
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleAdd = () => {
    setEditingBudget(null);
    setIsFormOpen(true);
    setFormError(null);
  };

  const handleEdit = (budget: BudgetRow) => {
    setEditingBudget(budget);
    setIsFormOpen(true);
    setFormError(null);
  };

  const handleFormSubmit = async (data: BudgetFormData) => {
    setFormError(null);
    try {
      const result = editingBudget
        ? await updateMutation.mutateAsync({
            id: editingBudget.id,
            limitMinor: data.limitMinor,
          })
        : await createMutation.mutateAsync(data);
      const message = mutationErrorMessage(result);
      if (message) {
        setFormError(message);
        return;
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
      return;
    }
    setIsFormOpen(false);
    setEditingBudget(null);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirmId) return;
    setDeleteError(null);
    try {
      const result = await deleteMutation.mutateAsync({ id: deleteConfirmId });
      const message = mutationErrorMessage(result);
      if (message) {
        setDeleteError(message);
        return;
      }
      setDeleteConfirmId(null);
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : m.budgets_delete_failed(),
      );
    }
  };

  const handleDeleteClick = (id: string) => {
    setDeleteConfirmId(id);
    setDeleteError(null);
  };

  const usage = overview?.usage;

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-line/50 bg-header-bg/80 backdrop-blur-sm">
        <div className="page-wrap py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold display-title">
              {m.budgets_title()}
            </h1>
            {overview && (
              <p className="text-sm text-muted-foreground mt-0.5">
                {m.budgets_subtitle({ month: formatMonth(overview.month) })}
                {usage && usage.limit !== null && (
                  <span data-testid="budgets-usage">
                    {" "}
                    {m.budgets_usage({ used: usage.count, limit: usage.limit })}
                  </span>
                )}
              </p>
            )}
          </div>
          <Button onClick={handleAdd}>
            <svg
              className="size-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 4v16m8-8H4"
              />
            </svg>
            {m.budgets_add()}
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <main className="page-wrap py-8">
        {formError && (
          <div
            className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm"
            role="alert"
          >
            {formError}
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
              <div className="size-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-muted-foreground">
                {m.loading()}
              </span>
            </div>
          </div>
        ) : budgets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <svg
              className="size-12 text-muted-foreground/40 mb-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M10.5 6a7.5 7.5 0 107.5 7.5h-7.5V6z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13.5 10.5H21A7.5 7.5 0 0013.5 3v7.5z"
              />
            </svg>
            <h3 className="text-base font-medium mb-1">
              {m.budgets_empty_title()}
            </h3>
            <p className="text-sm text-muted-foreground mb-4 max-w-sm">
              {m.budgets_empty_desc()}
            </p>
            <Button variant="outline" onClick={handleAdd}>
              {m.budgets_add_first()}
            </Button>
          </div>
        ) : (
          <div className="island-shell rounded-xl overflow-hidden">
            {/* Table header */}
            <div className="flex items-center gap-3 px-3 py-2 bg-muted/40 border-b border-line/50 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <span className="flex-1">{m.category_label()}</span>
              <span className="w-28 text-right">
                {m.budgets_limit_column()}
              </span>
              <span className="w-28 text-right">
                {m.budgets_spent_column()}
              </span>
              <span className="w-32 text-right">
                {m.budgets_remaining_column()}
              </span>
              <span className="w-32 text-right">{m.actions_column()}</span>
            </div>

            {/* Rows */}
            <div className="divide-y divide-line/30">
              {budgets.map((budget) => (
                <BudgetRowItem
                  key={budget.id}
                  budget={budget}
                  onEdit={handleEdit}
                  onDelete={handleDeleteClick}
                />
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Add/Edit Form */}
      <BudgetForm
        isOpen={isFormOpen}
        editingBudget={editingBudget}
        categories={categories}
        budgetedCategoryIds={budgetedCategoryIds}
        onClose={() => {
          setIsFormOpen(false);
          setEditingBudget(null);
          setFormError(null);
        }}
        onSubmit={handleFormSubmit}
        error={formError}
      />

      {/* Delete Confirmation */}
      <DeleteConfirm
        isOpen={!!deleteConfirmId}
        categoryName={
          budgets.find((b) => b.id === deleteConfirmId)?.categoryName ?? ""
        }
        error={deleteError}
        onConfirm={handleDeleteConfirm}
        onCancel={() => {
          setDeleteConfirmId(null);
          setDeleteError(null);
        }}
      />
    </div>
  );
}
