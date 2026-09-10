import { and, asc, count, desc, eq, ilike, inArray, ne, or, type SQL } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { auth } from "@/auth";
import { ALL_PERMISSIONS, isPermission, permissionGroups, SUPER_ADMIN_ROLE } from "@/auth/permissions";
import { db, type Executor, type Tx } from "@/db/client";
import { adminUsers, auditLogs, rolePermissions, roles, stockLocations } from "@/db/schema";
import { adminOf, requirePermission } from "@/http/auth";
import { AppError, invalid, notFound } from "@/lib/errors";
import { paginated, parse, zBoolQuery, zDate, zEmail, zMobile, zPassword, zText, zUuid } from "@/lib/validation";
import { actorOf, diff, recordAudit } from "@/services/audit";
import { afterCatalogChange } from "@/services/revalidate";
import { getSetting, saveSetting, settingSchemas, type SettingKey } from "@/services/settings";
import { escapeLike, idParam, listQuery, withinDates } from "./helpers";
import { toAdminDto } from "./presenter";

export const settingsRouter = Router();

/* ------------------------------------------------------------------ */
/* Business settings                                                   */
/* ------------------------------------------------------------------ */

const SETTING_KEYS = Object.keys(settingSchemas) as SettingKey[];

settingsRouter.get("/settings", requirePermission("settings:view"), async (_req, res) => {
  const entries = await Promise.all(SETTING_KEYS.map(async (key) => [key, await getSetting(key)] as const));
  res.json(Object.fromEntries(entries));
});

settingsRouter.put("/settings/:key", requirePermission("settings:manage"), async (req, res) => {
  const key = String(req.params.key) as SettingKey;
  if (!SETTING_KEYS.includes(key)) throw notFound();
  const value = parse(settingSchemas[key], req.body);
  const actor = actorOf(req);

  await db().transaction(async (tx) => {
    if (key === "inventory") {
      const inventory = value as Awaited<ReturnType<typeof getSetting<"inventory">>>;
      const ids = [...new Set([inventory.defaultLocationId, inventory.onlineFulfilmentLocationId])];
      const found = await tx.select({ id: stockLocations.id }).from(stockLocations).where(and(inArray(stockLocations.id, ids), eq(stockLocations.active, true)));
      if (found.length !== ids.length) throw invalid({ onlineFulfilmentLocationId: "Choose active stock locations." });
    }
    const before = await getSetting(key, tx);
    await saveSetting(tx, key, value, actor.name);
    const changes = diff(before as Record<string, unknown>, value as Record<string, unknown>);
    if (changes.changed) {
      await recordAudit(tx, actor, { module: "settings", action: `settings.${key}_update`, entityType: "settings", entityId: key, entityLabel: key, ...changes, sensitive: true });
    }
  });
  if (key === "commerce" || key === "inventory") afterCatalogChange();
  res.json(await getSetting(key));
});

/* ------------------------------------------------------------------ */
/* Admin users                                                         */
/* ------------------------------------------------------------------ */

async function listUsers() {
  return db()
    .select({
      id: adminUsers.id,
      name: adminUsers.name,
      email: adminUsers.email,
      mobile: adminUsers.mobile,
      roleId: adminUsers.roleId,
      roleName: roles.name,
      status: adminUsers.status,
      lastLoginAt: adminUsers.lastLoginAt,
      createdAt: adminUsers.createdAt,
    })
    .from(adminUsers)
    .innerJoin(roles, eq(roles.id, adminUsers.roleId))
    .orderBy(asc(adminUsers.name));
}

settingsRouter.get("/users", requirePermission("settings:manage_users"), async (_req, res) => {
  res.json(await listUsers());
});

async function assertRole(tx: Executor, roleId: string) {
  const [role] = await tx.select().from(roles).where(eq(roles.id, roleId)).limit(1);
  if (!role) throw invalid({ roleId: "Choose an existing role." });
  return role;
}

