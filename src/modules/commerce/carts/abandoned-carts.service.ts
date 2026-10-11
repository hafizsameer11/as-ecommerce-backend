/**
 * Abandoned-cart recovery (asl-admin /carts).
 *
 * Lifecycle: active → abandoned (no activity for `checkout.abandonMinutes`, items in the bag and an
 * email we can write to) → reminders per RecoveryRule (stage, delay after abandonedAt) →
 * recovered (an order is placed from the bag, see cartsService.markConverted) or lost
 * (7 days after the last reminder with no activity). Any change to the bag re-opens it (status active).
 *
 * "Time of the last reminder" = the cart's updatedAt: an abandoned cart is only written by this module
 * (abandon, each reminder), because any customer change turns it back to active.
 */
import { Prisma } from "@/generated/prisma/client";
import { env } from "@/config/env";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { defineJob } from "@/core/queue/queue";
import { formatNaira } from "@/core/utils/money";
import { logger } from "@/core/utils/logger";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { messaging } from "@/modules/marketing/messaging/messaging.service";
import { fullName } from "@/modules/identity/auth/customer.mapper";
import type { AbandonedListQuery, RecoveryRulesBody, ReminderChannel } from "./abandoned-carts.schemas";

export const LOST_AFTER_DAYS = 7;
const DAY = 86_400_000;
const DEFAULT_TEMPLATE = "cart.reminder";

const adminInclude = {
  customer: { select: { id: true, firstName: true, lastName: true, email: true, deletedAt: true, status: true } },
  items: {
    orderBy: { createdAt: "asc" },
    select: { qty: true, unitPrice: true, color: true, product: { select: { name: true, images: { orderBy: { position: "asc" }, take: 1, select: { url: true } } } } },
  },
} satisfies Prisma.CartInclude;
type AdminCart = Prisma.CartGetPayload<{ include: typeof adminInclude }>;

const CHANNEL_LABEL: Record<string, string> = { web: "Desktop web", mobile: "Mobile app", pwa: "Mobile PWA" };

export function stageLabel(c: { status: string; reminderStage: number }) {
  if (c.status === "recovered") return "Recovered";
  if (c.status === "lost") return "Lost";
  return c.reminderStage > 0 ? `Reminder ${c.reminderStage} sent` : "Just abandoned";
}

const cartValue = (c: AdminCart) => c.items.reduce((n, i) => n + i.unitPrice * i.qty, 0);
const recipient = (c: AdminCart) => c.customer?.email ?? c.email ?? null;
export const recoverUrl = (c: { customerId: string | null; guestToken: string | null }) =>
  c.customerId || !c.guestToken ? `${env.WEB_URL}/cart` : `${env.WEB_URL}/cart?recover=${encodeURIComponent(c.guestToken)}`;

function toRow(c: AdminCart) {
  return {
    id: c.id,
    ref: `AC-${c.id.slice(-6).toUpperCase()}`,
    customer: c.customer ? fullName(c.customer) : "Guest",
    customerId: c.customerId,
    email: recipient(c),
    items: c.items.map((i) => ({ name: i.product.name, image: i.product.images[0]?.url ?? null, price: i.unitPrice, qty: i.qty })),
    itemsCount: c.items.reduce((n, i) => n + i.qty, 0),
    total: cartValue(c),
    stage: stageLabel(c),
    status: c.status,
    reminderStage: c.reminderStage,
    channel: CHANNEL_LABEL[c.channel] ?? c.channel,
    abandonedAt: c.abandonedAt,
    lastActivityAt: c.lastActivityAt,
    recoveredAt: c.recoveredAt,
  };
}

function stageWhere(stage: AbandonedListQuery["stage"]): Prisma.CartWhereInput {
  switch (stage) {
    case "just_abandoned": return { status: "abandoned", reminderStage: 0 };
    case "reminder_1": return { status: "abandoned", reminderStage: 1 };
    case "reminder_2": return { status: "abandoned", reminderStage: { gte: 2 } };
    case "recovered": return { status: "recovered" };
    case "lost": return { status: "lost" };
    default: return { status: { in: ["abandoned", "recovered", "lost"] } };
  }
}

function searchWhere(q?: string): Prisma.CartWhereInput {
  if (!q) return {};
  return { OR: [{ id: { contains: q } }, { email: { contains: q } }, { customer: { OR: [{ email: { contains: q } }, { firstName: { contains: q } }, { lastName: { contains: q } }] } }] };
}

const sumValue = async (where: Prisma.Sql) =>
  Number(
    (await prisma.$queryRaw<{ v: unknown }[]>`SELECT COALESCE(SUM(ci.unitPrice * ci.qty), 0) AS v FROM \`CartItem\` ci JOIN \`Cart\` c ON c.id = ci.cartId WHERE ${where}`)[0]?.v ?? 0,
  );

