import type { AdminRole } from "@/generated/prisma/enums";

/** Same permission keys as asl-admin `team-store`. */
export const PERMISSIONS = [
  "orders.view", "orders.edit", "orders.refund",
  "concierge.view", "concierge.assign", "concierge.quote",
  "catalog.view", "catalog.edit", "catalog.publish",
  "inventory.adjust",
  "customers.view", "customers.edit", "customers.wallet",
  "marketing.manage", "content.publish",
  "finance.view", "finance.payouts", "finance.ledger",
  "analytics.view",
  "support.tickets", "support.reply",
  "team.manage", "settings.manage", "integrations.manage", "audit.view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Default role → permissions (mirrors asl-admin ROLE_PERMISSIONS). */
export const ROLE_PERMISSIONS: Record<AdminRole, Permission[]> = {
  super_admin: [...PERMISSIONS],
  ops_manager: [
    "orders.view", "orders.edit", "orders.refund", "concierge.view", "concierge.assign", "concierge.quote",
    "catalog.view", "inventory.adjust", "customers.view", "customers.edit", "analytics.view", "support.tickets", "support.reply",
  ],
  catalog_manager: ["catalog.view", "catalog.edit", "catalog.publish", "inventory.adjust", "analytics.view"],
  concierge_agent: [
    "concierge.view", "concierge.assign", "concierge.quote", "customers.view", "orders.view", "support.tickets", "support.reply",
  ],
  support: ["orders.view", "customers.view", "support.tickets", "support.reply", "concierge.view"],
  marketing: ["marketing.manage", "content.publish", "customers.view", "analytics.view"],
  finance: ["orders.view", "finance.view", "finance.payouts", "finance.ledger", "analytics.view"],
  content_editor: ["content.publish", "catalog.view"],
  analyst: ["analytics.view", "orders.view", "customers.view", "catalog.view", "finance.view"],
};

export const ROLE_LABELS: Record<AdminRole, string> = {
  super_admin: "Super Admin",
  ops_manager: "Operations Manager",
  catalog_manager: "Catalog Manager",
  concierge_agent: "Concierge Agent",
  support: "Customer Support",
  marketing: "Marketing",
  finance: "Finance",
  content_editor: "Content Editor",
  analyst: "Analyst",
};
