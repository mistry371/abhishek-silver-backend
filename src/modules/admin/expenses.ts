import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql, type SQL } from "drizzle-orm";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { db, type Tx } from "@/db/client";
import { expenseCategories, expenseEvents, expenses, recurringExpenses, vendors, type ExpenseStatus } from "@/db/schema";
import { adminOf, can, requirePermission } from "@/http/auth";
import { AppError, forbidden, invalid, notFound } from "@/lib/errors";
import { istDate, startOfIstMonth } from "@/lib/dates";
import { round2 } from "@/lib/money";
import { paginated, parse, zBoolQuery, zDate, zMoney, zText, zUuid } from "@/lib/validation";
import { actorOf, diff, recordAudit, type Actor } from "@/services/audit";
import { notify } from "@/services/notifications";
import { documentNumbers } from "@/services/sequences";
import { getSetting } from "@/services/settings";
import { deleteFile, readPrivateFile, storeFile, validateFile } from "@/services/storage";
import { idParam, listQuery, searchAny, sortBy, withinDateStrings } from "./helpers";

/**
 * EXPENSE MANAGEMENT — requested expansion (not in the original project document).
 * Draft → Submitted → Approved/Rejected → Paid. Approvals and tax fields are
 * switchable in Settings → Expenses. Recurring templates never post on their own.
 */
export const expensesRouter = Router();

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => value || null);

const PAYMENT_METHODS = ["cash", "upi", "bank_transfer", "card", "cheque", "other"] as const;
const MAX_ATTACHMENTS = 5;

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

const categorySchema = z.object({
  name: zText(80),
  parentId: zUuid.nullable().default(null),
  description: optionalText(300),
  active: z.boolean().default(true),
});

async function validateCategory(tx: Tx, input: { name: string; parentId: string | null }, selfId?: string) {
  if (input.parentId) {
    if (input.parentId === selfId) throw invalid({ parentId: "A category can't be its own parent." });
    const [parent] = await tx.select().from(expenseCategories).where(eq(expenseCategories.id, input.parentId)).limit(1);
    if (!parent) throw invalid({ parentId: "Choose an existing parent category." });
    if (parent.parentId) throw invalid({ parentId: "Categories can only be nested one level deep." });
    if (selfId) {
      const [children] = await tx.select({ value: count() }).from(expenseCategories).where(eq(expenseCategories.parentId, selfId));
      if ((children?.value ?? 0) > 0) throw invalid({ parentId: "This category has subcategories, so it can't be nested." });
    }
  }
  const [duplicate] = await tx
    .select({ id: expenseCategories.id })
    .from(expenseCategories)
    .where(
      and(
        eq(sql`lower(${expenseCategories.name})`, input.name.toLowerCase()),
        input.parentId ? eq(expenseCategories.parentId, input.parentId) : isNull(expenseCategories.parentId),
        selfId ? ne(expenseCategories.id, selfId) : undefined,
      ),
    )
    .limit(1);
  if (duplicate) throw invalid({ name: "A category with this name already exists here." });
}

expensesRouter.get("/expense-categories", requirePermission("expenses:view"), async (_req, res) => {
  const rows = await db().select().from(expenseCategories).orderBy(asc(expenseCategories.name));
  const usage = await db().select({ categoryId: expenses.categoryId, value: count() }).from(expenses).groupBy(expenses.categoryId);
  res.json(
    rows.map((row) => ({
      ...row,
      parentName: rows.find((r) => r.id === row.parentId)?.name ?? null,
      expenseCount: usage.find((u) => u.categoryId === row.id)?.value ?? 0,
    })),
  );
});

expensesRouter.post("/expense-categories", requirePermission("expenses:manage_categories"), async (req, res) => {
  const input = parse(categorySchema, req.body);
  const actor = actorOf(req);
  const row = await db().transaction(async (tx) => {
    await validateCategory(tx, input);
    const [created] = await tx.insert(expenseCategories).values(input).returning();
    await recordAudit(tx, actor, { module: "expenses", action: "category.create", entityType: "expense_category", entityId: created!.id, entityLabel: created!.name });
    return created!;
  });
  res.status(201).json(row);
});

