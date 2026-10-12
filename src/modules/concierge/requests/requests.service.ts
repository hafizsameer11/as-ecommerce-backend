/**
 * Concierge requests: one lifecycle for the /start-request form and concierge-shop items.
 * Quotes + payment live in ../quotes, the chat thread in ../chat. See ../concierge.common.ts for the status rules.
 */
import type { ConciergePriority, ConciergeStatus, CustomerTier, Prisma } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { events } from "@/core/events/bus";
import { defineJob } from "@/core/queue/queue";
import { logger } from "@/core/utils/logger";
import { realtime } from "@/core/realtime/realtime";
import { formatters, nextSequence } from "@/core/utils/sequence";
import { formatNaira } from "@/core/utils/money";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { STATUS_LABELS } from "@/modules/platform/settings/status-labels";
import { mediaService, type UploadInput } from "@/modules/content/media/media.service";
import { fullName } from "@/modules/identity/auth/customer.mapper";
import { effectivePermissions } from "@/modules/identity/team/team.permissions";
import {
  addTimeline, ADMIN_TRANSITIONS, assertTransition, CUSTOMER_CANCELLABLE, CUSTOMER_TABS, notifyStaff, OPEN_STATUSES, applyStatus, requestKey, SLA_STATUSES, slaDue, slaLevel, systemMessage,
} from "../concierge.common";
import { effectiveStatus } from "../quotes/quotes.mapper";
import { quotesService } from "../quotes/quotes.service";
import { currentQuote, requestInclude, toAdminRequest, toAdminRow, toCustomerCard, toCustomerRequest, toTracking } from "./requests.mapper";
import type { AdminRequestsQuery, CreateRequestBody, MyRequestsQuery, NoteBody, StatusBody } from "./requests.schemas";

const MAX_IMAGES = 6;
const TIER_PRIORITY: Record<CustomerTier, ConciergePriority> = { Standard: "standard", Silver: "standard", Gold: "priority", Signature: "vip" };

async function lockRequest(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM \`ConciergeRequest\` WHERE id = ${id} FOR UPDATE`;
  return tx.conciergeRequest.findUniqueOrThrow({ where: { id }, include: requestInclude });
}

async function findRequest(where: Prisma.ConciergeRequestWhereInput) {
  const r = await prisma.conciergeRequest.findFirst({ where, include: requestInclude });
  if (!r) throw ApiError.notFound("Request");
  return r;
}

async function adminNames(ids: (string | null)[]) {
  const list = [...new Set(ids.filter(Boolean) as string[])];
  const rows = list.length ? await prisma.adminUser.findMany({ where: { id: { in: list } }, select: { id: true, name: true } }) : [];
  return new Map(rows.map((a) => [a.id, a.name]));
}

/**
 * Guest requests are linked to an account once the customer signs in with the same, verified, e-mail
 * ("light customer link"): they then show up in /account/requests and get chat + quote payment.
 */
async function claimGuestRequests(customerId: string) {
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { email: true, emailVerifiedAt: true } });
  if (!c?.emailVerifiedAt) return;
  const { count } = await prisma.conciergeRequest.updateMany({ where: { customerId: null, contactEmail: c.email }, data: { customerId } });
  if (count) await prisma.customerStats.upsert({ where: { customerId }, create: { customerId, conciergeCount: count }, update: { conciergeCount: { increment: count } } });
}

const isOpen = (s: ConciergeStatus) => OPEN_STATUSES.includes(s);

