import { z } from "zod";

export const stockListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(50),
  q: z.string().optional(), warehouse: z.string().optional(), state: z.enum(["in", "low", "out"]).optional(),
});
export const adjustBody = z.object({
  sku: z.string(), warehouseId: z.string(), delta: z.number().int().refine((n) => n !== 0, "Use a non-zero amount"),
  note: z.string().min(1).max(300), type: z.enum(["adjust", "receive"]).optional(),
});
export const transferBody = z.object({ sku: z.string(), from: z.string(), to: z.string(), qty: z.number().int().positive(), note: z.string().max(300).default("") });
export const reorderPointBody = z.object({ sku: z.string(), warehouseId: z.string(), reorderPoint: z.number().int().min(0).max(100000) });
export const movementsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50),
  sku: z.string().optional(), type: z.string().optional(),
});

export const warehouseBody = z.object({ name: z.string().min(1).max(80), code: z.string().min(2).max(16).toUpperCase(), city: z.string().min(1).max(80) });
export const warehouseIdParam = z.object({ id: z.string() });
export const warehousePatch = z.object({ name: z.string().min(1).max(80).optional(), city: z.string().max(80).optional(), active: z.boolean().optional(), isDefault: z.boolean().optional() });

export type StockListQuery = z.infer<typeof stockListQuery>;
export type AdjustBody = z.infer<typeof adjustBody>;
export type TransferBody = z.infer<typeof transferBody>;
export type ReorderPointBody = z.infer<typeof reorderPointBody>;
export type MovementsQuery = z.infer<typeof movementsQuery>;
export type WarehouseBody = z.infer<typeof warehouseBody>;
export type WarehousePatch = z.infer<typeof warehousePatch>;
