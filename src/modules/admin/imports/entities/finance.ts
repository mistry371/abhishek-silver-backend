import { and, count, eq, isNull } from "drizzle-orm";
import { categories, coupons, expenseCategories, expenseEvents, expenses, metalRates, pricingHistory, products } from "@/db/schema";
import { partialUpdate } from "@/lib/validation";
import { METALS, PURITIES, PURITIES_BY_METAL, purityLabels } from "@/modules/catalog/labels";
import { documentNumbers } from "@/services/sequences";
import { expenseSchema, PAYMENT_METHODS, prepareExpense, type ExpenseInput } from "../../expenses";
import { couponSchema, validateCoupon } from "../../marketing";
import type { RowReader } from "../reader";
import { defineImport, type ImportColumn, type RowPlan } from "../types";

/**
 * MONEY IMPORTS — expenses, coupons and metal rates
 * ------------------------------------------------------------------
 * Each row is checked against the same schema the matching screen uses, and
 * written the same way: expenses arrive as drafts with an event trail,
 * coupons keep their usage counts, and every rate change is written to price
 * history with the reason the file gives.
 */

function reportIssues(row: RowReader, issues: readonly { path: readonly PropertyKey[]; message: string }[], columnOf: (field: string) => string) {
  for (const issue of issues) {
    const field = issue.path.map(String).join(".") || "_row";
    row.error(columnOf(field.split(".")[0] ?? field), issue.message);
  }
}

const resolver = (columns: ImportColumn[]) => {
  const byField = columns.reduce((map, column) => map.set(column.field ?? column.key, map.get(column.field ?? column.key) ?? column.key), new Map<string, string>());
  return (field: string) => byField.get(field) ?? field;
};

/* ------------------------------------------------------------------ */
/* Expenses                                                            */
/* ------------------------------------------------------------------ */

const expenseColumns: ImportColumn[] = [
  { key: "date", label: "Date", field: "expenseDate", required: true, example: "2026-09-01", example2: "05/09/2026", hint: "The date the money was spent. 2026-09-01 or 01/09/2026." },
  { key: "category", label: "Category", field: "categoryId", required: true, example: "Shop rent", example2: "Packaging", hint: "An active expense category, by name. Add categories in Expenses → Categories first." },
  { key: "amount", label: "Amount", required: true, example: "25000", example2: "1450.50", hint: "Rupees, above zero. Commas and ₹ are ignored." },
  { key: "paymentMethod", label: "Payment Method", required: true, example: "bank_transfer", example2: "cash", hint: `One of: ${PAYMENT_METHODS.join(", ")}.` },
  { key: "payee", label: "Paid To", field: "payee", required: true, example: "Ratna Estates", example2: "Shree Packaging", hint: "Who was paid." },
  { key: "description", label: "Description", required: true, example: "Shop rent for September", example2: "Gift boxes and pouches", hint: "What the money was spent on. Up to 500 characters." },
  { key: "paymentSource", label: "Paid From", example: "Bank account", example2: "Cash", hint: "Optional. The account or cash box the money came from." },
  { key: "reference", label: "Reference", field: "referenceNumber", example: "NEFT-88213", example2: "", hint: "Optional. Cheque, UPI or bill number." },
  { key: "notes", label: "Notes", example: "", example2: "", hint: "Optional internal note." },
];

const expenseColumnOf = resolver(expenseColumns);

interface ExpensePlan extends RowPlan {
  input: ExpenseInput;
}