expensesRouter.patch("/expense-categories/:id", requirePermission("expenses:manage_categories"), async (req, res) => {
  const id = idParam(req);
  const patch = parse(categorySchema.partial(), req.body);
  const actor = actorOf(req);
  const row = await db().transaction(async (tx) => {
    const [current] = await tx.select().from(expenseCategories).where(eq(expenseCategories.id, id)).for("update");
    if (!current) throw notFound();
    await validateCategory(tx, { name: patch.name ?? current.name, parentId: patch.parentId !== undefined ? patch.parentId : current.parentId }, id);
    const [updated] = await tx
      .update(expenseCategories)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(expenseCategories.id, id))
      .returning();
    const changes = diff(current, updated!);
    if (changes.changed) await recordAudit(tx, actor, { module: "expenses", action: "category.update", entityType: "expense_category", entityId: id, entityLabel: updated!.name, ...changes });
    return updated!;
  });
  res.json(row);
});

/* ------------------------------------------------------------------ */
/* Recurring templates                                                 */
/* ------------------------------------------------------------------ */

const recurringSchema = z.object({
  title: zText(120),
  categoryId: zUuid,
  amount: zMoney.refine((value) => value > 0, { error: "Enter an amount above zero." }),
  frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
  nextDueDate: zDate,
  payee: zText(160),
  paymentMethod: z.enum(PAYMENT_METHODS),
  paymentSource: optionalText(60),
  active: z.boolean().default(true),
  notes: optionalText(1000),
});

/** Advances a "YYYY-MM-DD" date, clamping month-ends (31 Jan + 1 month → 28/29 Feb). */
export function advanceDate(date: string, frequency: "weekly" | "monthly" | "quarterly" | "yearly") {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  if (frequency === "weekly") return new Date(Date.UTC(year, month - 1, day + 7)).toISOString().slice(0, 10);
  const months = frequency === "monthly" ? 1 : frequency === "quarterly" ? 3 : 12;
  const lastDay = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + months, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

async function assertActiveCategory(tx: Tx, categoryId: string) {
  const [category] = await tx.select().from(expenseCategories).where(eq(expenseCategories.id, categoryId)).limit(1);
  if (!category || !category.active) throw invalid({ categoryId: "Choose an active expense category." });
}

expensesRouter.get("/recurring-expenses", requirePermission("expenses:view"), async (_req, res) => {
  const rows = await db()
    .select({ recurring: recurringExpenses, categoryName: expenseCategories.name })
    .from(recurringExpenses)
    .innerJoin(expenseCategories, eq(expenseCategories.id, recurringExpenses.categoryId))
    .orderBy(asc(recurringExpenses.nextDueDate));
  res.json(rows.map((r) => ({ ...r.recurring, categoryName: r.categoryName })));
});

expensesRouter.post("/recurring-expenses", requirePermission("expenses:manage_categories"), async (req, res) => {
  const input = parse(recurringSchema, req.body);
  const actor = actorOf(req);
  const row = await db().transaction(async (tx) => {
    await assertActiveCategory(tx, input.categoryId);
    const [created] = await tx.insert(recurringExpenses).values(input).returning();
    await recordAudit(tx, actor, { module: "expenses", action: "recurring.create", entityType: "recurring_expense", entityId: created!.id, entityLabel: created!.title });
    return created!;
  });
  res.status(201).json(row);
});

expensesRouter.patch("/recurring-expenses/:id", requirePermission("expenses:manage_categories"), async (req, res) => {
  const id = idParam(req);
  const patch = parse(recurringSchema.partial(), req.body);
  const actor = actorOf(req);
  const row = await db().transaction(async (tx) => {
    const [current] = await tx.select().from(recurringExpenses).where(eq(recurringExpenses.id, id)).for("update");
    if (!current) throw notFound();
    if (patch.categoryId) await assertActiveCategory(tx, patch.categoryId);
    const [updated] = await tx
      .update(recurringExpenses)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(recurringExpenses.id, id))
      .returning();
    const changes = diff(current, updated!);
    if (changes.changed) await recordAudit(tx, actor, { module: "expenses", action: "recurring.update", entityType: "recurring_expense", entityId: id, entityLabel: updated!.title, ...changes });
    return updated!;
  });
  res.json(row);
});

