import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { settingsService } from "@/modules/platform/settings/settings.service";
import type { CashMoveBody, CloseSessionBody, OpenSessionBody } from "./pos.schemas";

async function requireRegister(id: string) {
  const r = await prisma.posRegister.findUnique({ where: { id } });
  if (!r || !r.active) throw ApiError.notFound("Register");
  return r;
}

async function openSessionOf(registerId: string) {
  return prisma.posRegisterSession.findFirst({
    where: { registerId, closedAt: null },
    orderBy: { openedAt: "desc" },
  });
}

function sessionReport(session: { id: string; registerId: string; float: number; openedAt: Date; closedAt: Date | null; moves: { type: string; amount: number }[] }, orders: { total: number; changeGiven: number; payments: { method: string; amount: number }[]; returnsAmount: number }[]) {
  const byMethod: Record<string, number> = { cash: 0, card: 0, transfer: 0, wallet: 0, points: 0 };
  for (const o of orders) for (const p of o.payments) byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amount;
  const paidIn = session.moves.filter((m) => m.type === "in").reduce((a, m) => a + m.amount, 0);
  const paidOut = session.moves.filter((m) => m.type === "out").reduce((a, m) => a + m.amount, 0);
  const cashSales = byMethod.cash ?? 0;
  const change = orders.reduce((a, o) => a + o.changeGiven, 0);
  const refundCash = orders.reduce((a, o) => a + o.returnsAmount, 0);
  return {
    sales: orders.reduce((a, o) => a + o.total, 0),
    count: orders.length,
    byMethod,
    paidIn,
    paidOut,
    expectedCash: session.float + cashSales + paidIn - paidOut - change - refundCash,
  };
}

export const posSessionService = {
  async listRegisters(staffLocationIds: string[]) {
    const where = staffLocationIds.length ? { active: true, locationId: { in: staffLocationIds } } : { active: true };
    const rows = await prisma.posRegister.findMany({
      where,
      include: { warehouse: { select: { id: true, code: true, name: true } }, sessions: { where: { closedAt: null }, take: 1, orderBy: { openedAt: "desc" } } },
      orderBy: { name: "asc" },
    });
    const locs = await prisma.pickupLocation.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.locationId))] } },
      select: { id: true, name: true, city: true },
    });
    const locMap = new Map(locs.map((l) => [l.id, l]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      locationId: r.locationId,
      location: locMap.get(r.locationId) ?? null,
      warehouse: r.warehouse,
      device: r.device,
      terminalId: r.terminalId,
      online: r.online,
      lastSeenAt: r.lastSeenAt,
      openSession: r.sessions[0]
        ? { id: r.sessions[0].id, openedAt: r.sessions[0].openedAt, float: r.sessions[0].float, openedById: r.sessions[0].openedById }
        : null,
    }));
  },

  async open(registerId: string, body: OpenSessionBody, staff: { id: string; name: string }) {
    const reg = await requireRegister(registerId);
    const existing = await openSessionOf(registerId);
    if (existing) throw ApiError.conflict("INVALID_STATE", "This register already has an open session.");
    const cfg = await settingsService.get("pos");
    const session = await prisma.posRegisterSession.create({
      data: { registerId, openedById: staff.id, float: body.float ?? cfg.defaultFloat },
    });
    await prisma.posRegister.update({ where: { id: registerId }, data: { online: true, lastSeenAt: new Date() } });
    await prisma.posAuditEvent.create({
      data: {
        locationId: reg.locationId,
        registerId,
        sessionId: session.id,
        staffId: staff.id,
        action: "drawer",
        text: `${staff.name} opened ${reg.name} with float ₦${Math.round(session.float / 100).toLocaleString("en-NG")}`,
        amount: session.float,
      },
    });
    return session;
  },

  async cashMove(sessionId: string, body: CashMoveBody, staff: { id: string; name: string }) {
    const session = await prisma.posRegisterSession.findUnique({ where: { id: sessionId }, include: { register: true } });
    if (!session || session.closedAt) throw ApiError.notFound("Session");
    const move = await prisma.posCashMove.create({
      data: { sessionId, type: body.type, amount: body.amount, reason: body.reason, staffId: staff.id },
    });
    await prisma.posAuditEvent.create({
      data: {
        locationId: session.register.locationId,
        registerId: session.registerId,
        sessionId,
        staffId: staff.id,
        action: "cash",
        text: `${staff.name} cash ${body.type} ₦${Math.round(body.amount / 100).toLocaleString("en-NG")}: ${body.reason}`,
        amount: body.amount,
      },
    });
    return move;
  },

  async close(sessionId: string, body: CloseSessionBody, staff: { id: string; name: string }) {
    const session = await prisma.posRegisterSession.findUnique({
      where: { id: sessionId },
      include: { register: true, moves: true },
    });
    if (!session || session.closedAt) throw ApiError.notFound("Session");

    const orders = await prisma.order.findMany({
      where: { registerSessionId: sessionId, channel: "store" },
      include: { payments: true, returns: true },
    });
    const shaped = orders.map((o) => ({
      total: o.total,
      changeGiven: o.changeGiven,
      payments: o.payments.map((p) => ({ method: p.method, amount: p.amount })),
      returnsAmount: o.returns.reduce((a, r) => a + (r.refundAmount ?? 0), 0),
    }));
    const report = sessionReport(session, shaped);
    const closed = await prisma.posRegisterSession.update({
      where: { id: sessionId },
      data: {
        closedAt: new Date(),
        closedById: staff.id,
        counted: body.counted,
        expected: report.expectedCash,
        note: body.note,
      },
    });
    const diff = body.counted - report.expectedCash;
    await prisma.posAuditEvent.create({
      data: {
        locationId: session.register.locationId,
        registerId: session.registerId,
        sessionId,
        staffId: staff.id,
        action: "drawer",
        text: `${staff.name} closed ${session.register.name}. Expected ₦${Math.round(report.expectedCash / 100).toLocaleString("en-NG")}, counted ₦${Math.round(body.counted / 100).toLocaleString("en-NG")} (diff ₦${Math.round(diff / 100).toLocaleString("en-NG")})`,
        amount: diff,
      },
    });
    return { session: closed, zReport: { ...report, counted: body.counted, difference: diff } };
  },

  async zReport(sessionId: string) {
    const session = await prisma.posRegisterSession.findUnique({
      where: { id: sessionId },
      include: { register: true, moves: true },
    });
    if (!session) throw ApiError.notFound("Session");
    const orders = await prisma.order.findMany({
      where: { registerSessionId: sessionId, channel: "store" },
      include: { payments: true, returns: true },
    });
    const shaped = orders.map((o) => ({
      total: o.total,
      changeGiven: o.changeGiven,
      payments: o.payments.map((p) => ({ method: p.method, amount: p.amount })),
      returnsAmount: o.returns.reduce((a, r) => a + (r.refundAmount ?? 0), 0),
    }));
    const report = sessionReport(session, shaped);
    return {
      session: {
        id: session.id,
        registerId: session.registerId,
        registerName: session.register.name,
        openedAt: session.openedAt,
        closedAt: session.closedAt,
        float: session.float,
        counted: session.counted,
        expected: session.expected ?? report.expectedCash,
      },
      ...report,
      difference: (session.counted ?? report.expectedCash) - report.expectedCash,
      moves: session.moves,
    };
  },
};
