import type { AuthIdentity } from "@/auth/types";
import type { Permission } from "@/auth/permissions";
import type { customers } from "@/db/schema";

export interface AdminContext {
  id: string;
  authUserId: string;
  name: string;
  email: string;
  roleId: string;
  roleName: string;
  permissions: ReadonlySet<Permission>;
}

export type CustomerRow = typeof customers.$inferSelect;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      accessToken?: string;
      identity?: AuthIdentity;
      customer?: CustomerRow;
      admin?: AdminContext;
      rawBody?: Buffer;
    }
  }
}