/** Explicit staff action: creates a draft from the template and moves the due date forward. */
expensesRouter.post("/recurring-expenses/:id/create-draft", requirePermission("expenses:create"), async (req, res) => {
  const id = idParam(req);
  const actor = actorOf(req);
  const expenseId = await db().transaction(async (tx) => {
    const [template] = await tx.select().from(recurringExpenses).where(eq(recurringExpenses.id, id)).for("update");
    if (!template) throw notFound();
    if (!template.active) throw new AppError("validation_error", "This recurring expense is inactive.");
    await assertActiveCategory(tx, template.categoryId);
    const [expense] = await tx
      .insert(expenses)
      .values({
        expenseNumber: await documentNumbers.expense(tx),
        expenseDate: template.nextDueDate,
        categoryId: template.categoryId,
        amount: template.amount,
        totalAmount: template.amount,
        paymentMethod: template.paymentMethod,
        paymentSource: template.paymentSource,
        payee: template.payee,
        description: template.title,
        notes: template.notes,
        recurringId: template.id,
        createdById: actor.adminId,
        createdByName: actor.name,
      })
      .returning();
    await tx.insert(expenseEvents).values({ expenseId: expense!.id, action: "created", note: `From recurring “${template.title}”`, actorName: actor.name });
    await tx
      .update(recurringExpenses)
      .set({ nextDueDate: advanceDate(template.nextDueDate, template.frequency), lastCreatedAt: new Date(), updatedAt: new Date() })
      .where(eq(recurringExpenses.id, id));
    await recordAudit(tx, actor, { module: "expenses", action: "expense.create_from_recurring", entityType: "expense", entityId: expense!.id, entityLabel: expense!.expenseNumber });
    return expense!.id;
  });
  res.status(201).json(await expenseDetail(expenseId));
});

/* ------------------------------------------------------------------ */
/* Expenses                                                            */
/* ------------------------------------------------------------------ */

const expenseSchema = z.object({
  expenseDate: zDate,
  categoryId: zUuid,
  amount: zMoney.refine((value) => value > 0, { error: "Enter an amount above zero." }),
  taxAmount: zMoney.nullable().optional(),
  gstRate: z.number().min(0).max(28).nullable().optional(),
  paymentMethod: z.enum(PAYMENT_METHODS),
  paymentSource: optionalText(60),
  payee: zText(160),
  vendorId: zUuid.nullable().optional(),
  referenceNumber: optionalText(80),
  description: zText(500),
  notes: optionalText(2000),
});
type ExpenseInput = z.output<typeof expenseSchema>;

async function prepareExpense(tx: Tx, input: ExpenseInput) {
  const settings = await getSetting("expenses", tx);
  const hasTax = (input.taxAmount ?? 0) > 0 || (input.gstRate ?? 0) > 0;
  if (hasTax && !settings.taxFieldsEnabled) throw invalid({ taxAmount: "Tax fields are turned off in Settings → Expenses." });
  await assertActiveCategory(tx, input.categoryId);
  if (input.vendorId) {
    const [vendor] = await tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, input.vendorId)).limit(1);
    if (!vendor) throw invalid({ vendorId: "Choose an existing vendor." });
  }
  return {
    ...input,
    vendorId: input.vendorId ?? null,
    taxAmount: settings.taxFieldsEnabled ? (input.taxAmount ?? null) : null,
    gstRate: settings.taxFieldsEnabled ? (input.gstRate ?? null) : null,
    amount: round2(input.amount),
    totalAmount: round2(input.amount + (settings.taxFieldsEnabled ? (input.taxAmount ?? 0) : 0)),
  };
}

