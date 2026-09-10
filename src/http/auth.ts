import type { NextFunction, Request, RequestHandler, Response } from "express";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { ALL_PERMISSIONS, isPermission, SUPER_ADMIN_ROLE, type Permission } from "@/auth/permissions";
import type { AuthIdentity } from "@/auth/types";
import { db } from "@/db/client";
import { adminUsers, customers, rolePermissions, roles } from "@/db/schema";
import { AppError, forbidden, unauthorized } from "@/lib/errors";
import { createCustomerRecord } from "@/services/customers";
import type { AdminContext } from "./context";

export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

async function authenticate(req: Request): Promise<AuthIdentity | null> {
  if (req.identity) return req.identity;
  const token = bearerToken(req);
  if (!token) return null;
  const identity = await auth().verifyAccessToken(token);
  req.accessToken = token;
  req.identity = identity;
  return identity;
}

/** Finds (or lazily creates) the customer profile for an authenticated identity. */
export async function loadCustomer(identity: AuthIdentity) {
  const [existing] = await db().select().from(customers).where(eq(customers.authUserId, identity.userId)).limit(1);
  if (existing) return existing;
  return createCustomerRecord(db(), {
    authUserId: identity.userId,
    firstName: "Customer",
    lastName: "",
    email: identity.email,
    phone: identity.phone,
    source: "website",
  });
}

export const requireCustomer: RequestHandler = async (req, _res, next) => {
  const identity = await authenticate(req);
  if (!identity) throw unauthorized();
  const customer = await loadCustomer(identity);
  if (customer.status === "blocked") throw forbidden("This account is unavailable. Please contact the store.");
  req.customer = customer;
  next();
};

/**
 * Attaches the customer when a valid token is sent. With `strict`, a present
 * but expired/invalid token is an error (checkout) instead of silently
 * falling back to a guest (enquiries, cart quotes).
 */
export function optionalCustomer({ strict = false } = {}): RequestHandler {
  return async (req, _res, next) => {
    try {
      const identity = await authenticate(req);
      if (identity) {
        const customer = await loadCustomer(identity);
        if (customer.status !== "blocked") req.customer = customer;
      }
    } catch (error) {
      if (strict) throw error;
      req.identity = undefined;
    }
    next();
  };
}

export async function loadAdminContext(identity: AuthIdentity): Promise<AdminContext> {
  const [row] = await db()
    .select({ admin: adminUsers, roleName: roles.name })
    .from(adminUsers)
    .innerJoin(roles, eq(roles.id, adminUsers.roleId))
    .where(eq(adminUsers.authUserId, identity.userId))
    .limit(1);
  if (!row) throw forbidden("This account does not have admin access.");
  if (row.admin.status !== "active") throw forbidden("This admin account is disabled.");

  let permissions: Permission[];
  if (row.admin.roleId === SUPER_ADMIN_ROLE) {
    permissions = ALL_PERMISSIONS;
  } else {
    const grants = await db().select({ permission: rolePermissions.permission }).from(rolePermissions).where(eq(rolePermissions.roleId, row.admin.roleId));
    permissions = grants.map((grant) => grant.permission).filter(isPermission);
  }

  return {
    id: row.admin.id,
    authUserId: row.admin.authUserId,
    name: row.admin.name,
    email: row.admin.email,
    roleId: row.admin.roleId,
    roleName: row.roleName,
    permissions: new Set(permissions),
  };
}

export const requireAdmin: RequestHandler = async (req, _res, next) => {
  const identity = await authenticate(req);
  if (!identity) throw unauthorized();
  req.admin = await loadAdminContext(identity);
  next();
};

export function adminOf(req: Request): AdminContext {
  if (!req.admin) throw unauthorized();
  return req.admin;
}

export const can = (req: Request, permission: Permission) => Boolean(req.admin?.permissions.has(permission));

/** Requires every listed permission. */
export function requirePermission(...permissions: Permission[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const admin = adminOf(req);
    if (!permissions.every((permission) => admin.permissions.has(permission))) throw forbidden();
    next();
  };
}

/** Requires at least one of the listed permissions. */
export function requireAnyPermission(...permissions: Permission[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const admin = adminOf(req);
    if (!permissions.some((permission) => admin.permissions.has(permission))) throw forbidden();
    next();
  };
}

export function assertPermission(req: Request, permission: Permission) {
  if (!can(req, permission)) throw new AppError("forbidden");
}
