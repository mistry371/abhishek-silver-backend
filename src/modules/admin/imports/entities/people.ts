import { eq, or } from "drizzle-orm";
import { customerNotes, customers, vendors } from "@/db/schema";
import { zEmail, zMobile } from "@/lib/validation";
import { createCustomerRecord, customerName } from "@/services/customers";
import { documentNumbers } from "@/services/sequences";
import { vendorSchema } from "../../purchasing";
import type { RowReader } from "../reader";
import { defineImport, type ImportColumn, type RowPlan } from "../types";

/**
 * CUSTOMER & SUPPLIER IMPORTS
 * ------------------------------------------------------------------
 * Both match on the details staff actually have to hand — a customer by
 * mobile number or email, a supplier by its code or name — so importing the
 * same list twice updates the records instead of duplicating them.
 */

/** Staff type one name; the profile keeps a first and last name. */
function splitName(full: string) {
  const parts = full.trim().split(/\s+/);
  return { firstName: parts[0] ?? full, lastName: parts.slice(1).join(" ").slice(0, 60) };
}

function readEmail(row: RowReader, key: string) {
  const value = row.text(key, { max: 160 });
  if (!value) return undefined;
  const parsed = zEmail.safeParse(value);
  if (!parsed.success) {
    row.error(key, "Enter a valid email address.");
    return undefined;
  }
  return parsed.data;
}

function readMobile(row: RowReader, key: string) {
  const value = row.text(key, { max: 20 });
  if (!value) return undefined;
  const parsed = zMobile.safeParse(value);
  if (!parsed.success) {
    row.error(key, "Enter a valid 10-digit mobile number.");
    return undefined;
  }
  return parsed.data;
}

/* ------------------------------------------------------------------ */
/* Customers                                                           */
/* ------------------------------------------------------------------ */

const customerColumns: ImportColumn[] = [
  { key: "name", label: "Name", required: true, example: "Asha Patel", example2: "Rohit Shah", hint: "Full name. The first word is kept as the first name." },
  { key: "email", label: "Email", example: "asha@example.com", example2: "", hint: "Used to match an existing customer. Either email or mobile number is required." },
  { key: "phone", label: "Mobile", example: "9876543210", example2: "9825012345", hint: "10-digit Indian mobile number. Used to match an existing customer." },
  { key: "marketingOptIn", label: "Marketing Opt-In", example: "yes", example2: "no", hint: "Yes or No. Whether they agreed to receive offers." },
  { key: "source", label: "Source", example: "walk_in", example2: "admin", hint: "walk_in or admin. Defaults to walk_in." },
  { key: "notes", label: "Notes", example: "", example2: "Prefers 22KT bangles", hint: "Optional internal note. Needs the Customers → Notes permission." },
];

interface CustomerState {
  seen: Map<string, number>;
}

interface CustomerPlan extends RowPlan {
  customerId: string | null;
  /** Set for new customers only. */
  values?: { firstName: string; lastName: string; email: string | null; phone: string | null; marketingOptIn: boolean; source: "admin" | "walk_in" };
  patch: Partial<typeof customers.$inferInsert>;
  note: string | null;
}

export const customerImport = defineImport<CustomerState, CustomerPlan>({
  entity: "customers",
  label: "Customers",
  description: "Add walk-in and offline customers, matched on mobile number or email so repeat entries update the same profile.",
  module: "customers",
  permission: "customers:manage",
  columns: customerColumns,

  async prepare() {
    return { seen: new Map<string, number>() };
  },

  async plan(row, state, ctx) {
    const name = row.text("name", { required: true, max: 120 });
    const email = readEmail(row, "email");
    const phone = readMobile(row, "phone");
    const marketingOptIn = row.boolean("marketingOptIn");
    const source = row.choice("source", ["walk_in", "admin"] as const) ?? "walk_in";
    const note = row.text("notes", { max: 2000 });
    if (note && !ctx.can("customers:notes")) row.error("notes", "You don't have permission to add customer notes. Clear this column and try again.");
    if (!email && !phone) row.error("phone", "Add a mobile number or an email so the customer can be found later.");
    if (!name || !row.ok) return null;

    for (const key of [email, phone].filter(Boolean) as string[]) {
      const seen = state.seen.get(key);
      if (seen) row.error(email === key ? "email" : "phone", `${key} is already on row ${seen} of this file.`);
      else state.seen.set(key, row.number);
    }
    if (!row.ok) return null;

    const matches = await ctx.ex
      .select()
      .from(customers)
      .where(or(email ? eq(customers.email, email) : undefined, phone ? eq(customers.phone, phone) : undefined))
      .limit(2);
    if (matches.length > 1) {
      row.error("email", `This email and mobile number belong to two different customers (${matches.map((match) => match.customerCode).join(" and ")}). Merge them by hand first.`);
      return null;
    }

    const { firstName, lastName } = splitName(name);
    const existing = matches[0];
    if (!existing) {
      return {
        row: row.number,
        action: "create",
        summary: `${name} — new customer${phone ? ` (${phone})` : ""}`,
        customerId: null,
        values: { firstName, lastName, email: email ?? null, phone: phone ?? null, marketingOptIn: marketingOptIn ?? false, source },
        patch: {},
        note: note ?? null,
      };
    }

    if (existing.authUserId && email && email !== existing.email) {
      // The sign-in email lives in the identity provider; changing it here would desynchronise them.
      row.error("email", `${existing.customerCode} signs in with ${existing.email}. Ask the customer to change it from their account.`);
      return null;
    }
    const patch: Partial<typeof customers.$inferInsert> = {};
    if (firstName !== existing.firstName) patch.firstName = firstName;
    if (lastName && lastName !== existing.lastName) patch.lastName = lastName;
    if (email && email !== existing.email) patch.email = email;
    if (phone && phone !== existing.phone) patch.phone = phone;
    if (marketingOptIn !== undefined && marketingOptIn !== existing.marketingOptIn) patch.marketingOptIn = marketingOptIn;

    const changes = Object.keys(patch).length;
    if (!changes && !note) {
      return { row: row.number, action: "skip", summary: `${customerName(existing)} (${existing.customerCode}) — already up to date`, customerId: existing.id, patch, note: null };
    }
    return {
      row: row.number,
      action: "update",
      summary: `${customerName(existing)} (${existing.customerCode}) — ${changes ? `updates ${Object.keys(patch).length} detail(s)` : "adds a note"}`,
      customerId: existing.id,
      patch,
      note: note ?? null,
    };
  },

  async apply(plan, _state, ctx) {
    let customerId = plan.customerId;
    if (plan.values) {
      const created = await createCustomerRecord(ctx.tx, plan.values);
      customerId = created.id;
    } else if (customerId && Object.keys(plan.patch).length) {
      await ctx.tx
        .update(customers)
        .set({ ...plan.patch, updatedAt: new Date() })
        .where(eq(customers.id, customerId));
    }
    if (plan.note && customerId) {
      await ctx.tx.insert(customerNotes).values({ customerId, body: plan.note, authorAdminId: ctx.actor.adminId, authorName: ctx.actor.name });
    }
  },
});