async function expenseDetail(id: string) {
  const [row] = await db()
    .select({ expense: expenses, categoryName: expenseCategories.name, vendorName: vendors.name, recurringTitle: recurringExpenses.title })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .leftJoin(vendors, eq(vendors.id, expenses.vendorId))
    .leftJoin(recurringExpenses, eq(recurringExpenses.id, expenses.recurringId))
    .where(eq(expenses.id, id))
    .limit(1);
  if (!row) throw notFound("Expense not found.");
  const events = await db().select().from(expenseEvents).where(eq(expenseEvents.expenseId, id)).orderBy(asc(expenseEvents.createdAt));
  return {
    ...row.expense,
    attachments: row.expense.attachments.map(({ path: _path, ...file }) => {
      void _path;
      return file;
    }),
    categoryName: row.categoryName,
    vendorName: row.vendorName,
    recurringTitle: row.recurringTitle,
    events,
  };
}

async function lockExpense(tx: Tx, id: string) {
  const [row] = await tx.select().from(expenses).where(eq(expenses.id, id)).for("update");
  if (!row) throw notFound("Expense not found.");
  return row;
}

function assertCanEdit(req: Request, expense: { createdById: string | null }) {
  if (expense.createdById !== adminOf(req).id && !can(req, "expenses:approve")) {
    throw forbidden("Only the person who created this expense or an approver can change it.");
  }
}

async function logEvent(tx: Tx, expenseId: string, action: string, actor: Actor, note?: string | null) {
  await tx.insert(expenseEvents).values({ expenseId, action, note: note ?? null, actorName: actor.name });
}

expensesRouter.get("/expenses/summary", requirePermission("expenses:view"), async (req, res) => {
  const { from, to } = parse(z.object({ from: zDate.optional(), to: zDate.optional() }), req.query);
  const today = istDate();
  const monthStart = istDate(startOfIstMonth());
  const periodFrom = from ?? monthStart;
  const periodTo = to ?? today;
  const counted = inArray(expenses.status, ["approved", "paid"]);
  const database = db();

  const [totals] = await database
    .select({
      today: sql<number>`coalesce(sum(${expenses.totalAmount}) filter (where ${expenses.expenseDate} = ${today}), 0)`.mapWith(Number),
      month: sql<number>`coalesce(sum(${expenses.totalAmount}) filter (where ${expenses.expenseDate} >= ${monthStart}), 0)`.mapWith(Number),
      period: sql<number>`coalesce(sum(${expenses.totalAmount}) filter (where ${expenses.expenseDate} between ${periodFrom} and ${periodTo}), 0)`.mapWith(Number),
      periodCount: sql<number>`count(*) filter (where ${expenses.expenseDate} between ${periodFrom} and ${periodTo})`.mapWith(Number),
    })
    .from(expenses)
    .where(counted);
  const topCategories = await database
    .select({ categoryId: expenses.categoryId, name: expenseCategories.name, total: sql<number>`sum(${expenses.totalAmount})`.mapWith(Number), count: count() })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .where(and(counted, gte(expenses.expenseDate, periodFrom), lte(expenses.expenseDate, periodTo)))
    .groupBy(expenses.categoryId, expenseCategories.name)
    .orderBy(desc(sql`sum(${expenses.totalAmount})`))
    .limit(5);
  const pending = await database
    .select({ id: expenses.id, expenseNumber: expenses.expenseNumber, payee: expenses.payee, totalAmount: expenses.totalAmount, expenseDate: expenses.expenseDate, createdByName: expenses.createdByName })
    .from(expenses)
    .where(eq(expenses.status, "submitted"))
    .orderBy(asc(expenses.submittedAt))
    .limit(10);
  const recent = await database
    .select({ id: expenses.id, expenseNumber: expenses.expenseNumber, payee: expenses.payee, totalAmount: expenses.totalAmount, status: expenses.status, expenseDate: expenses.expenseDate })
    .from(expenses)
    .orderBy(desc(expenses.createdAt))
    .limit(5);
  const recurring = await database.select().from(recurringExpenses).where(eq(recurringExpenses.active, true));
  const in30Days = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const perMonth = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 } as const;

  res.json({
    today: totals!.today,
    thisMonth: totals!.month,
    period: { from: periodFrom, to: periodTo, total: totals!.period, count: totals!.periodCount },
    topCategories,
    pendingApprovals: { count: pending.length, items: pending },
    recent,
    recurring: {
      active: recurring.length,
      monthlyEquivalent: round2(recurring.reduce((sum, r) => sum + r.amount * perMonth[r.frequency], 0)),
      dueWithin30Days: recurring
        .filter((r) => r.nextDueDate <= in30Days)
        .map((r) => ({ id: r.id, title: r.title, amount: r.amount, nextDueDate: r.nextDueDate })),
    },
  });
});

