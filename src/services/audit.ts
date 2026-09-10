import type { Request } from "express";
import type { Executor } from "@/db/client";
import { auditLogs } from "@/db/schema";

export interface Actor {
  adminId: string | null;
  name: string;
  role: string | null;
  ip: string | null;
  userAgent: string | null;
}

export const SYSTEM_ACTOR: Actor = { adminId: null, name: "System", role: null, ip: null, userAgent: null };

export function actorOf(req: Request): Actor {
  return {
    adminId: req.admin?.id ?? null,
    name: req.admin?.name ?? "System",
    role: req.admin?.roleName ?? null,
    ip: req.ip ?? null,
    userAgent: req.get("user-agent")?.slice(0, 300) ?? null,
  };
}

export interface AuditEntry {
  module: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  entityLabel?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  reference?: string | null;
  sensitive?: boolean;
}

/** Keeps only the fields that changed, so audit entries stay readable. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "updatedAt") continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changedBefore[key] = before[key];
      changedAfter[key] = after[key];
    }
  }
  return { before: changedBefore, after: changedAfter, changed: Object.keys(changedAfter).length > 0 };
}

export async function recordAudit(executor: Executor, actor: Actor, entry: AuditEntry) {
  await executor.insert(auditLogs).values({
    actorAdminId: actor.adminId,
    actorName: actor.name,
    actorRole: actor.role,
    ipAddress: actor.ip,
    userAgent: actor.userAgent,
    module: entry.module,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    entityLabel: entry.entityLabel ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
    reference: entry.reference ?? null,
    sensitive: entry.sensitive ?? false,
  });
}
