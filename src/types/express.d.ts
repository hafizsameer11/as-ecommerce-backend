import type { AdminRole } from "@/generated/prisma/enums";
import type { Permission } from "@/core/auth/permissions";

declare global {
  namespace Express {
    interface Request {
      id: string;
      customer?: { id: string; sessionId: string };
      admin?: { id: string; sessionId: string; role: AdminRole; name: string; email: string; permissions: Set<Permission> };
      /** validated input (set by `validate`) */
      valid: { body: any; query: any; params: any };
      /** anonymous device id sent by the apps (X-Anon-Id), used for guest carts / analytics */
      anonId?: string;
    }
  }
}
export {};