const enabledRules = () => prisma.recoveryRule.findMany({ where: { enabled: true }, orderBy: { stage: "asc" } });

/**
 * Send one reminder and move the cart to `stage`. The stage is claimed first (conditional update),
 * so two scans running together never send the same reminder twice.
 */
async function deliver(c: AdminCart, stage: number, channel: ReminderChannel, templateCode: string) {
  const claimed = await prisma.cart.updateMany({ where: { id: c.id, status: "abandoned", reminderStage: c.reminderStage }, data: { reminderStage: stage } });
  if (!claimed.count) return false;
  const vars = {
    firstName: c.customer?.firstName ?? "there",
    items: c.items.map((i) => i.product.name).join(", "),
    itemsCount: c.items.reduce((n, i) => n + i.qty, 0),
    total: formatNaira(cartValue(c)),
    recoverUrl: recoverUrl(c),
  };
  if (channel === "push" && c.customerId) await messaging.push(c.customerId, templateCode, vars, { url: "/cart" });
  else await messaging.email(recipient(c)!, templateCode, vars);
  return true;
}

/** checks shared by the admin buttons; returns the reason a cart can't get a reminder */
function refusal(c: AdminCart, channel: ReminderChannel): { status: number; message: string } | null {
  if (c.status === "recovered") return { status: 409, message: "This cart was recovered (the customer placed an order). No reminder sent." };
  if (c.status === "lost") return { status: 409, message: "This cart is marked as lost. No reminder sent." };
  if (c.status === "converted") return { status: 409, message: "This cart was checked out. No reminder sent." };
  if (c.status !== "abandoned") return { status: 409, message: "The customer is still shopping. Reminders go to abandoned carts only." };
  if (c.customer && (c.customer.deletedAt || c.customer.status === "blocked")) return { status: 409, message: "This customer can't be contacted." };
  if (channel === "push" && !c.customerId) return { status: 400, message: "Push reminders need a signed-in customer. Send an email instead." };
  if (channel === "email" && !recipient(c)) return { status: 400, message: "No email captured for this cart." };
  return null;
}

async function remindOne(c: AdminCart, channel: ReminderChannel, rules?: { stage: number; templateCode: string }[]) {
  const stage = c.reminderStage + 1;
  const rule = (rules ?? (await prisma.recoveryRule.findMany())).find((r) => r.stage === stage);
  return deliver(c, stage, channel, rule?.templateCode ?? DEFAULT_TEMPLATE);
}

