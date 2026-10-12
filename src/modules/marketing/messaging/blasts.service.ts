/**
 * asl-admin /messaging → Push blasts: one-off push notifications to every app user with a push token,
 * or to a segment. Sent in batches by a job; scheduled ones go out from `blasts.dispatch` (every minute).
 */
import type { Prisma, PushBlast } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { defineJob } from "@/core/queue/queue";
import { logger } from "@/core/utils/logger";
import { push } from "@/providers/push/push";
import { segmentsService } from "@/modules/marketing/segments/segments.service";
import type { BlastBody, BlastListQuery, BlastPatch } from "./messaging.schemas";

const BATCH = 500;
const EDITABLE = ["draft", "scheduled"];

async function audienceWhere(b: Pick<PushBlast, "audience" | "segmentId">): Promise<Prisma.CustomerWhereInput> {
  const base: Prisma.CustomerWhereInput = { deletedAt: null, status: { not: "blocked" }, pushTokens: { some: {} } };
  if (b.audience === "segment" && b.segmentId) return { AND: [base, await segmentsService.customerWhere(b.segmentId)] };
  return base;
}

async function toAdmin(b: PushBlast, names?: Map<string, string>) {
  const segmentName = b.segmentId ? (names?.get(b.segmentId) ?? (await prisma.segment.findUnique({ where: { id: b.segmentId }, select: { name: true } }))?.name) : null;
  return {
    id: b.id, title: b.title, body: b.body, audience: b.audience, segmentId: b.segmentId,
    audienceLabel: b.audience === "segment" ? (segmentName ?? "Deleted segment") : "All app users",
    status: b.status as "draft" | "scheduled" | "sending" | "sent",
    scheduledFor: b.scheduledFor, sentAt: b.sentAt, recipients: b.recipients, opens: b.opens,
    openRate: b.recipients ? b.opens / b.recipients : 0, createdAt: b.createdAt,
  };
}

async function find(id: string) {
  const b = await prisma.pushBlast.findUnique({ where: { id } });
  if (!b) throw ApiError.notFound("Push blast");
  return b;
}

async function checkSegment(audience: string | undefined, segmentId: string | null | undefined) {
  if (audience === "segment" && segmentId && !(await prisma.segment.findUnique({ where: { id: segmentId } }))) throw ApiError.notFound("Segment");
}