export const expenseImport = defineImport<{ categories: { id: string; name: string; active: boolean }[] }, ExpensePlan>({
  entity: "expenses",
  label: "Expenses",
  description: "Load a month of shop expenses. Every row is created as a draft expense that still goes through the usual approval.",
  module: "expenses",
  permission: "expenses:create",
  columns: expenseColumns,

  async prepare(ctx) {
    return { categories: await ctx.ex.select({ id: expenseCategories.id, name: expenseCategories.name, active: expenseCategories.active }).from(expenseCategories) };
  },

  async plan(row, state) {
    const categoryText = row.text("category", { required: true, max: 80 });
    const input = {
      expenseDate: row.date("date", { required: true }),
      amount: row.numeric("amount", { required: true, min: 0.01, max: 100_000_000 }),
      paymentMethod: row.choice("paymentMethod", PAYMENT_METHODS, { required: true }),
      paymentSource: row.text("paymentSource", { max: 60 }),
      payee: row.text("payee", { required: true, max: 160 }),
      referenceNumber: row.text("reference", { max: 80 }),
      description: row.text("description", { required: true, max: 500 }),
      notes: row.text("notes", { max: 2000 }),
    };

    const wanted = categoryText?.trim().toLowerCase();
    const matches = wanted ? state.categories.filter((category) => category.name.trim().toLowerCase() === wanted) : [];
    if (categoryText && !matches.length) {
      row.error("category", `Expense category "${categoryText}" not found. Add it in Expenses → Categories, or use one of: ${state.categories.filter((c) => c.active).map((c) => c.name).join(", ")}.`);
    } else if (matches.length > 1) {
      row.error("category", `More than one expense category is called "${categoryText}". Rename one of them so rows can't be filed in the wrong place.`);
    } else if (matches[0] && !matches[0].active) {
      row.error("category", `The expense category "${matches[0].name}" is switched off. Switch it on before importing into it.`);
    }
    if (!row.ok || !matches[0]) return null;

    const parsed = expenseSchema.safeParse({ ...input, categoryId: matches[0].id });
    if (!parsed.success) {
      reportIssues(row, parsed.error.issues, expenseColumnOf);
      return null;
    }
    return {
      row: row.number,
      action: "create",
      summary: `${parsed.data.expenseDate} — ₹${parsed.data.amount.toLocaleString("en-IN")} to ${parsed.data.payee} (${matches[0].name})`,
      input: parsed.data,
    };
  },

  async apply(plan, _state, ctx) {
    const values = await prepareExpense(ctx.tx, plan.input);
    const [created] = await ctx.tx
      .insert(expenses)
      .values({ ...values, expenseNumber: await documentNumbers.expense(ctx.tx), createdById: ctx.actor.adminId, createdByName: ctx.actor.name })
      .returning({ id: expenses.id });
    await ctx.tx.insert(expenseEvents).values({ expenseId: created!.id, action: "created", note: `Imported from ${ctx.fileName}`, actorName: ctx.actor.name });
  },
});

/* ------------------------------------------------------------------ */
/* Coupons                                                             */
/* ------------------------------------------------------------------ */

const couponColumns: ImportColumn[] = [
  { key: "code", label: "Code", required: true, example: "FESTIVE10", example2: "WELCOME500", hint: "3–30 letters and numbers. Customers type this at checkout; it also matches an existing coupon." },
  { key: "description", label: "Description", required: true, example: "10% off for Diwali", example2: "₹500 off the first order", hint: "Shown to staff in the coupon list." },
  { key: "type", label: "Type", example: "percentage", example2: "fixed", hint: "Required for new coupons. percentage or fixed." },
  { key: "value", label: "Value", example: "10", example2: "500", hint: "Required for new coupons. A percentage (up to 90) or an amount in rupees." },
  { key: "minOrderValue", label: "Minimum Order", example: "25000", example2: "", hint: "Optional. The order must reach this amount for the coupon to apply." },
  { key: "maxDiscount", label: "Maximum Discount", example: "5000", example2: "", hint: "Optional. Caps a percentage coupon in rupees." },
  { key: "startsAt", label: "Starts On", example: "2026-10-15", example2: "", hint: "Optional. The coupon starts at the beginning of this day (IST)." },
  { key: "endsAt", label: "Ends On", example: "2026-11-15", example2: "", hint: "Optional. The coupon stops at the end of this day (IST)." },
  { key: "usageLimit", label: "Usage Limit", example: "200", example2: "", hint: "Optional. How many times it can be used in total." },
  { key: "metals", label: "Applies To Metals", field: "appliesTo", example: "", example2: "gold", hint: "Optional. gold, silver or both, separated by commas. Blank means every product." },
  { key: "categorySlugs", label: "Applies To Categories", field: "appliesTo", example: "", example2: "rings, earrings", hint: "Optional. Category URL slugs, separated by commas." },
  { key: "active", label: "Active", example: "yes", example2: "yes", hint: "Yes or No. Defaults to Yes." },
];

const couponColumnOf = resolver(couponColumns);

/** A date-only cell covers the whole IST day, which is what staff mean by "valid until". */
const startOfDay = (date: string) => `${date}T00:00:00+05:30`;
const endOfDay = (date: string) => `${date}T23:59:59+05:30`;
const toDate = (value: unknown) => (typeof value === "string" ? new Date(value) : null);

interface CouponPlan extends RowPlan {
  couponId: string | null;
  values: Record<string, unknown>;
}