expensesRouter.get("/expenses", requirePermission("expenses:view"), async (req, res) => {
  const query = parse(
    listQuery.extend({
      status: z.enum(["draft", "submitted", "approved", "rejected", "paid"]).optional(),
      categoryId: zUuid.optional(),
      paymentMethod: z.enum(PAYMENT_METHODS).optional(),
      vendorId: zUuid.optional(),
      from: zDate.optional(),
      to: zDate.optional(),
      hasAttachment: zBoolQuery,
      recurring: zBoolQuery,
    }),
    req.query,
  );
  let categoryIds: string[] | undefined;
  if (query.categoryId) {
    const children = await db().select({ id: expenseCategories.id }).from(expenseCategories).where(eq(expenseCategories.parentId, query.categoryId));
    categoryIds = [query.categoryId, ...children.map((c) => c.id)];
  }
  const conditions: (SQL | undefined)[] = [
    query.status ? eq(expenses.status, query.status) : undefined,
    categoryIds ? inArray(expenses.categoryId, categoryIds) : undefined,
    query.paymentMethod ? eq(expenses.paymentMethod, query.paymentMethod) : undefined,
    query.vendorId ? eq(expenses.vendorId, query.vendorId) : undefined,
    ...withinDateStrings(expenses.expenseDate, query.from, query.to),
    query.hasAttachment === true ? sql`jsonb_array_length(${expenses.attachments}) > 0` : undefined,
    query.hasAttachment === false ? sql`jsonb_array_length(${expenses.attachments}) = 0` : undefined,
    query.recurring === true ? isNotNull(expenses.recurringId) : undefined,
    query.recurring === false ? isNull(expenses.recurringId) : undefined,
    searchAny(query.q, [expenses.expenseNumber, expenses.payee, expenses.referenceNumber, expenses.description]),
  ];
  const where = and(...conditions);
  const rows = await db()
    .select({ expense: expenses, categoryName: expenseCategories.name, vendorName: vendors.name })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .leftJoin(vendors, eq(vendors.id, expenses.vendorId))
    .where(where)
    .orderBy(sortBy(query.sort, { expenseDate: expenses.expenseDate, totalAmount: expenses.totalAmount, createdAt: expenses.createdAt }, desc(expenses.expenseDate)))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [total] = await db().select({ value: count() }).from(expenses).where(where);
  res.json(
    paginated(
      rows.map(({ expense, categoryName, vendorName }) => ({
        id: expense.id,
        expenseNumber: expense.expenseNumber,
        expenseDate: expense.expenseDate,
        categoryId: expense.categoryId,
        categoryName,
        payee: expense.payee,
        vendorName,
        description: expense.description,
        paymentMethod: expense.paymentMethod,
        amount: expense.amount,
        taxAmount: expense.taxAmount,
        totalAmount: expense.totalAmount,
        status: expense.status,
        attachmentCount: expense.attachments.length,
        recurring: Boolean(expense.recurringId),
        createdByName: expense.createdByName,
        createdAt: expense.createdAt,
      })),
      total?.value ?? 0,
      query.page,
      query.pageSize,
    ),
  );
});