/** fan-out: customers with push tokens, BATCH at a time (provider chunks tokens by 100) */
async function deliver(blastId: string) {
  // claim: only one worker sends a blast
  const claimed = await prisma.pushBlast.updateMany({ where: { id: blastId, status: { in: EDITABLE } }, data: { status: "sending", recipients: 0 } });
  if (!claimed.count) return;
  const b = await find(blastId);
  let recipients = 0;
  try {
    const where = await audienceWhere(b);
    let cursor: string | undefined;
    for (;;) {
      const rows = await prisma.customer.findMany({
        where, select: { id: true, pushTokens: { select: { token: true } } }, orderBy: { id: "asc" }, take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!rows.length) break;
      cursor = rows[rows.length - 1].id;
      const tokens = rows.flatMap((r) => r.pushTokens.map((t) => t.token));
      await push.send({ tokens, title: b.title, body: b.body, data: { blastId: b.id, type: "blast" } }).catch((err) => logger.error({ err, blastId }, "push blast batch failed"));
      recipients += rows.length;
      await prisma.pushBlast.update({ where: { id: blastId }, data: { recipients } });
      if (rows.length < BATCH) break;
    }
  } finally {
    await prisma.pushBlast.update({ where: { id: blastId }, data: { status: "sent", sentAt: new Date(), recipients } });
  }
}

export const sendBlastJob = defineJob<{ blastId: string }>("blasts.send", async ({ blastId }) => deliver(blastId));

export const blastsService = {
  async list(q: BlastListQuery) {
    const filters: Prisma.PushBlastWhereInput = q.q ? { OR: [{ title: { contains: q.q } }, { body: { contains: q.q } }] } : {};
    const where = { ...filters, ...(q.status !== "all" ? { status: q.status } : {}) };
    const [rows, total, groups, sums] = await Promise.all([
      prisma.pushBlast.findMany({ where, orderBy: { createdAt: "desc" }, ...paging(q) }),
      prisma.pushBlast.count({ where }),
      prisma.pushBlast.groupBy({ by: ["status"], where: filters, _count: { _all: true } }),
      prisma.pushBlast.aggregate({ where: { ...filters, status: "sent" }, _sum: { recipients: true, opens: true } }),
    ]);
    const tabs: Record<string, number> = { all: 0, draft: 0, scheduled: 0, sending: 0, sent: 0 };
    for (const g of groups) {
      tabs[g.status] = g._count._all;
      tabs.all += g._count._all;
    }
    const ids = [...new Set(rows.map((r) => r.segmentId).filter(Boolean) as string[])];
    const names = new Map((await prisma.segment.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
    const recipients = sums._sum.recipients ?? 0;
    const opens = sums._sum.opens ?? 0;
    return withMeta(await Promise.all(rows.map((r) => toAdmin(r, names))), {
      ...pageMeta(q, total), tabs, kpis: { recipients, opens, openRate: recipients ? opens / recipients : 0 },
    });
  },

  async get(id: string) {
    const b = await find(id);
    return { ...(await toAdmin(b)), audienceSize: await this.audienceSize(b) };
  },

  /** customers who would get it now */
  async audienceSize(b: Pick<PushBlast, "audience" | "segmentId">) {
    return prisma.customer.count({ where: await audienceWhere(b) });
  },

  async create(body: BlastBody) {
    await checkSegment(body.audience, body.segmentId);
    const b = await prisma.pushBlast.create({
      data: { title: body.title, body: body.body, audience: body.audience, segmentId: body.audience === "segment" ? body.segmentId! : null,
        status: body.status, scheduledFor: body.scheduledFor ?? null },
    });
    return toAdmin(b);
  },

  async update(id: string, p: BlastPatch) {
    const b = await find(id);
    if (!EDITABLE.includes(b.status)) throw ApiError.badRequest("INVALID_STATE", "Sent blasts can't be edited.");
    const audience = p.audience ?? b.audience;
    const segmentId = p.segmentId !== undefined ? p.segmentId : b.segmentId;
    if (audience === "segment" && !segmentId) throw ApiError.badRequest("VALIDATION_FAILED", "Choose a segment.");
    await checkSegment(audience, segmentId);
    if (b.status === "scheduled" && p.scheduledFor === null) throw ApiError.badRequest("VALIDATION_FAILED", "Scheduled blasts need a send time. Unschedule it first.");
    const after = await prisma.pushBlast.update({
      where: { id },
      data: { title: p.title, body: p.body, audience, segmentId: audience === "segment" ? segmentId : null, scheduledFor: p.scheduledFor },
    });
    return { before: await toAdmin(b), after: await toAdmin(after) };
  },

  async schedule(id: string, scheduledFor: Date) {
    const b = await find(id);
    if (!EDITABLE.includes(b.status)) throw ApiError.badRequest("INVALID_STATE", "This blast was already sent.");
    return toAdmin(await prisma.pushBlast.update({ where: { id }, data: { status: "scheduled", scheduledFor } }));
  },

  async unschedule(id: string) {
    const b = await find(id);
    if (b.status !== "scheduled") throw ApiError.badRequest("INVALID_STATE", "Only scheduled blasts can be moved back to draft.");
    return toAdmin(await prisma.pushBlast.update({ where: { id }, data: { status: "draft" } }));
  },

  async sendNow(id: string) {
    const b = await find(id);
    if (!EDITABLE.includes(b.status)) throw ApiError.badRequest("INVALID_STATE", b.status === "sending" ? "This blast is already sending." : "This blast was already sent.");
    if (b.audience === "segment") await checkSegment(b.audience, b.segmentId);
    await sendBlastJob({ blastId: id });
    return toAdmin(await find(id));
  },

  async remove(id: string) {
    const b = await find(id);
    if (b.status === "sending") throw ApiError.badRequest("INVALID_STATE", "A blast can't be deleted while it is sending.");
    await prisma.pushBlast.delete({ where: { id } });
    return { deleted: true, title: b.title };
  },

  /** the app reports a tap on a blast notification (data.blastId) */
  async opened(blastId: string) {
    await prisma.pushBlast.updateMany({ where: { id: blastId, status: "sent" }, data: { opens: { increment: 1 } } });
    return { ok: true };
  },

  /** scheduled blasts whose time has come */
  async dispatchDue(now = new Date()) {
    const due = await prisma.pushBlast.findMany({ where: { status: "scheduled", scheduledFor: { lte: now } }, select: { id: true } });
    for (const d of due) await deliver(d.id);
    return due.length;
  },
};

export const dispatchBlastsJob = defineJob("blasts.dispatch", async () => void (await blastsService.dispatchDue()));