export const couponImport = defineImport<{ slugs: Set<string>; seen: Map<string, number> }, CouponPlan>({
  entity: "coupons",
  label: "Coupons",
  description: "Add or update discount coupons, matched on code. Usage counts on existing coupons are kept.",
  module: "marketing",
  permission: "marketing:manage",
  revalidate: true,
  columns: couponColumns,

  async prepare(ctx) {
    const rows = await ctx.ex.select({ slug: categories.slug }).from(categories);
    return { slugs: new Set(rows.map((row) => row.slug)), seen: new Map<string, number>() };
  },

  async plan(row, state, ctx) {
    const code = row.text("code", { required: true, max: 30 })?.toUpperCase();
    if (!code) return null;
    const seen = state.seen.get(code);
    if (seen) {
      row.error("code", `Coupon ${code} is already on row ${seen} of this file.`);
      return null;
    }
    state.seen.set(code, row.number);

    const [existing] = await ctx.ex.select().from(coupons).where(eq(coupons.code, code)).limit(1);
    const creating = !existing;
    const input: Record<string, unknown> = {};
    const set = (key: string, value: unknown) => {
      if (value !== undefined) input[key] = value;
    };
    set("description", row.text("description", { required: creating, max: 200 }));
    set("type", row.choice("type", ["percentage", "fixed"] as const, { required: creating }));
    set("value", row.numeric("value", { required: creating, min: 0.01, max: 10_000_000 }));
    set("minOrderValue", row.numeric("minOrderValue", { min: 0 }));
    set("maxDiscount", row.numeric("maxDiscount", { min: 0 }));
    set("usageLimit", row.numeric("usageLimit", { min: 1, max: 1_000_000, integer: true }));
    set("active", row.boolean("active"));
    const startsOn = row.date("startsAt");
    const endsOn = row.date("endsAt");
    if (startsOn) set("startsAt", startOfDay(startsOn));
    if (endsOn) set("endsAt", endOfDay(endsOn));

    const metals = row.list("metals", { max: 2 })?.map((value) => value.toLowerCase());
    const categorySlugs = row.list("categorySlugs", { max: 30 })?.map((value) => value.toLowerCase());
    if (metals) {
      const unknown = metals.filter((metal) => !(METALS as readonly string[]).includes(metal));
      if (unknown.length) row.error("metals", `Unknown metal: ${unknown.join(", ")}. Use gold or silver.`);
    }
    if (categorySlugs) {
      const unknown = categorySlugs.filter((slug) => !state.slugs.has(slug));
      if (unknown.length) row.error("categorySlugs", `Unknown categories: ${unknown.join(", ")}. Use the category's URL slug.`);
    }
    if (metals || categorySlugs) set("appliesTo", { ...(metals?.length ? { metals } : {}), ...(categorySlugs?.length ? { categorySlugs } : {}) });
    if (!row.ok) return null;

    const schema = creating ? couponSchema : partialUpdate(couponSchema);
    const parsed = schema.safeParse(creating ? { ...input, code } : input);
    if (!parsed.success) {
      reportIssues(row, parsed.error.issues, couponColumnOf);
      return null;
    }
    const data = parsed.data as Record<string, unknown>;
    await validateCoupon(ctx.ex, {
      ...(existing ?? {}),
      ...data,
      startsAt: (data.startsAt as string | undefined) ?? existing?.startsAt?.toISOString(),
      endsAt: (data.endsAt as string | undefined) ?? existing?.endsAt?.toISOString(),
    } as Parameters<typeof validateCoupon>[1]);

    const values: Record<string, unknown> = { ...data };
    if ("startsAt" in data) values.startsAt = toDate(data.startsAt);
    if ("endsAt" in data) values.endsAt = toDate(data.endsAt);
    if (creating) {
      values.minOrderValue = data.minOrderValue ?? null;
      values.maxDiscount = data.maxDiscount ?? null;
      values.usageLimit = data.usageLimit ?? null;
      return { row: row.number, action: "create", summary: `${code} — new coupon (${String(data.type)} ${String(data.value)})`, couponId: null, values: { ...values, code } };
    }
    const record = existing as unknown as Record<string, unknown>;
    const differences = Object.keys(values).filter((key) => JSON.stringify(record[key]) !== JSON.stringify(values[key]));
    if (!differences.length) return { row: row.number, action: "skip", summary: `${code} — already up to date`, couponId: existing!.id, values: {} };
    return { row: row.number, action: "update", summary: `${code} — updates ${differences.map(couponColumnOf).join(", ")}`, couponId: existing!.id, values };
  },

  async apply(plan, _state, ctx) {
    if (plan.action === "skip") return;
    if (!plan.couponId) {
      await ctx.tx.insert(coupons).values(plan.values as typeof coupons.$inferInsert);
      return;
    }
    await ctx.tx
      .update(coupons)
      .set({ ...plan.values, updatedAt: new Date() })
      .where(eq(coupons.id, plan.couponId));
  },
});

