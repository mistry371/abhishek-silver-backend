import type { Permission } from "@/auth/permissions";
import type { Executor } from "@/db/client";
import { notifications, type NotificationType } from "@/db/schema";

export async function notify(
  executor: Executor,
  input: { type: NotificationType; title: string; body: string; href?: string; permission: Permission },
) {
  await executor.insert(notifications).values({
    type: input.type,
    title: input.title,
    body: input.body,
    href: input.href ?? null,
    permission: input.permission,
  });
}
