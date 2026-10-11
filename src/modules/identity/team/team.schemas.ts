import { z } from "zod";
import { PERMISSIONS } from "@/core/auth/permissions";

export const adminRole = z.enum(["super_admin", "ops_manager", "catalog_manager", "concierge_agent", "support", "marketing", "finance", "content_editor", "analyst"]);

export const inviteBody = z.object({ name: z.string().trim().min(1).max(80), email: z.string().trim().toLowerCase().email(), role: adminRole });
export const memberPatch = z.object({ name: z.string().min(1).max(80).optional(), role: adminRole.optional(), status: z.enum(["active", "suspended"]).optional() });
export const roleParam = z.object({ role: adminRole });
export const rolePermissionsBody = z.object({ permissions: z.array(z.enum(PERMISSIONS)) });

export type InviteBody = z.infer<typeof inviteBody>;
export type MemberPatch = z.infer<typeof memberPatch>;
export type RoleParam = z.infer<typeof roleParam>;
export type RolePermissionsBody = z.infer<typeof rolePermissionsBody>;
