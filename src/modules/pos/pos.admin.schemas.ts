import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

const id = z.string().min(1).max(64);
const money = z.number().int().min(0);

export const adminTxQuery = pageQuery.extend({
  q: z.string().trim().max(120).optional(),
  locationId: id.optional(),
  registerId: id.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  fulfilment: z.enum(["instore", "ship", "layaway"]).optional(),
});

export const adminReportsQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  locationId: id.optional(),
});

export const adminSessionsQuery = pageQuery.extend({
  registerId: id.optional(),
  open: z.coerce.boolean().optional(),
});

export const adminAuditQuery = pageQuery.extend({
  locationId: id.optional(),
  action: z.string().max(32).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const adminRegisterBody = z.object({
  id: id.optional(),
  locationId: id,
  warehouseId: id,
  name: z.string().trim().min(1).max(80),
  device: z.string().trim().max(120).optional(),
  printer: z.string().trim().max(120).optional(),
  terminalId: z.string().trim().max(80).optional(),
  drawer: z.boolean().optional(),
  scanner: z.string().trim().max(120).optional(),
  active: z.boolean().optional(),
});

export const adminPromoBody = z.object({
  name: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  kind: z.enum(["bxgy", "percent", "spend", "birthday"]),
  buy: z.number().int().min(1).optional(),
  get: z.number().int().min(1).optional(),
  value: z.number().int(),
  minSpend: money.optional(),
  scope: z
    .object({
      type: z.enum(["all", "category", "brand"]),
      value: z.string().max(80).optional(),
    })
    .default({ type: "all" }),
  channels: z.array(z.string().max(16)).default(["pos", "store"]),
  stores: z.array(id).default([]),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  active: z.boolean().default(true),
});

export const adminPromoPatch = adminPromoBody.partial();

export const adminStockMovesQuery = pageQuery.extend({
  warehouseId: id.optional(),
});

export type AdminTxQuery = z.infer<typeof adminTxQuery>;
export type AdminReportsQuery = z.infer<typeof adminReportsQuery>;
export type AdminSessionsQuery = z.infer<typeof adminSessionsQuery>;
export type AdminAuditQuery = z.infer<typeof adminAuditQuery>;
export type AdminRegisterBody = z.infer<typeof adminRegisterBody>;
export type AdminPromoBody = z.infer<typeof adminPromoBody>;
export type AdminPromoPatch = z.infer<typeof adminPromoPatch>;
export type AdminStockMovesQuery = z.infer<typeof adminStockMovesQuery>;
