import type { AdminContext } from "@/http/context";

export function toAdminDto(admin: AdminContext) {
  return {
    id: admin.id,
    name: admin.name,
    email: admin.email,
    roleId: admin.roleId,
    roleName: admin.roleName,
    permissions: [...admin.permissions].sort(),
  };
}