settingsRouter.post("/users", requirePermission("settings:manage_users"), async (req, res) => {
  const input = parse(z.object({ name: zText(120), email: zEmail, mobile: zMobile.nullable().optional(), roleId: z.string().min(1).max(40), password: zPassword }), req.body);
  const actor = actorOf(req);
  await assertRole(db(), input.roleId);
  const [existing] = await db().select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.email, input.email)).limit(1);
  if (existing) throw invalid({ email: "A team member with this email already exists." });

  // The identity provider owns the password; our table holds the role and profile.
  const identity = await auth().createUser({ email: input.email, password: input.password });
  const [user] = await db().transaction(async (tx) => {
    const created = await tx
      .insert(adminUsers)
      .values({ authUserId: identity.userId, name: input.name, email: input.email, mobile: input.mobile ?? null, roleId: input.roleId })
      .returning();
    await recordAudit(tx, actor, { module: "settings", action: "user.create", entityType: "admin_user", entityId: created[0]!.id, entityLabel: input.email, after: { name: input.name, roleId: input.roleId }, sensitive: true });
    return created;
  });
  res.status(201).json({ ...user, authUserId: undefined });
});

/** Keeps at least one active Super Admin so the business can never lock itself out. */
async function assertKeepsSuperAdmin(tx: Tx, current: typeof adminUsers.$inferSelect, next: { roleId: string; status: string }) {
  const losesSuperAdmin = current.roleId === SUPER_ADMIN_ROLE && current.status === "active" && (next.roleId !== SUPER_ADMIN_ROLE || next.status !== "active");
  if (!losesSuperAdmin) return;
  const [others] = await tx
    .select({ value: count() })
    .from(adminUsers)
    .where(and(eq(adminUsers.roleId, SUPER_ADMIN_ROLE), eq(adminUsers.status, "active"), ne(adminUsers.id, current.id)));
  if ((others?.value ?? 0) === 0) throw new AppError("validation_error", "At least one active Super Admin is required.");
}

settingsRouter.patch("/users/:id", requirePermission("settings:manage_users"), async (req, res) => {
  const id = idParam(req);
  const patch = parse(
    z.object({ name: zText(120).optional(), mobile: zMobile.nullable().optional(), roleId: z.string().min(1).max(40).optional(), status: z.enum(["active", "disabled"]).optional() }),
    req.body,
  );
  const admin = adminOf(req);
  const actor = actorOf(req);
  if (id === admin.id && patch.status === "disabled") throw invalid({ status: "You can't disable your own account." });

  await db().transaction(async (tx) => {
    const [current] = await tx.select().from(adminUsers).where(eq(adminUsers.id, id)).for("update");
    if (!current) throw notFound();
    if (patch.roleId) await assertRole(tx, patch.roleId);
    await assertKeepsSuperAdmin(tx, current, { roleId: patch.roleId ?? current.roleId, status: patch.status ?? current.status });
    const [updated] = await tx
      .update(adminUsers)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(adminUsers.id, id))
      .returning();
    const changes = diff(current, updated!);
    if (changes.changed) {
      await recordAudit(tx, actor, { module: "settings", action: "user.update", entityType: "admin_user", entityId: id, entityLabel: current.email, ...changes, sensitive: "roleId" in changes.after || "status" in changes.after });
    }
  });
  res.json((await listUsers()).find((user) => user.id === id));
});

settingsRouter.post("/users/:id/password", requirePermission("settings:manage_users"), async (req, res) => {
  const id = idParam(req);
  const { password } = parse(z.object({ password: zPassword }), req.body);
  const [user] = await db().select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1);
  if (!user) throw notFound();
  await auth().setPassword(user.authUserId, password);
  await recordAudit(db(), actorOf(req), { module: "settings", action: "user.password_reset", entityType: "admin_user", entityId: id, entityLabel: user.email, sensitive: true });
  res.status(204).end();
});

/* ------------------------------------------------------------------ */
/* Roles & permissions                                                 */
/* ------------------------------------------------------------------ */

const permissionsSchema = z
  .array(z.string().max(60))
  .max(ALL_PERMISSIONS.length)
  .transform((values, ctx) => {
    const unknown = values.filter((value) => !isPermission(value));
    if (unknown.length) ctx.addIssue({ code: "custom", message: `Unknown permissions: ${unknown.join(", ")}` });
    return [...new Set(values.filter(isPermission))];
  });

