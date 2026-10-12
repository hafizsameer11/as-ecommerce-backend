/** Reservation / drop rows → API shapes (asl-web reservation panel, asl-admin drops). */
import type { Prisma } from "@/generated/prisma/client";
import { env } from "@/config/env";
import { STATUS_LABELS } from "@/modules/platform/settings/status-labels";
import { customerBrief, fullName } from "@/modules/identity/auth/customer.mapper";
import type { SettingsOf } from "@/modules/platform/settings/settings.defaults";

export type DropsSettings = SettingsOf<"drops">;

const productBrief = {
  select: {
    id: true, handle: true, name: true, price: true, availability: true, status: true,
    brand: { select: { name: true } }, images: { take: 1, orderBy: { position: "asc" as const }, select: { url: true } },
  },
} as const;

export const reservationInclude = {
  drop: { include: { product: productBrief } },
  order: { select: { id: true, number: true, status: true } },
  customer: { select: customerBrief },
} satisfies Prisma.ReservationInclude;

export type ReservationRow = Prisma.ReservationGetPayload<{ include: typeof reservationInclude }>;

export const dropAdminInclude = { product: productBrief } satisfies Prisma.DropInclude;
export type DropAdminRow = Prisma.DropGetPayload<{ include: typeof dropAdminInclude }>;

const HOUR = 3_600_000;
/** the balance can be paid from release until this moment */
export const balanceDueBy = (releaseAt: Date, s: DropsSettings) => new Date(releaseAt.getTime() + s.balanceWindowHours * HOUR);
/** customers can cancel (deposit back) until this moment */
export const cancelBy = (releaseAt: Date, s: DropsSettings) => new Date(releaseAt.getTime() - s.cancelCutoffHours * HOUR);
export const reservationUrl = (number: string) => `${env.WEB_URL.replace(/\/$/, "")}/account/orders?reservation=${encodeURIComponent(number)}`;

const released = (status: string) => status === "live" || status === "sold_out";

/** /account → reservation panel + timeline */
export function toCustomerReservation(r: ReservationRow, s: DropsSettings, now = new Date()) {
  const d = r.drop;
  const dueBy = balanceDueBy(d.releaseAt, s);
  const cancelDeadline = cancelBy(d.releaseAt, s);
  const depositPaid = !!r.depositPaidAt;
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    statusLabel: STATUS_LABELS.reservation.customer[r.status],
    drop: { id: d.id, status: d.status, statusLabel: STATUS_LABELS.drop[d.status], releaseAt: d.releaseAt },
    product: { id: d.product.handle, productId: d.product.id, name: d.product.name, brand: d.product.brand.name, image: d.product.images[0]?.url ?? null },
    size: r.size,
    color: r.color,
    price: r.price,
    deposit: r.deposit,
    balance: r.balance,
    depositPaid,
    depositPaidAt: r.depositPaidAt,
    /** what is still owed (0 once paid, cancelled or expired) */
    balanceDue: r.status === "reserved" ? r.balance : 0,
    balancePaidAt: r.balancePaidAt,
    payBalance: {
      opensAt: d.releaseAt,
      dueBy,
      open: r.status === "reserved" && released(d.status) && now <= dueBy,
    },
    /** unpaid deposit: the allocation is held until then */
    holdExpiresAt: r.status === "pending_deposit" ? r.holdExpiresAt : null,
    canCancel: r.status === "pending_deposit" || (r.status === "reserved" && d.status === "upcoming" && now < cancelDeadline),
    cancelBy: cancelDeadline,
    depositRefunded: r.depositRefunded,
    depositOutcome: r.depositOutcome,
    order: r.order ? { id: r.order.id, number: r.order.number } : null,
    cancelledAt: r.cancelledAt,
    cancelReason: r.cancelReason,
    expiredAt: r.expiredAt,
    createdAt: r.createdAt,
  };
}

/** asl-admin drop → reservations table */
export function toAdminReservation(r: ReservationRow, s: DropsSettings) {
  const c = toCustomerReservation(r, s);
  return {
    ...c,
    statusLabel: STATUS_LABELS.reservation.admin[r.status],
    customer: { id: r.customer.id, name: fullName(r.customer), email: r.customer.email },
    order: r.order ? { id: r.order.id, number: r.order.number, status: r.order.status } : null,
  };
}

export type DropStats = {
  pending: number; reserved: number; converted: number; expired: number; cancelled: number;
  paidCount: number; depositsCollected: number; depositsHeld: number; depositsRefunded: number; forfeited: number;
};
export const emptyStats = (): DropStats => ({
  pending: 0, reserved: 0, converted: 0, expired: 0, cancelled: 0, paidCount: 0, depositsCollected: 0, depositsHeld: 0, depositsRefunded: 0, forfeited: 0,
});

export function toAdminDrop(d: DropAdminRow, st: DropStats) {
  return {
    id: d.id,
    product: { id: d.product.id, handle: d.product.handle, name: d.product.name, brand: d.product.brand.name, image: d.product.images[0]?.url ?? null, price: d.product.price },
    releaseAt: d.releaseAt,
    status: d.status,
    statusLabel: STATUS_LABELS.drop[d.status],
    allocation: d.allocation,
    reservedCount: d.reservedCount,
    remaining: Math.max(0, d.allocation - d.reservedCount - st.pending),
    depositPct: d.depositPct,
    teaser: d.teaser,
    stats: {
      ...st,
      /** share of paid reservations that became orders */
      conversionPct: st.paidCount ? Math.round((st.converted / st.paidCount) * 1000) / 10 : 0,
      fillPct: d.allocation ? Math.round((d.reservedCount / d.allocation) * 1000) / 10 : 0,
    },
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}
