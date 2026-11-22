import type { AdminRole } from "@/generated/prisma/enums";

/** Same permission keys as asl-admin `team-store`, plus POS. */
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
  "pos.sell", "pos.discount", "pos.price_override", "pos.refund", "pos.refund_no_receipt",
  "pos.void", "pos.cash_moves", "pos.open_close", "pos.stock_adjust", "pos.reports", "pos.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const POS_CASHIER: Permission[] = [
  "pos.sell", "pos.discount", "pos.open_close", "catalog.view", "customers.view", "customers.edit", "orders.view",
];
const POS_SUPERVISOR: Permission[] = [
  ...POS_CASHIER,
  "pos.price_override", "pos.refund", "pos.cash_moves", "pos.stock_adjust", "pos.reports",
  "inventory.adjust", "orders.refund",
];
const POS_MANAGER: Permission[] = [
  ...POS_SUPERVISOR,
  "pos.refund_no_receipt", "pos.void", "pos.manage", "customers.wallet", "analytics.view",
];

/** Default role → permissions (mirrors asl-admin ROLE_PERMISSIONS). */
export const ROLE_PERMISSIONS: Record<AdminRole, Permission[]> = {
  super_admin: [...PERMISSIONS],
  ops_manager: [
    "orders.view", "orders.edit", "orders.refund", "concierge.view", "concierge.assign", "concierge.quote",
    "catalog.view", "inventory.adjust", "customers.view", "customers.edit", "analytics.view", "support.tickets", "support.reply",
    ...POS_MANAGER,
  ],
  catalog_manager: ["catalog.view", "catalog.edit", "catalog.publish", "inventory.adjust", "analytics.view"],
  concierge_agent: [
    "concierge.view", "concierge.assign", "concierge.quote", "customers.view", "orders.view", "support.tickets", "support.reply",
  ],
  support: ["orders.view", "customers.view", "support.tickets", "support.reply", "concierge.view"],
  marketing: ["marketing.manage", "content.publish", "customers.view", "analytics.view"],
  finance: ["orders.view", "finance.view", "finance.payouts", "finance.ledger", "analytics.view", "pos.reports"],
  content_editor: ["content.publish", "catalog.view"],
  analyst: ["analytics.view", "orders.view", "customers.view", "catalog.view", "finance.view", "pos.reports"],
  store_manager: POS_MANAGER,
  store_supervisor: POS_SUPERVISOR,
  store_cashier: POS_CASHIER,
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
  store_manager: "Store Manager",
  store_supervisor: "Store Supervisor",
  store_cashier: "Cashier",
};

/** Discount % caps used by the till (mirrors POS prototype). */
export const POS_DISCOUNT_LIMITS: Record<"store_cashier" | "store_supervisor" | "store_manager", number> = {
  store_cashier: 10,
  store_supervisor: 25,
  store_manager: 100,
};