async function listRoles() {
  const rows = await db().select().from(roles).orderBy(asc(roles.name));
  const grants = await db().select().from(rolePermissions);
  const usage = await db().select({ roleId: adminUsers.roleId, value: count() }).from(adminUsers).groupBy(adminUsers.roleId);
  return rows.map((role) => ({
    ...role,
    permissions: role.id === SUPER_ADMIN_ROLE ? ALL_PERMISSIONS : grants.filter((g) => g.roleId === role.id).map((g) => g.permission),
    userCount: usage.find((u) => u.roleId === role.id)?.value ?? 0,
  }));
}

settingsRouter.get("/roles", requirePermission("settings:manage_users"), async (_req, res) => {
  res.json({ roles: await listRoles(), permissionGroups });
});

settingsRouter.post("/roles", requirePermission("settings:manage_users"), async (req, res) => {
  const input = parse(
    z.object({
      id: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z][a-z0-9_]{2,39}$/, { error: "Use 3–40 lowercase letters, numbers or underscores." }),
      name: zText(60),
      description: z.string().trim().max(300).default(""),
      permissions: permissionsSchema,
    }),
    req.body,
  );
  const actor = actorOf(req);
  await db().transaction(async (tx) => {
    const [existing] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, input.id)).limit(1);
    if (existing) throw invalid({ id: "A role with this code already exists." });
    await tx.insert(roles).values({ id: input.id, name: input.name, description: input.description, isSystem: false });
    if (input.permissions.length) await tx.insert(rolePermissions).values(input.permissions.map((permission) => ({ roleId: input.id, permission })));
    await recordAudit(tx, actor, { module: "settings", action: "role.create", entityType: "role", entityId: input.id, entityLabel: input.name, after: { permissions: input.permissions }, sensitive: true });
  });
  res.status(201).json((await listRoles()).find((role) => role.id === input.id));
});

settingsRouter.patch("/roles/:id", requirePermission("settings:manage_users"), async (req, res) => {
  const id = String(req.params.id);
  const patch = parse(z.object({ name: zText(60).optional(), description: z.string().trim().max(300).optional(), permissions: permissionsSchema.optional() }), req.body);
  const actor = actorOf(req);
  await db().transaction(async (tx) => {
    const [current] = await tx.select().from(roles).where(eq(roles.id, id)).for("update");
    if (!current) throw notFound();
    if (id === SUPER_ADMIN_ROLE && patch.permissions) throw invalid({ permissions: "The Super Admin role always has every permission." });
    const before = (await tx.select().from(rolePermissions).where(eq(rolePermissions.roleId, id))).map((g) => g.permission);
    await tx
      .update(roles)
      .set({ ...(patch.name ? { name: patch.name } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}), updatedAt: new Date() })
      .where(eq(roles.id, id));
    if (patch.permissions) {
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
      if (patch.permissions.length) await tx.insert(rolePermissions).values(patch.permissions.map((permission) => ({ roleId: id, permission })));
    }
    await recordAudit(tx, actor, {
      module: "settings",
      action: "role.update",
      entityType: "role",
      entityId: id,
      entityLabel: patch.name ?? current.name,
      before: { name: current.name, permissions: before },
      after: { name: patch.name ?? current.name, ...(patch.permissions ? { permissions: patch.permissions } : {}) },
      sensitive: Boolean(patch.permissions),
    });
  });
  res.json((await listRoles()).find((role) => role.id === id));
});