expensesRouter.get("/expenses/:id", requirePermission("expenses:view"), async (req, res) => {
  res.json(await expenseDetail(idParam(req)));
});

expensesRouter.post("/expenses", requirePermission("expenses:create"), async (req, res) => {
  const input = parse(expenseSchema, req.body);
  const actor = actorOf(req);
  const id = await db().transaction(async (tx) => {
    const values = await prepareExpense(tx, input);
    const [row] = await tx
      .insert(expenses)
      .values({ ...values, expenseNumber: await documentNumbers.expense(tx), createdById: actor.adminId, createdByName: actor.name })
      .returning();
    await logEvent(tx, row!.id, "created", actor);
    await recordAudit(tx, actor, { module: "expenses", action: "expense.create", entityType: "expense", entityId: row!.id, entityLabel: row!.expenseNumber, after: { totalAmount: row!.totalAmount, payee: row!.payee } });
    return row!.id;
  });
  res.status(201).json(await expenseDetail(id));
});

expensesRouter.put("/expenses/:id", requirePermission("expenses:create"), async (req, res) => {
  const id = idParam(req);
  const input = parse(expenseSchema, req.body);
  const actor = actorOf(req);
  await db().transaction(async (tx) => {
    const current = await lockExpense(tx, id);
    assertCanEdit(req, current);
    if (current.status !== "draft" && current.status !== "rejected") throw new AppError("validation_error", "Only draft or rejected expenses can be edited.");
    const values = await prepareExpense(tx, input);
    const [row] = await tx
      .update(expenses)
      .set({ ...values, status: "draft", decision: null, decidedByName: null, decidedAt: null, decisionNote: null, updatedAt: new Date() })
      .where(eq(expenses.id, id))
      .returning();
    await logEvent(tx, id, current.status === "rejected" ? "revised" : "updated", actor);
    const changes = diff(current, row!);
    if (changes.changed) await recordAudit(tx, actor, { module: "expenses", action: "expense.update", entityType: "expense", entityId: id, entityLabel: current.expenseNumber, ...changes });
  });
  res.json(await expenseDetail(id));
});

async function transition(
  req: Request,
  id: string,
  from: ExpenseStatus[],
  run: (tx: Tx, expense: typeof expenses.$inferSelect, actor: Actor) => Promise<void>,
) {
  const actor = actorOf(req);
  await db().transaction(async (tx) => {
    const expense = await lockExpense(tx, id);
    if (!from.includes(expense.status)) throw new AppError("validation_error", `This expense is ${expense.status.replace("_", " ")} and can't be changed this way.`);
    await run(tx, expense, actor);
  });
  return expenseDetail(id);
}

expensesRouter.post("/expenses/:id/submit", requirePermission("expenses:create"), async (req, res) => {
  const id = idParam(req);
  res.json(
    await transition(req, id, ["draft"], async (tx, expense, actor) => {
      assertCanEdit(req, expense);
      const { approvalRequired } = await getSetting("expenses", tx);
      const now = new Date();
      if (approvalRequired) {
        await tx.update(expenses).set({ status: "submitted", submittedAt: now, updatedAt: now }).where(eq(expenses.id, id));
        await logEvent(tx, id, "submitted", actor);
        await notify(tx, {
          type: "expense_submitted",
          title: "Expense awaiting approval",
          body: `${expense.expenseNumber}: ₹${expense.totalAmount.toLocaleString("en-IN")} to ${expense.payee} (${actor.name})`,
          href: `/admin/expenses/${id}`,
          permission: "expenses:approve",
        });
      } else {
        await tx
          .update(expenses)
          .set({ status: "approved", submittedAt: now, decision: "approved", decidedByName: "Auto-approved (approvals off)", decidedAt: now, updatedAt: now })
          .where(eq(expenses.id, id));
        await logEvent(tx, id, "approved", actor, "Approvals are turned off in Settings");
      }
      await recordAudit(tx, actor, { module: "expenses", action: "expense.submit", entityType: "expense", entityId: id, entityLabel: expense.expenseNumber });
    }),
  );
});