/* ------------------------------------------------------------------ */
/* Metal rates                                                         */
/* ------------------------------------------------------------------ */

const rateColumns: ImportColumn[] = [
  { key: "metal", label: "Metal", required: true, example: "gold", example2: "silver", hint: "gold or silver." },
  { key: "purity", label: "Purity", required: true, example: "22k", example2: "925", hint: "Gold: 24k, 22k, 18k, 14k. Silver: 999, 925." },
  { key: "ratePerGram", label: "Rate Per Gram", required: true, example: "9610", example2: "118", hint: "Today's rate in rupees per gram. This re-prices every product of that metal and purity." },
  { key: "reason", label: "Reason", required: true, example: "Morning rate, 12 Sep", example2: "Morning rate, 12 Sep", hint: "Why the rate changed. Kept in price history." },
];

interface RatePlan extends RowPlan {
  metal: (typeof METALS)[number];
  purity: (typeof PURITIES)[number];
  ratePerGram: number;
  previous: number | null;
  reason: string;
}

export const metalRateImport = defineImport<{ seen: Map<string, number> }, RatePlan>({
  entity: "metal-rates",
  label: "Metal rates",
  description: "Update the gold and silver rates used to price every product. Each change is written to price history.",
  module: "pricing",
  permission: "pricing:manage",
  rowLimit: 20,
  revalidate: true,
  columns: rateColumns,

  async prepare() {
    return { seen: new Map<string, number>() };
  },

  async plan(row, state, ctx) {
    const metal = row.choice("metal", METALS, { required: true });
    const purity = row.choice("purity", PURITIES, { required: true, extra: { "24kt": "24k", "22kt": "22k", "18kt": "18k", "14kt": "14k", sterling: "925" } });
    const ratePerGram = row.numeric("ratePerGram", { required: true, min: 0.01, max: 1_000_000 });
    const reason = row.text("reason", { required: true, max: 300 });
    if (metal && purity && !PURITIES_BY_METAL[metal].includes(purity)) {
      row.error("purity", `${purityLabels[purity]} isn't a ${metal} purity. Use ${PURITIES_BY_METAL[metal].join(", ")}.`);
    }
    if (!metal || !purity || ratePerGram === undefined || !reason || !row.ok) return null;

    const key = `${metal}:${purity}`;
    const seen = state.seen.get(key);
    if (seen) {
      row.error("purity", `${purityLabels[purity]} ${metal} is already on row ${seen} of this file.`);
      return null;
    }
    state.seen.set(key, row.number);

    const [existing] = await ctx.ex
      .select({ ratePerGram: metalRates.ratePerGram })
      .from(metalRates)
      .where(and(eq(metalRates.metal, metal), eq(metalRates.purity, purity)))
      .limit(1);
    const label = `${purityLabels[purity]} ${metal}`;
    if (existing && existing.ratePerGram === ratePerGram) {
      return { row: row.number, action: "skip", summary: `${label} — already ₹${ratePerGram.toLocaleString("en-IN")}/g`, metal, purity, ratePerGram, previous: existing.ratePerGram, reason };
    }
    return {
      row: row.number,
      action: existing ? "update" : "create",
      summary: `${label} — ₹${(existing?.ratePerGram ?? 0).toLocaleString("en-IN")}/g → ₹${ratePerGram.toLocaleString("en-IN")}/g`,
      metal,
      purity,
      ratePerGram,
      previous: existing?.ratePerGram ?? null,
      reason,
    };
  },

  async apply(plan, _state, ctx) {
    if (plan.action === "skip") return;
    await ctx.tx
      .insert(metalRates)
      .values({ metal: plan.metal, purity: plan.purity, ratePerGram: plan.ratePerGram, updatedBy: ctx.actor.name })
      .onConflictDoUpdate({ target: [metalRates.metal, metalRates.purity], set: { ratePerGram: plan.ratePerGram, updatedBy: ctx.actor.name, updatedAt: new Date() } });
    const [impact] = await ctx.tx
      .select({ value: count() })
      .from(products)
      .where(and(eq(products.status, "active"), isNull(products.deletedAt), eq(products.metal, plan.metal), eq(products.purity, plan.purity)));
    await ctx.tx.insert(pricingHistory).values({
      kind: "metal_rate",
      label: `${purityLabels[plan.purity]} ${plan.metal}`,
      before: { ratePerGram: plan.previous },
      after: { ratePerGram: plan.ratePerGram },
      reason: plan.reason,
      affectedProducts: impact?.value ?? 0,
      actorAdminId: ctx.actor.adminId,
      actorName: ctx.actor.name,
    });
  },
});