settingsRouter.delete("/roles/:id", requirePermission("settings:manage_users"), async (req, res) => {
  const id = String(req.params.id);
  const actor = actorOf(req);
  await db().transaction(async (tx) => {
    const [current] = await tx.select().from(roles).where(eq(roles.id, id)).for("update");
    if (!current) throw notFound();
    if (current.isSystem) throw new AppError("validation_error", "Built-in roles can't be deleted. Adjust their permissions instead.");
    const [users] = await tx.select({ value: count() }).from(adminUsers).where(eq(adminUsers.roleId, id));
    if ((users?.value ?? 0) > 0) throw new AppError("validation_error", "Move this role's team members to another role first.");
    await tx.delete(roles).where(eq(roles.id, id));
    await recordAudit(tx, actor, { module: "settings", action: "role.delete", entityType: "role", entityId: id, entityLabel: current.name, sensitive: true });
  });
  res.status(204).end();
});

/* ------------------------------------------------------------------ */
/* Audit log                                                           */
/* ------------------------------------------------------------------ */

settingsRouter.get("/audit-logs", requirePermission("audit:view"), async (req, res) => {
  const query = parse(
    listQuery.extend({
      module: z.string().max(40).optional(),
      action: z.string().max(80).optional(),
      actorAdminId: zUuid.optional(),
      entityType: z.string().max(40).optional(),
      entityId: z.string().max(80).optional(),
      sensitive: zBoolQuery,
      from: zDate.optional(),
      to: zDate.optional(),
    }),
    req.query,
  );
  const conditions: (SQL | undefined)[] = [
    query.module ? eq(auditLogs.module, query.module) : undefined,
    query.action ? eq(auditLogs.action, query.action) : undefined,
    query.actorAdminId ? eq(auditLogs.actorAdminId, query.actorAdminId) : undefined,
    query.entityType ? eq(auditLogs.entityType, query.entityType) : undefined,
    query.entityId ? eq(auditLogs.entityId, query.entityId) : undefined,
    query.sensitive !== undefined ? eq(auditLogs.sensitive, query.sensitive) : undefined,
    ...withinDates(auditLogs.createdAt, query.from, query.to),
    query.q
      ? or(
          ilike(auditLogs.entityLabel, `%${escapeLike(query.q)}%`),
          ilike(auditLogs.actorName, `%${escapeLike(query.q)}%`),
          ilike(auditLogs.action, `%${escapeLike(query.q)}%`),
        )
      : undefined,
  ];
  const where = and(...conditions);
  const rows = await db()
    .select()
    .from(auditLogs)
    .where(where)
    .orderBy(desc(auditLogs.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [total] = await db().select({ value: count() }).from(auditLogs).where(where);
  res.json(paginated(rows, total?.value ?? 0, query.page, query.pageSize));
});

/* ------------------------------------------------------------------ */
/* My profile                                                          */
/* ------------------------------------------------------------------ */

settingsRouter.get("/profile", async (req, res) => {
  const admin = adminOf(req);
  const [user] = await db().select().from(adminUsers).where(eq(adminUsers.id, admin.id)).limit(1);
  res.json({ ...toAdminDto(admin), mobile: user?.mobile ?? null, lastLoginAt: user?.lastLoginAt ?? null });
});

settingsRouter.patch("/profile", async (req, res) => {
  const admin = adminOf(req);
  const patch = parse(z.object({ name: zText(120).optional(), mobile: zMobile.nullable().optional() }), req.body);
  await db()
    .update(adminUsers)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(adminUsers.id, admin.id));
  await recordAudit(db(), actorOf(req), { module: "settings", action: "profile.update", entityType: "admin_user", entityId: admin.id, entityLabel: admin.email, after: patch });
  const [user] = await db().select().from(adminUsers).where(eq(adminUsers.id, admin.id)).limit(1);
  res.json({ ...toAdminDto({ ...admin, name: user!.name }), mobile: user!.mobile, lastLoginAt: user!.lastLoginAt });
});

settingsRouter.post("/profile/password", async (req, res) => {
  const admin = adminOf(req);
  const { currentPassword, newPassword } = parse(z.object({ currentPassword: z.string().min(1).max(200), newPassword: zPassword }), req.body);
  await auth().changePassword(req.identity!, currentPassword, newPassword);
  await recordAudit(db(), actorOf(req), { module: "settings", action: "profile.password_change", entityType: "admin_user", entityId: admin.id, entityLabel: admin.email, sensitive: true });
  res.status(204).end();
});