expensesRouter.post("/expenses/:id/approve", requirePermission("expenses:approve"), async (req, res) => {
  const id = idParam(req);
  const { note } = parse(z.object({ note: z.string().trim().max(500).optional() }), req.body ?? {});
  res.json(
    await transition(req, id, ["submitted"], async (tx, expense, actor) => {
      const now = new Date();
      await tx
        .update(expenses)
        .set({ status: "approved", decision: "approved", decidedByName: actor.name, decidedAt: now, decisionNote: note || null, updatedAt: now })
        .where(eq(expenses.id, id));
      await logEvent(tx, id, "approved", actor, note);
      await recordAudit(tx, actor, {
        module: "expenses",
        action: "expense.approve",
        entityType: "expense",
        entityId: id,
        entityLabel: expense.expenseNumber,
        after: { totalAmount: expense.totalAmount },
        reason: note ?? null,
        sensitive: true,
      });
    }),
  );
});

expensesRouter.post("/expenses/:id/reject", requirePermission("expenses:approve"), async (req, res) => {
  const id = idParam(req);
  const { note } = parse(z.object({ note: zText(500) }), req.body);
  res.json(
    await transition(req, id, ["submitted"], async (tx, expense, actor) => {
      const now = new Date();
      await tx
        .update(expenses)
        .set({ status: "rejected", decision: "rejected", decidedByName: actor.name, decidedAt: now, decisionNote: note, updatedAt: now })
        .where(eq(expenses.id, id));
      await logEvent(tx, id, "rejected", actor, note);
      await recordAudit(tx, actor, { module: "expenses", action: "expense.reject", entityType: "expense", entityId: id, entityLabel: expense.expenseNumber, reason: note, sensitive: true });
    }),
  );
});

expensesRouter.post("/expenses/:id/mark-paid", requirePermission("expenses:approve"), async (req, res) => {
  const id = idParam(req);
  const { paidAt } = parse(z.object({ paidAt: z.iso.datetime({ offset: true }).optional() }), req.body ?? {});
  res.json(
    await transition(req, id, ["approved"], async (tx, expense, actor) => {
      await tx
        .update(expenses)
        .set({ status: "paid", paidAt: paidAt ? new Date(paidAt) : new Date(), paidByName: actor.name, updatedAt: new Date() })
        .where(eq(expenses.id, id));
      await logEvent(tx, id, "paid", actor);
      await recordAudit(tx, actor, { module: "expenses", action: "expense.mark_paid", entityType: "expense", entityId: id, entityLabel: expense.expenseNumber, sensitive: true });
    }),
  );
});

expensesRouter.delete("/expenses/:id", requirePermission("expenses:create"), async (req, res) => {
  const id = idParam(req);
  const actor = actorOf(req);
  const removed = await db().transaction(async (tx) => {
    const expense = await lockExpense(tx, id);
    assertCanEdit(req, expense);
    if (expense.status !== "draft") throw new AppError("validation_error", "Only draft expenses can be deleted.");
    await tx.delete(expenses).where(eq(expenses.id, id));
    await recordAudit(tx, actor, { module: "expenses", action: "expense.delete_draft", entityType: "expense", entityId: id, entityLabel: expense.expenseNumber, before: { totalAmount: expense.totalAmount } });
    return expense;
  });
  await Promise.all(removed.attachments.map((file) => deleteFile("private", file.path).catch(() => undefined)));
  res.status(204).end();
});

