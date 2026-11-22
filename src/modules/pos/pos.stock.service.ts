import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { nextSequence } from "@/core/utils/sequence";
import { inventoryService } from "@/modules/inventory/inventory.service";
import type {
  AdjustStockBody,
  CreateGrnBody,
  CreateStockCountBody,
  CreateTransferBody,
  ReceiveGrnBody,
  TransferStepBody,
} from "./pos.schemas";

type Staff = { id: string; name: string };

type CountLine = { variantId: string; expected: number; counted: number };
type GrnLine = { variantId: string; qty: number; received: number };
type Step = { status: string; at: string; by: string; note?: string };

export const posStockService = {
  async adjust(body: AdjustStockBody, staff: Staff) {
    const v = await prisma.productVariant.findUnique({ where: { id: body.variantId } });
    if (!v) throw ApiError.notFound("Variant");
    await inventoryService.adjust(
      { sku: v.sku, warehouseId: body.warehouseId, delta: body.delta, note: body.reason, type: "adjust" },
      staff.name,
    );
    await prisma.posAuditEvent.create({
      data: {
        staffId: staff.id,
        action: "stock",
        text: `${staff.name} adjusted ${v.sku} by ${body.delta > 0 ? "+" : ""}${body.delta} (${body.reason})`,
        ref: v.sku,
      },
    });
    return { variantId: body.variantId, warehouseId: body.warehouseId, delta: body.delta };
  },

  async listTransfers(q: { page: number; pageSize: number; warehouseId?: string; status?: string }) {
    const where = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.warehouseId
        ? { OR: [{ fromWarehouseId: q.warehouseId }, { toWarehouseId: q.warehouseId }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.posStockTransfer.findMany({ where, orderBy: { createdAt: "desc" }, ...paging(q) }),
      prisma.posStockTransfer.count({ where }),
    ]);
    return withMeta(rows, pageMeta(q, total));
  },

  async requestTransfer(body: CreateTransferBody, staff: Staff) {
    if (body.fromWarehouseId === body.toWarehouseId) {
      throw ApiError.badRequest("VALIDATION_FAILED", "Choose two different warehouses.");
    }
    const v = await prisma.productVariant.findUnique({ where: { id: body.variantId } });
    if (!v) throw ApiError.notFound("Variant");
    const number = await prisma.$transaction(async (tx) => `TR-${await nextSequence(tx, "pos_transfer", 500)}`);
    const step: Step = { status: "requested", at: new Date().toISOString(), by: staff.name };
    return prisma.posStockTransfer.create({
      data: {
        number,
        fromWarehouseId: body.fromWarehouseId,
        toWarehouseId: body.toWarehouseId,
        variantId: body.variantId,
        qty: body.qty,
        requestedById: staff.id,
        reason: body.reason,
        steps: [step] as unknown as Prisma.InputJsonValue,
      },
    });
  },

  async stepTransfer(id: string, body: TransferStepBody, staff: Staff) {
    const t = await prisma.posStockTransfer.findUnique({ where: { id } });
    if (!t) throw ApiError.notFound("Transfer");
    const allowed: Record<string, string[]> = {
      requested: ["approved", "rejected"],
      approved: ["in-transit", "rejected"],
      "in-transit": ["received"],
    };
    if (!(allowed[t.status] ?? []).includes(body.status)) {
      throw ApiError.conflict("INVALID_STATE", `Can't move a ${t.status} transfer to ${body.status}.`);
    }

    const variantSku = (await prisma.productVariant.findUniqueOrThrow({ where: { id: t.variantId } })).sku;
    const steps = (Array.isArray(t.steps) ? t.steps : []) as Step[];
    steps.push({ status: body.status, at: new Date().toISOString(), by: staff.name, note: body.note });

    if (body.status === "in-transit") {
      const level = await prisma.stockLevel.findUnique({
        where: { variantId_warehouseId: { variantId: t.variantId, warehouseId: t.fromWarehouseId } },
      });
      const free = level ? level.onHand - level.reserved : 0;
      if (free < t.qty) throw ApiError.conflict("OUT_OF_STOCK", "Not enough free stock to ship this transfer.");
      await inventoryService.adjust(
        { sku: variantSku, warehouseId: t.fromWarehouseId, delta: -t.qty, note: `Transfer ${t.number} shipped`, type: "adjust" },
        staff.name,
      );
    }

    if (body.status === "received") {
      await inventoryService.adjust(
        { sku: variantSku, warehouseId: t.toWarehouseId, delta: t.qty, note: `Transfer ${t.number} received`, type: "receive" },
        staff.name,
      );
    }

    return prisma.posStockTransfer.update({
      where: { id },
      data: { status: body.status, steps: steps as unknown as Prisma.InputJsonValue },
    });
  },

  async createCount(body: CreateStockCountBody, staff: Staff) {
    const number = await prisma.$transaction(async (tx) => `SC-${await nextSequence(tx, "pos_count", 100)}`);
    return prisma.posStockCount.create({
      data: {
        number,
        warehouseId: body.warehouseId,
        staffId: staff.id,
        scope: body.scope,
        lines: body.lines as unknown as Prisma.InputJsonValue,
        status: "open",
      },
    });
  },

  async postCount(id: string, staff: Staff, approvedById?: string) {
    const c = await prisma.posStockCount.findUnique({ where: { id } });
    if (!c) throw ApiError.notFound("Stock count");
    if (c.status === "posted") throw ApiError.conflict("INVALID_STATE", "Count already posted.");
    const lines = (Array.isArray(c.lines) ? c.lines : []) as CountLine[];
    for (const line of lines) {
      const delta = line.counted - line.expected;
      if (!delta) continue;
      const v = await prisma.productVariant.findUniqueOrThrow({ where: { id: line.variantId } });
      await inventoryService.adjust({
        sku: v.sku,
        warehouseId: c.warehouseId,
        delta,
        note: `Stock count ${c.number}`,
        type: "adjust",
      }, staff.name);
    }
    return prisma.posStockCount.update({
      where: { id },
      data: { status: "posted", approvedById: approvedById ?? staff.id },
    });
  },

  async listCounts(q: { page: number; pageSize: number; warehouseId?: string }) {
    const where = q.warehouseId ? { warehouseId: q.warehouseId } : {};
    const [rows, total] = await Promise.all([
      prisma.posStockCount.findMany({ where, orderBy: { at: "desc" }, ...paging(q) }),
      prisma.posStockCount.count({ where }),
    ]);
    return withMeta(rows, pageMeta(q, total));
  },

  async createGrn(body: CreateGrnBody) {
    const number = await prisma.$transaction(async (tx) => `GRN-${await nextSequence(tx, "pos_grn", 100)}`);
    return prisma.posGoodsReceipt.create({
      data: {
        number,
        supplier: body.supplier,
        warehouseId: body.warehouseId,
        expectedAt: new Date(body.expectedAt),
        lines: body.lines as unknown as Prisma.InputJsonValue,
        status: "expected",
      },
    });
  },

  async receiveGrn(id: string, body: ReceiveGrnBody, staff: Staff) {
    const g = await prisma.posGoodsReceipt.findUnique({ where: { id } });
    if (!g) throw ApiError.notFound("Goods receipt");
    if (g.status === "received") throw ApiError.conflict("INVALID_STATE", "Already fully received.");
    const existing = (Array.isArray(g.lines) ? g.lines : []) as GrnLine[];
    const byId = new Map(body.lines.map((l) => [l.variantId, l.received]));
    const next = existing.map((l) => ({
      ...l,
      received: byId.has(l.variantId) ? byId.get(l.variantId)! : l.received,
    }));
    for (const line of next) {
      const prev = existing.find((x) => x.variantId === line.variantId)?.received ?? 0;
      const add = line.received - prev;
      if (add <= 0) continue;
      const v = await prisma.productVariant.findUniqueOrThrow({ where: { id: line.variantId } });
      await inventoryService.adjust({
        sku: v.sku,
        warehouseId: g.warehouseId,
        delta: add,
        note: `GRN ${g.number}`,
        type: "receive",
      }, staff.name);
    }
    const complete = next.every((l) => l.received >= l.qty);
    const partial = next.some((l) => l.received > 0);
    return prisma.posGoodsReceipt.update({
      where: { id },
      data: {
        lines: next as unknown as Prisma.InputJsonValue,
        status: complete ? "received" : partial ? "partial" : "expected",
        receivedAt: complete || partial ? new Date() : g.receivedAt,
        receivedById: staff.id,
      },
    });
  },

  async listGrn(q: { page: number; pageSize: number; warehouseId?: string; status?: string }) {
    const where = {
      ...(q.warehouseId ? { warehouseId: q.warehouseId } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.posGoodsReceipt.findMany({ where, orderBy: { expectedAt: "desc" }, ...paging(q) }),
      prisma.posGoodsReceipt.count({ where }),
    ]);
    return withMeta(rows, pageMeta(q, total));
  },
};