export const abandonedCartsService = {
  /** the 15-minute job: mark abandoned → send due reminders → mark lost */
  async scan() {
    const now = Date.now();
    const { abandonMinutes } = await settingsService.get("checkout");

    // 1. idle bags with something in them and someone to write to
    const idle = await prisma.cart.findMany({
      where: {
        status: "active",
        lastActivityAt: { lt: new Date(now - abandonMinutes * 60_000) },
        items: { some: {} },
        OR: [{ customerId: null, email: { not: null } }, { customer: { is: { deletedAt: null, status: { not: "blocked" } } } }],
      },
      select: { id: true },
      take: 2000,
    });
    const abandoned = idle.length
      ? (await prisma.cart.updateMany({ where: { id: { in: idle.map((c) => c.id) }, status: "active" }, data: { status: "abandoned", abandonedAt: new Date(now), reminderStage: 0 } })).count
      : 0;

    // 2. reminders that are due (next enabled stage after the one already sent)
    const rules = await enabledRules();
    const lastStage = rules.at(-1)?.stage ?? 0;
    let reminded = 0;
    if (rules.length) {
      const pending = await prisma.cart.findMany({
        where: { status: "abandoned", reminderStage: { lt: lastStage }, abandonedAt: { lte: new Date(now - rules[0]!.delayMinutes * 60_000) } },
        include: adminInclude,
        take: 1000,
      });
      for (const c of pending) {
        const rule = rules.find((r) => r.stage > c.reminderStage);
        if (!rule || c.abandonedAt!.getTime() + rule.delayMinutes * 60_000 > now) continue;
        if (c.customer && (c.customer.deletedAt || c.customer.status === "blocked")) continue;
        const channel: ReminderChannel = rule.channel === "push" && c.customerId ? "push" : "email";
        if (channel === "email" && !recipient(c)) continue;
        try {
          if (await deliver(c, rule.stage, channel, rule.templateCode)) reminded++;
        } catch (err) {
          logger.error({ err, cartId: c.id }, "cart reminder failed");
        }
      }
    }

    // 3. nothing left to send and no activity for 7 days since the last reminder → lost
    const lost = (
      await prisma.cart.updateMany({
        where: { status: "abandoned", reminderStage: { gte: lastStage }, updatedAt: { lt: new Date(now - LOST_AFTER_DAYS * DAY) } },
        data: { status: "lost" },
      })
    ).count;
    return { abandoned, reminded, lost };
  },

  async list(q: AbandonedListQuery) {
    const search = searchWhere(q.q);
    const where: Prisma.CartWhereInput = { AND: [stageWhere(q.stage), search] };
    const since = new Date(Date.now() - 30 * DAY);
    const [rows, total, groups, valueAtRisk, recoveredValue30d, recovered30d, abandoned30d] = await Promise.all([
      prisma.cart.findMany({ where, include: adminInclude, orderBy: [{ abandonedAt: "desc" }, { id: "desc" }], ...paging(q) }),
      prisma.cart.count({ where }),
      prisma.cart.groupBy({ by: ["status", "reminderStage"], where: { AND: [stageWhere("all"), search] }, _count: { _all: true } }),
      sumValue(Prisma.sql`c.status = 'abandoned'`),
      sumValue(Prisma.sql`c.status = 'recovered' AND c.recoveredAt >= ${since}`),
      prisma.cart.count({ where: { status: "recovered", recoveredAt: { gte: since } } }),
      prisma.cart.count({ where: { abandonedAt: { gte: since } } }),
    ]);
    const tabs = { all: 0, just_abandoned: 0, reminder_1: 0, reminder_2: 0, recovered: 0, lost: 0 };
    for (const g of groups) {
      const n = g._count._all;
      tabs.all += n;
      if (g.status === "recovered") tabs.recovered += n;
      else if (g.status === "lost") tabs.lost += n;
      else if (g.reminderStage === 0) tabs.just_abandoned += n;
      else if (g.reminderStage === 1) tabs.reminder_1 += n;
      else tabs.reminder_2 += n;
    }
    const kpis = {
      activeAbandoned: tabs.just_abandoned + tabs.reminder_1 + tabs.reminder_2,
      valueAtRisk,
      recovered30d,
      recoveredValue30d,
      /** % of carts abandoned in the last 30 days that were recovered */
      recoveryRate: abandoned30d ? Math.round((recovered30d / abandoned30d) * 1000) / 10 : 0,
    };
    return withMeta(rows.map(toRow), { ...pageMeta(q, total), tabs, kpis });
  },

  async remind(id: string, channel: ReminderChannel) {
    const c = await prisma.cart.findUnique({ where: { id }, include: adminInclude });
    if (!c) throw ApiError.notFound("Cart");
    const no = refusal(c, channel);
    if (no) throw no.status === 409 ? ApiError.conflict("INVALID_STATE", no.message) : ApiError.badRequest("VALIDATION_FAILED", no.message);
    if (!(await remindOne(c, channel))) throw ApiError.conflict("CONFLICT", "This cart changed while sending. Refresh and try again.");
    return toRow((await prisma.cart.findUnique({ where: { id }, include: adminInclude }))!);
  },

  async remindBulk(ids?: string[]) {
    const carts = await prisma.cart.findMany({
      where: ids ? { id: { in: ids } } : { status: "abandoned" },
      include: adminInclude,
      take: 500,
    });
    const eligible = carts.filter((c) => !refusal(c, "email"));
    if (!eligible.length) throw ApiError.badRequest("VALIDATION_FAILED", "No eligible carts for a bulk reminder.");
    const rules = await prisma.recoveryRule.findMany();
    let sent = 0;
    for (const c of eligible) if (await remindOne(c, "email", rules)) sent++;
    const skipped = carts.filter((c) => refusal(c, "email")).map((c) => ({ id: c.id, reason: refusal(c, "email")!.message }));
    return { sent, skipped };
  },

  async rules() {
    const [rules, checkout] = await Promise.all([prisma.recoveryRule.findMany({ orderBy: { stage: "asc" } }), settingsService.get("checkout")]);
    return {
      rules: rules.map((r) => ({ stage: r.stage, delayMinutes: r.delayMinutes, channel: r.channel, templateCode: r.templateCode, enabled: r.enabled, updatedAt: r.updatedAt })),
      /** from settings → checkout.abandonMinutes */
      abandonMinutes: checkout.abandonMinutes,
      lostAfterDays: LOST_AFTER_DAYS,
    };
  },

  /** replaces the whole cadence (stages not sent are removed) */
  async saveRules(b: RecoveryRulesBody) {
    const before = await this.rules();
    await prisma.$transaction(async (tx) => {
      await tx.recoveryRule.deleteMany({ where: { stage: { notIn: b.rules.map((r) => r.stage) } } });
      for (const r of b.rules) await tx.recoveryRule.upsert({ where: { stage: r.stage }, create: r, update: r });
    });
    return { before, after: await this.rules() };
  },
};

export const abandonScanJob = defineJob("carts.abandon-scan", async () => {
  await abandonedCartsService.scan();
});