function adminWhere(q: Omit<AdminRequestsQuery, "page" | "pageSize" | "sort" | "tab">, adminId: string): Prisma.ConciergeRequestWhereInput {
  const and: Prisma.ConciergeRequestWhereInput[] = [];
  if (q.priority) and.push({ priority: q.priority });
  if (q.assignee === "unassigned") and.push({ assigneeId: null });
  else if (q.assignee === "me") and.push({ assigneeId: adminId });
  else if (q.assignee) and.push({ assigneeId: q.assignee });
  if (q.supplierId) and.push({ supplierId: q.supplierId });
  if (q.customerId) and.push({ customerId: q.customerId });
  if (q.q) {
    const s = q.q;
    and.push({
      OR: [
        { number: { contains: s } }, { itemName: { contains: s } }, { brand: { contains: s } }, { category: { contains: s } },
        { contactName: { contains: s } }, { contactEmail: { contains: s } },
        { customer: { OR: [{ email: { contains: s } }, { firstName: { contains: s } }, { lastName: { contains: s } }] } },
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

function tabWhere(tab: AdminRequestsQuery["tab"], cfg: Awaited<ReturnType<typeof settingsService.get<"concierge">>>): Prisma.ConciergeRequestWhereInput {
  const now = new Date();
  switch (tab) {
    case "all": return {};
    case "open": return { status: { in: OPEN_STATUSES } };
    case "unassigned": return { status: { in: OPEN_STATUSES }, assigneeId: null };
    case "vip": return { status: { in: OPEN_STATUSES }, priority: "vip" };
    case "sla_breached": return { status: { in: SLA_STATUSES }, slaDueAt: { lte: now } };
    case "sla_at_risk":
      return {
        status: { in: SLA_STATUSES },
        OR: (["standard", "priority", "vip"] as const).map((p) => ({
          priority: p, slaDueAt: { gt: now, lte: new Date(now.getTime() + cfg.responseSlaHours[p] * 3_600_000 * 0.25) },
        })),
      };
    default: return { status: tab };
  }
}

export const requestsService = {
  // ── customer ──
  async create(customerId: string | null, b: CreateRequestBody, files: UploadInput[]) {
    const cfg = await settingsService.get("concierge");
    const customer = customerId ? await prisma.customer.findUniqueOrThrow({ where: { id: customerId } }) : null;
    if (!customer && (!b.contactName || !b.contactEmail))
      throw ApiError.badRequest("VALIDATION_FAILED", "Please give your name and e-mail so we can reach you, or sign in.", [
        ...(!b.contactName ? [{ in: "body", path: "contactName", message: "Required" }] : []),
        ...(!b.contactEmail ? [{ in: "body", path: "contactEmail", message: "Required" }] : []),
      ]);
    if (files.length > MAX_IMAGES) throw ApiError.badRequest("VALIDATION_FAILED", `Add up to ${MAX_IMAGES} images.`);

    // concierge-shop item: details come from the catalogue
    let fromCatalog: { productId: string; itemName: string; brand: string; category: string; price: number | null; image: string | null } | null = null;
    if (b.source === "catalog") {
      const p = await prisma.product.findFirst({
        where: { OR: [{ id: b.productId }, { handle: b.productId }], status: "active", deletedAt: null },
        include: { brand: true, category: true, variants: { where: { active: true } }, colors: true, images: { orderBy: { position: "asc" }, take: 1 } },
      });
      if (!p) throw ApiError.notFound("Product");
      const sizes = [...new Set(p.variants.map((v) => v.size).filter(Boolean) as string[])];
      if (sizes.length && !b.size) throw ApiError.badRequest("VALIDATION_FAILED", "Please choose a size.", [{ in: "body", path: "size", message: "Required", options: sizes }]);
      if (b.size && sizes.length && !sizes.includes(b.size)) throw ApiError.badRequest("VALIDATION_FAILED", "That size isn't available for this item.", [{ in: "body", path: "size", options: sizes }]);
      const colors = p.colors.map((c) => c.name);
      if (b.color && colors.length && !colors.includes(b.color)) throw ApiError.badRequest("VALIDATION_FAILED", "That colour isn't available for this item.", [{ in: "body", path: "color", options: colors }]);
      const v = p.variants.find((x) => (!b.size || x.size === b.size) && (!b.color || !x.color || x.color === b.color));
      fromCatalog = {
        productId: p.id, itemName: p.name, brand: p.brand.name, category: p.category.name,
        price: p.priceOnRequest ? null : (v?.price ?? p.price), image: p.images[0]?.url ?? null,
      };
    }

    const images: string[] = [];
    for (const f of files) {
      const m = await mediaService.upload(f, "concierge", customerId ? `customer:${customerId}` : `guest:${b.contactEmail}`);
      images.push((m.variants as Record<string, string> | null)?.lg ?? m.url);
    }
    if (fromCatalog?.image) images.unshift(fromCatalog.image);

    const priority = customer ? TIER_PRIORITY[customer.tier] : "standard";
    const now = new Date();
    const r = await prisma.$transaction(async (tx) => {
      const number = formatters.concierge(await nextSequence(tx, "concierge", 123457));
      const created = await tx.conciergeRequest.create({
        data: {
          number,
          customerId: customer?.id ?? null,
          contactName: customer ? fullName(customer) : b.contactName!,
          contactEmail: customer?.email ?? b.contactEmail!,
          contactPhone: b.contactPhone ?? customer?.phone ?? null,
          source: b.source,
          productId: fromCatalog?.productId ?? null,
          category: fromCatalog?.category ?? b.category!,
          brand: fromCatalog?.brand ?? b.brand ?? null,
          itemName: fromCatalog?.itemName ?? b.itemName!,
          reference: b.reference ?? null,
          description: b.description ?? null,
          size: b.size ?? null,
          color: b.color ?? null,
          condition: b.condition ?? null,
          budget: b.budget ?? null,
          preferredSource: b.preferredSource ?? null,
          notes: b.notes ?? null,
          qty: b.qty,
          price: fromCatalog?.price ?? null,
          priority,
          createdAt: now,
          slaDueAt: slaDue(now, priority, cfg),
          images: { create: images.map((url) => ({ url })) },
          timeline: { create: { kind: "status", text: `Request received${b.source === "catalog" ? " from the concierge shop" : ""}.`, by: "System" } },
          thread: { create: {} },
        },
      });
      await systemMessage(tx, created.id, `Request ${number} opened for ${[fromCatalog?.brand ?? b.brand, fromCatalog?.itemName ?? b.itemName].filter(Boolean).join(" - ")}. A client advisor will be in touch shortly.`);
      if (customer) await tx.customerStats.upsert({ where: { customerId: customer.id }, create: { customerId: customer.id, conciergeCount: 1 }, update: { conciergeCount: { increment: 1 } } });
      return created;
    });
    if (images.length) await mediaService.syncUsage("concierge_request", r.id, images).catch(() => undefined);
    events.emit("concierge.requested", { requestId: r.id });
    const full = await findRequest({ id: r.id });
    return customerId ? toCustomerRequest(full) : toTracking(full);
  },

  async myList(customerId: string, q: MyRequestsQuery) {
    await claimGuestRequests(customerId);
    const base: Prisma.ConciergeRequestWhereInput = {
      customerId,
      ...(q.q ? { OR: [{ number: { contains: q.q } }, { itemName: { contains: q.q } }, { brand: { contains: q.q } }] } : {}),
    };
    const statuses = CUSTOMER_TABS[q.tab];
    const where = statuses ? { ...base, status: { in: [...statuses] } } : base;
    const [rows, total, groups] = await Promise.all([
      prisma.conciergeRequest.findMany({ where, include: requestInclude, orderBy: { createdAt: "desc" }, ...paging(q) }),
      prisma.conciergeRequest.count({ where }),
      prisma.conciergeRequest.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
    ]);
    const count = (list: readonly ConciergeStatus[] | null) => groups.filter((g) => !list || list.includes(g.status)).reduce((n, g) => n + g._count._all, 0);
    const tabs = Object.fromEntries(Object.entries(CUSTOMER_TABS).map(([k, list]) => [k, count(list)]));
    return withMeta(rows.map((r) => toCustomerCard(r)), { ...pageMeta(q, total), tabs });
  },

  async myGet(customerId: string, id: string) {
    return toCustomerRequest(await findRequest({ customerId, ...requestKey(id) }));
  },

  /** the concierge cart: open requests with their cart label, plus an estimated summary */
  async cart(customerId: string) {
    const cfg = await settingsService.get("concierge");
    const rows = await prisma.conciergeRequest.findMany({
      where: { customerId, status: { in: ["new", "sourcing", "quoted", "payment_pending", "approved"] } },
      include: requestInclude,
      orderBy: { createdAt: "desc" },
    });
    const items = rows.map((r) => toCustomerCard(r));
    const subtotal = items.reduce((n, i) => n + (i.price ?? 0) * (i.quote ? 1 : i.qty), 0);
    return {
      items,
      count: items.length,
      summary: { subtotal, serviceFee: cfg.serviceFee, shippingEstimate: cfg.shippingEstimate, estimatedTotal: subtotal + cfg.serviceFee + cfg.shippingEstimate },
    };
  },

  async cancelByCustomer(customerId: string, id: string, reason?: string) {
    const found = await findRequest({ customerId, ...requestKey(id) });
    await prisma.$transaction(async (tx) => {
      const r = await lockRequest(tx, found.id);
      if (r.quotes.some((q) => q.amountPaid > 0)) {
        // D12: refunds after payment are done by staff (POST /admin/concierge/requests/:id/refund)
        const { supportEmail, supportPhone } = await settingsService.get("profile");
        throw ApiError.conflict(
          "INVALID_STATE",
          `We've already received your payment for ${r.number}, so it can't be cancelled here. Please contact support (${supportEmail}, ${supportPhone}) or message your concierge and we'll arrange your refund.`,
          { reason: "paid", supportEmail, supportPhone },
        );
      }
      if (!CUSTOMER_CANCELLABLE.includes(r.status))
        throw ApiError.conflict("INVALID_STATE", "This request can no longer be cancelled. Please message your concierge.");
      await tx.conciergeQuote.updateMany({ where: { requestId: r.id, status: { in: ["sent", "accepted"] } }, data: { status: "declined", declineReason: "Request cancelled by the customer" } });
      await applyStatus(tx, r, "cancelled", "Customer", reason ? `You cancelled this request (${reason})` : "You cancelled this request");
    });
    events.emit("concierge.status_changed", { requestId: found.id, to: "cancelled" });
    return this.myGet(customerId, found.id);
  },

  /** /track-request: by number + the e-mail on the request (owner: e-mail optional) */
  async track(number: string, email: string | undefined, customerId?: string) {
    if (customerId) await claimGuestRequests(customerId);
    const r = await prisma.conciergeRequest.findFirst({ where: requestKey(number), include: requestInclude });
    const owner = !!r && !!customerId && r.customerId === customerId;
    if (!r || (!owner && (!email || r.contactEmail.toLowerCase() !== email.toLowerCase()))) throw ApiError.notFound("Request");
    return toTracking(r);
  },

  // ── admin ──
  async adminList(q: AdminRequestsQuery, adminId: string) {
    const cfg = await settingsService.get("concierge");
    const base = adminWhere(q, adminId);
    const where: Prisma.ConciergeRequestWhereInput = { AND: [base, tabWhere(q.tab, cfg)] };
    const orderBy: Prisma.ConciergeRequestOrderByWithRelationInput[] =
      q.sort === "sla" ? [{ slaDueAt: "asc" }] : q.sort === "createdAt" ? [{ createdAt: "asc" }] : q.sort === "-updatedAt" ? [{ updatedAt: "desc" }] : [{ createdAt: "desc" }];
    const [rows, total, groups, open] = await Promise.all([
      prisma.conciergeRequest.findMany({ where, include: requestInclude, orderBy, ...paging(q) }),
      prisma.conciergeRequest.count({ where }),
      prisma.conciergeRequest.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
      prisma.conciergeRequest.findMany({ where: { AND: [base, { status: { in: OPEN_STATUSES } }] }, include: requestInclude }),
    ]);
    const names = await adminNames([...rows, ...open].map((r) => r.assigneeId));
    const openRows = open.map((r) => toAdminRow(r, names, cfg));
    const byStatus = Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
    const tabs = {
      all: groups.reduce((n, g) => n + g._count._all, 0),
      open: openRows.length,
      unassigned: openRows.filter((r) => !r.assignee).length,
      sla_breached: openRows.filter((r) => r.sla === "breached").length,
      sla_at_risk: openRows.filter((r) => r.sla === "at_risk").length,
      vip: openRows.filter((r) => r.priority === "vip").length,
      ...byStatus,
    };
    const kpis = {
      slaBreached: tabs.sla_breached,
      slaAtRisk: tabs.sla_at_risk,
      unassigned: tabs.unassigned,
      vipOpen: tabs.vip,
      pipelineValue: openRows.reduce((n, r) => n + r.value, 0),
    };
    return withMeta(rows.map((r) => toAdminRow(r, names, cfg)), { ...pageMeta(q, total), tabs, kpis });
  },

  /** /concierge/board: open columns + the last delivered/cancelled */
  async board(q: Pick<AdminRequestsQuery, "priority" | "assignee" | "q">, adminId: string) {
    const cfg = await settingsService.get("concierge");
    const base = adminWhere(q, adminId);
    const columns: ConciergeStatus[] = ["new", "sourcing", "quoted", "payment_pending", "approved", "ordered", "in_transit", "delivered"];
    const lists = await Promise.all(
      columns.map((s) =>
        Promise.all([
          prisma.conciergeRequest.findMany({ where: { AND: [base, { status: s }] }, include: requestInclude, orderBy: s === "delivered" ? { updatedAt: "desc" } : { createdAt: "asc" }, take: 50 }),
          prisma.conciergeRequest.count({ where: { AND: [base, { status: s }] } }),
        ]),
      ),
    );
    const names = await adminNames(lists.flatMap(([rows]) => rows.map((r) => r.assigneeId)));
    return columns.map((s, i) => {
      const items = lists[i][0].map((r) => toAdminRow(r, names, cfg));
      return { status: s, label: STATUS_LABELS.concierge.admin[s], count: lists[i][1], value: items.reduce((n, r) => n + r.value, 0), allowedNext: ADMIN_TRANSITIONS[s], items };
    });
  },

  async adminGet(id: string) {
    const cfg = await settingsService.get("concierge");
    const r = await findRequest(requestKey(id));
    return toAdminRequest(r, await adminNames([r.assigneeId]), cfg);
  },

  async setStatus(id: string, b: StatusBody, actor: string) {
    const found = await findRequest(requestKey(id));
    const from = found.status;
    await prisma.$transaction(async (tx) => {
      const r = await lockRequest(tx, found.id);
      assertTransition(r.status, b.status);
      if (r.status === b.status) return;
      const q = currentQuote(r);
      if (b.status === "in_transit" && (!q || q.status !== "paid" || q.amountPaid < q.total))
        throw ApiError.conflict("INVALID_STATE", q && q.status === "paid" ? `The balance of ${formatNaira(q.total - q.amountPaid)} is still due before dispatch.` : "This request hasn't been paid yet.");
      if (["cancelled", "unavailable"].includes(b.status) && r.quotes.some((x) => x.amountPaid > 0))
        throw ApiError.conflict("INVALID_STATE", "Money has been received on this request. Refund it before cancelling.");
      await applyStatus(tx, r, b.status, actor, b.note);
    });
    if (from !== b.status) {
      events.emit("concierge.status_changed", { requestId: found.id, to: b.status });
      if (b.status === "delivered") await quotesService.recogniseRevenue(found.id).catch((err) => logger.error({ err, requestId: found.id }, "concierge revenue journal failed"));
    }
    return this.adminGet(found.id);
  },

  async assign(id: string, adminId: string | null, actor: { id: string; name: string }) {
    const r = await findRequest(requestKey(id));
    let name: string | null = null;
    if (adminId) {
      const a = await prisma.adminUser.findUnique({ where: { id: adminId } });
      if (!a || a.status !== "active") throw ApiError.badRequest("VALIDATION_FAILED", "Choose an active team member.");
      if (!(await effectivePermissions(a.role)).has("concierge.view")) throw ApiError.badRequest("VALIDATION_FAILED", `${a.name} can't work on concierge requests (role ${a.role}).`);
      name = a.name;
    }
    await prisma.$transaction(async (tx) => {
      await tx.conciergeRequest.update({ where: { id: r.id }, data: { assigneeId: adminId } });
      await addTimeline(tx, r.id, "note", name ? `Assigned to ${name}.` : "Unassigned.", actor.name, true);
      if (r.status === "new" && adminId) {
        // picking a request up starts sourcing
        await applyStatus(tx, r, "sourcing", name!, `${name} is sourcing your item`);
      }
    });
    if (r.status === "new" && adminId) events.emit("concierge.status_changed", { requestId: r.id, to: "sourcing" });
    if (adminId && adminId !== actor.id)
      await prisma.adminNotification.create({
        data: { adminId, title: `Request ${r.number} assigned to you`, body: `${actor.name} assigned ${[r.brand, r.itemName].filter(Boolean).join(" ")} to you.`, link: `/concierge/inbox?id=${r.id}`, priority: r.priority === "vip" ? "high" : "normal" },
      }).then((n) => realtime.bell(n)).catch((err) => logger.error({ err }, "assignment notification failed"));
    return this.adminGet(r.id);
  },

  async setPriority(id: string, priority: ConciergePriority, actor: string) {
    const cfg = await settingsService.get("concierge");
    const r = await findRequest(requestKey(id));
    if (r.priority !== priority)
      await prisma.$transaction(async (tx) => {
        await tx.conciergeRequest.update({ where: { id: r.id }, data: { priority, slaDueAt: slaDue(r.createdAt, priority, cfg), slaState: "ok" } });
        await addTimeline(tx, r.id, "note", `Priority ${r.priority} → ${priority}.`, actor, true);
      });
    return this.adminGet(r.id);
  },

  async setSupplier(id: string, supplierId: string | null, actor: string) {
    const r = await findRequest(requestKey(id));
    const s = supplierId ? await prisma.supplier.findUnique({ where: { id: supplierId } }) : null;
    if (supplierId && !s) throw ApiError.notFound("Supplier");
    if (s && s.status === "blocked") throw ApiError.conflict("INVALID_STATE", `${s.name} is blocked.`);
    await prisma.$transaction(async (tx) => {
      await tx.conciergeRequest.update({ where: { id: r.id }, data: { supplierId } });
      await addTimeline(tx, r.id, "note", s ? `Supplier: ${s.name}.` : "Supplier removed.", actor, true);
    });
    return this.adminGet(r.id);
  },

  async addNote(id: string, b: NoteBody, actor: string) {
    const r = await findRequest(requestKey(id));
    await prisma.$transaction(async (tx) => {
      await addTimeline(tx, r.id, "note", b.text, actor, b.internal);
      await tx.conciergeRequest.update({ where: { id: r.id }, data: { updatedAt: new Date() } });
    });
    return this.adminGet(r.id);
  },

  /** concierge analytics strip */
  async kpis() {
    const cfg = await settingsService.get("concierge");
    const now = Date.now();
    const [open, quotes, quotedOpen] = await Promise.all([
      prisma.conciergeRequest.findMany({ where: { status: { in: OPEN_STATUSES } }, select: { status: true, slaDueAt: true, priority: true, assigneeId: true } }),
      prisma.conciergeQuote.groupBy({ by: ["status"], _count: { _all: true }, _sum: { total: true, amountPaid: true } }),
      prisma.conciergeQuote.findMany({ where: { status: { in: ["sent", "accepted"] } }, select: { total: true, status: true, expiresAt: true, amountPaid: true } }),
    ]);
    const levels = open.map((r) => slaLevel(r, cfg, now));
    const n = (s: string) => quotes.find((q) => q.status === s)?._count._all ?? 0;
    const decided = n("paid") + n("declined") + n("expired");
    return {
      open: open.length,
      unassigned: open.filter((r) => !r.assigneeId).length,
      slaAtRisk: levels.filter((l) => l === "at_risk").length,
      slaBreached: levels.filter((l) => l === "breached").length,
      quotedValue: quotedOpen.filter((q) => effectiveStatus(q) !== "expired").reduce((s, q) => s + q.total, 0),
      quotes: { sent: n("sent"), accepted: n("accepted"), paid: n("paid"), declined: n("declined"), expired: n("expired") },
      /** paid quotes ÷ quotes that reached a decision (paid, declined, expired), % */
      conversion: decided ? Math.round((n("paid") / decided) * 1000) / 10 : 0,
      collected: quotes.reduce((s, q) => s + (q._sum.amountPaid ?? 0), 0),
      byStatus: Object.fromEntries(OPEN_STATUSES.map((s) => [s, open.filter((r) => r.status === s).length])),
    };
  },

  /**
   * concierge.sla-check: raises a request's SLA level (ok → at_risk → breached) once and notifies staff
   * through the `concierge_sla` rule (in-app, roles + assignee). Returns what changed (tests).
   */
  async slaCheck(now = Date.now()) {
    const cfg = await settingsService.get("concierge");
    const rows = await prisma.conciergeRequest.findMany({
      where: { status: { in: SLA_STATUSES }, slaDueAt: { not: null }, slaState: { not: "breached" } },
      select: { id: true, number: true, itemName: true, brand: true, status: true, priority: true, slaDueAt: true, slaState: true, assigneeId: true },
    });
    const rank = { ok: 0, at_risk: 1, breached: 2 } as const;
    const changed: { id: string; number: string; level: "at_risk" | "breached" }[] = [];
    for (const r of rows) {
      const level = slaLevel(r, cfg, now);
      if (!level || level === "ok" || rank[level] <= rank[(r.slaState as keyof typeof rank) ?? "ok"]) continue;
      const { count } = await prisma.conciergeRequest.updateMany({ where: { id: r.id, slaState: r.slaState }, data: { slaState: level } });
      if (!count) continue;
      changed.push({ id: r.id, number: r.number, level });
      await notifyStaff("concierge_sla", {
        title: level === "breached" ? `SLA breached · ${r.number}` : `SLA at risk · ${r.number}`,
        body: `${[r.brand, r.itemName].filter(Boolean).join(" ")} (${r.priority}) is due ${r.slaDueAt!.toISOString()}.`,
        link: `/concierge/inbox?id=${r.id}`,
        adminId: r.assigneeId,
      });
    }
    if (changed.length) logger.info({ changed: changed.length }, "concierge SLA levels raised");
    return changed;
  },

  isOpen,
};

export const conciergeSlaJob = defineJob("concierge.sla-check", async () => {
  await requestsService.slaCheck();
});