/* ------------------------------------------------------------------ */
/* Receipts & attachments (private storage)                            */
/* ------------------------------------------------------------------ */

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

expensesRouter.post("/expenses/:id/attachments", requirePermission("expenses:create"), upload.single("file"), async (req, res) => {
  const id = idParam(req);
  if (!req.file) throw invalid({ file: "Choose a receipt to upload." });
  const type = validateFile(req.file.buffer, "document");
  const [existing] = await db().select().from(expenses).where(eq(expenses.id, id)).limit(1);
  if (!existing) throw notFound("Expense not found.");
  if (existing.attachments.length >= MAX_ATTACHMENTS) throw invalid({ file: `An expense can have up to ${MAX_ATTACHMENTS} attachments.` });

  const stored = await storeFile({ bucket: "private", buffer: req.file.buffer, type, folder: `expenses/${id}` });
  const actor = actorOf(req);
  try {
    await db().transaction(async (tx) => {
      const expense = await lockExpense(tx, id);
      if (expense.attachments.length >= MAX_ATTACHMENTS) throw invalid({ file: `An expense can have up to ${MAX_ATTACHMENTS} attachments.` });
      const name = req.file!.originalname.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "receipt";
      const attachment = { id: randomUUID(), name, path: stored.path, size: req.file!.size, type, uploadedAt: new Date().toISOString() };
      await tx
        .update(expenses)
        .set({ attachments: [...expense.attachments, attachment], updatedAt: new Date() })
        .where(eq(expenses.id, id));
      await logEvent(tx, id, "attachment_added", actor, name);
      await recordAudit(tx, actor, { module: "expenses", action: "expense.attachment_add", entityType: "expense", entityId: id, entityLabel: expense.expenseNumber, after: { name } });
    });
  } catch (error) {
    await deleteFile("private", stored.path).catch(() => undefined);
    throw error;
  }
  res.status(201).json(await expenseDetail(id));
});

expensesRouter.get("/expenses/:id/attachments/:attachmentId", requirePermission("expenses:view"), async (req, res) => {
  const id = idParam(req);
  const attachmentId = idParam(req, "attachmentId");
  const [expense] = await db().select().from(expenses).where(eq(expenses.id, id)).limit(1);
  const file = expense?.attachments.find((a) => a.id === attachmentId);
  if (!file) throw notFound();
  const content = await readPrivateFile(file.path);
  if ("signedUrl" in content) {
    res.redirect(302, content.signedUrl);
    return;
  }
  res.setHeader("Content-Type", file.type);
  res.setHeader("Content-Disposition", `inline; filename="${file.name.replace(/"/g, "")}"`);
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.send(content.buffer);
});

expensesRouter.delete("/expenses/:id/attachments/:attachmentId", requirePermission("expenses:create"), async (req, res) => {
  const id = idParam(req);
  const attachmentId = idParam(req, "attachmentId");
  const actor = actorOf(req);
  const removed = await db().transaction(async (tx) => {
    const expense = await lockExpense(tx, id);
    assertCanEdit(req, expense);
    if (expense.status !== "draft" && expense.status !== "rejected") throw new AppError("validation_error", "Attachments can only be removed from draft or rejected expenses.");
    const file = expense.attachments.find((a) => a.id === attachmentId);
    if (!file) throw notFound();
    await tx
      .update(expenses)
      .set({ attachments: expense.attachments.filter((a) => a.id !== attachmentId), updatedAt: new Date() })
      .where(eq(expenses.id, id));
    await logEvent(tx, id, "attachment_removed", actor, file.name);
    await recordAudit(tx, actor, { module: "expenses", action: "expense.attachment_remove", entityType: "expense", entityId: id, entityLabel: expense.expenseNumber, before: { name: file.name } });
    return file;
  });
  await deleteFile("private", removed.path).catch(() => undefined);
  res.json(await expenseDetail(id));
});