/* ------------------------------------------------------------------ */
/* Suppliers (vendors)                                                 */
/* ------------------------------------------------------------------ */

const vendorColumns: ImportColumn[] = [
  { key: "code", label: "Supplier Code", example: "", example2: "VEN-0007", hint: "Leave blank for a new supplier — a code is generated. Fill it in to update an existing supplier." },
  { key: "name", label: "Name", required: true, example: "Surat Gold Works", example2: "Kalyan Silver Casting", hint: "Business name. Also used to match an existing supplier when no code is given." },
  { key: "contactPerson", label: "Contact Person", example: "Nilesh Mehta", example2: "", hint: "Optional." },
  { key: "mobile", label: "Mobile", example: "9825012345", example2: "", hint: "Optional. 10-digit Indian mobile number." },
  { key: "email", label: "Email", example: "accounts@suratgold.example", example2: "", hint: "Optional." },
  { key: "gstin", label: "GSTIN", example: "24AAACS1234A1Z5", example2: "", hint: "Optional. 15-character GST number." },
  { key: "address", label: "Address", example: "Ring Road, Surat", example2: "", hint: "Optional." },
  { key: "status", label: "Status", example: "active", example2: "inactive", hint: "active or inactive. Defaults to active." },
  { key: "notes", label: "Notes", example: "", example2: "", hint: "Optional internal note." },
];

interface VendorState {
  vendors: { id: string; code: string; name: string }[];
  seen: Map<string, number>;
}

interface VendorPlan extends RowPlan {
  vendorId: string | null;
  values: Partial<typeof vendors.$inferInsert>;
}

export const vendorImport = defineImport<VendorState, VendorPlan>({
  entity: "vendors",
  label: "Suppliers",
  description: "Add suppliers and update their contact details, matched on supplier code or name.",
  module: "purchases",
  permission: "vendors:manage",
  columns: vendorColumns,

  async prepare(ctx) {
    return {
      vendors: await ctx.ex.select({ id: vendors.id, code: vendors.code, name: vendors.name }).from(vendors),
      seen: new Map<string, number>(),
    };
  },

  async plan(row, state, ctx) {
    const code = row.text("code", { max: 40 })?.toUpperCase();
    const name = row.text("name", { required: true, max: 160 });
    const input = {
      name,
      contactPerson: row.text("contactPerson", { max: 120 }),
      mobile: row.text("mobile", { max: 20 }),
      email: row.text("email", { max: 160 }),
      gstin: row.text("gstin", { max: 20 }),
      address: row.text("address", { max: 500 }),
      status: row.choice("status", ["active", "inactive"] as const),
      notes: row.text("notes", { max: 2000 }),
    };
    if (!name || !row.ok) return null;

    const parsed = vendorSchema.partial().safeParse(input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) row.error(String(issue.path[0] ?? "name"), issue.message);
      return null;
    }

    const existing = code
      ? (state.vendors.find((vendor) => vendor.code.toUpperCase() === code) ?? null)
      : (state.vendors.find((vendor) => vendor.name.trim().toLowerCase() === name.trim().toLowerCase()) ?? null);
    if (code && !existing) {
      row.error("code", `No supplier has the code ${code}. Leave the code blank to add a new supplier.`);
      return null;
    }
    const key = existing?.id ?? name.trim().toLowerCase();
    const seen = state.seen.get(key);
    if (seen) {
      row.error("name", `This supplier is already on row ${seen} of this file.`);
      return null;
    }
    state.seen.set(key, row.number);

    const values = Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined && value !== null)) as Partial<typeof vendors.$inferInsert>;
    if (!existing) {
      state.vendors.push({ id: `row-${row.number}`, code: "", name });
      return { row: row.number, action: "create", summary: `${name} — new supplier`, vendorId: null, values };
    }
    return { row: row.number, action: "update", summary: `${existing.name} (${existing.code}) — updates contact details`, vendorId: existing.id, values };
  },

  async apply(plan, _state, ctx) {
    if (plan.vendorId) {
      await ctx.tx
        .update(vendors)
        .set({ ...plan.values, updatedAt: new Date() })
        .where(eq(vendors.id, plan.vendorId));
      return;
    }
    await ctx.tx
      .insert(vendors)
      .values({ ...plan.values, name: plan.values.name ?? "", code: await documentNumbers.vendor(ctx.tx) });
  },
});

