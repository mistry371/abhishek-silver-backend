import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "@/db/client";
import { notificationReads, notifications } from "@/db/schema";
import { adminOf } from "@/http/auth";
import { parse, zBoolQuery } from "@/lib/validation";
import { idParam } from "./helpers";

export const notificationsRouter = Router();

/** Staff only see notifications for modules they have permission to view. */
notificationsRouter.get("/notifications", async (req, res) => {
  const admin = adminOf(req);
  const { unread, limit } = parse(z.object({ unread: zBoolQuery, limit: z.coerce.number().int().min(1).max(100).default(30) }), req.query);
  const permissions = [...admin.permissions];
  const visible = inArray(notifications.permission, permissions.length ? permissions : ["__none__"]);

  const rows = await db()
    .select({
      id: notifications.id,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      href: notifications.href,
      createdAt: notifications.createdAt,
      readAt: notificationReads.readAt,
    })
    .from(notifications)
    .leftJoin(notificationReads, and(eq(notificationReads.notificationId, notifications.id), eq(notificationReads.adminUserId, admin.id)))
    .where(unread ? and(visible, isNull(notificationReads.readAt)) : visible)
    .orderBy(desc(notifications.createdAt))
    .limit(limit);

  const [unreadRow] = await db()
    .select({ value: sql<number>`count(*)`.mapWith(Number) })
    .from(notifications)
    .leftJoin(notificationReads, and(eq(notificationReads.notificationId, notifications.id), eq(notificationReads.adminUserId, admin.id)))
    .where(and(visible, isNull(notificationReads.readAt)));

  res.json({ items: rows.map((row) => ({ ...row, read: Boolean(row.readAt) })), unreadCount: unreadRow?.value ?? 0 });
});

notificationsRouter.post("/notifications/:id/read", async (req, res) => {
  const admin = adminOf(req);
  await db().insert(notificationReads).values({ notificationId: idParam(req), adminUserId: admin.id }).onConflictDoNothing();
  res.status(204).end();
});

notificationsRouter.post("/notifications/read-all", async (req, res) => {
  const admin = adminOf(req);
  const permissions = [...admin.permissions];
  if (permissions.length) {
    await db().execute(sql`
      insert into ${notificationReads} (notification_id, admin_user_id)
      select ${notifications.id}, ${admin.id}::uuid from ${notifications}
      where ${inArray(notifications.permission, permissions)}
      on conflict do nothing
    `);
  }
  res.status(204).end();
});
