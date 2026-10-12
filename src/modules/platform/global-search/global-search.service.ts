/**
 * Admin ⌘K command palette: top matches per entity, each group only when the caller holds
 * its view permission. Plain LIKE (`contains`, case-insensitive under the MySQL collation),
 * newest first; groups run in parallel.
 */
import { prisma } from "@/core/db/prisma";
import type { Permission } from "@/core/auth/permissions";
import { fullName } from "@/modules/identity/auth/customer.mapper";
import type { GlobalSearchQuery } from "./global-search.schemas";

export type SearchHit = { id: string; title: string; subtitle: string; link: string; amount?: number; status?: string };
export type SearchGroup = { key: string; label: string; permission: Permission; items: SearchHit[] };

const words = (q: string) => q.split(/\s+/).filter(Boolean).slice(0, 4);

async function orders(q: string, take: number): Promise<SearchHit[]> {
  const rows = await prisma.order.findMany({
    where: { OR: [{ number: { contains: q } }, { guestEmail: { contains: q } }, { customer: { email: { contains: q } } }] },
    orderBy: { placedAt: "desc" },
    take,
    select: { id: true, number: true, status: true, total: true, guestEmail: true, customer: { select: { firstName: true, lastName: true, email: true } } },
  });
  return rows.map((o) => ({
    id: o.id,
    title: o.number,
    subtitle: o.customer ? `${fullName(o.customer) || o.customer.email} · ${o.customer.email}` : (o.guestEmail ?? "Guest"),
    amount: o.total,
    status: o.status,
    link: `/orders/${o.id}`,
  }));
}

async function customers(q: string, take: number): Promise<SearchHit[]> {
  const w = words(q);
  const nameMatch = w.length > 1 ? [{ AND: w.map((t) => ({ OR: [{ firstName: { contains: t } }, { lastName: { contains: t } }] })) }] : [];
  const rows = await prisma.customer.findMany({
    where: {
      deletedAt: null,
      OR: [{ email: { contains: q } }, { phone: { contains: q.replace(/[\s()-]/g, "") } }, { firstName: { contains: q } }, { lastName: { contains: q } }, ...nameMatch],
    },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, firstName: true, lastName: true, email: true, phone: true, status: true },
  });
  return rows.map((c) => ({
    id: c.id, title: fullName(c) || c.email, subtitle: [c.email, c.phone].filter(Boolean).join(" · "), status: c.status, link: `/customers?id=${c.id}`,
  }));
}

async function products(q: string, take: number): Promise<SearchHit[]> {
  const rows = await prisma.product.findMany({
    where: { OR: [{ name: { contains: q } }, { handle: { contains: q } }, { variants: { some: { sku: { contains: q } } } }] },
    orderBy: { updatedAt: "desc" },
    take,
    select: { id: true, name: true, handle: true, price: true, status: true, variants: { select: { sku: true }, take: 1 } },
  });
  return rows.map((p) => ({
    id: p.id, title: p.name, subtitle: [p.variants[0]?.sku, p.handle].filter(Boolean).join(" · "), amount: p.price, status: p.status, link: `/products?id=${p.id}`,
  }));
}

async function concierge(q: string, take: number): Promise<SearchHit[]> {
  const rows = await prisma.conciergeRequest.findMany({
    where: { OR: [{ number: { contains: q } }, { itemName: { contains: q } }, { contactEmail: { contains: q } }, { contactName: { contains: q } }] },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, number: true, itemName: true, brand: true, contactName: true, status: true },
  });
  return rows.map((r) => ({
    id: r.id, title: `${r.number} · ${[r.brand, r.itemName].filter(Boolean).join(" ")}`, subtitle: r.contactName, status: r.status, link: `/concierge/inbox?id=${r.id}`,
  }));
}

async function tickets(q: string, take: number): Promise<SearchHit[]> {
  const rows = await prisma.ticket.findMany({
    where: { OR: [{ number: { contains: q } }, { subject: { contains: q } }, { customerEmail: { contains: q } }] },
    orderBy: { updatedAt: "desc" },
    take,
    select: { id: true, number: true, subject: true, customerName: true, status: true },
  });
  return rows.map((t) => ({ id: t.id, title: `${t.number} · ${t.subject}`, subtitle: t.customerName, status: t.status, link: `/tickets?id=${t.id}` }));
}

const GROUPS: { key: string; label: string; permission: Permission; run: (q: string, take: number) => Promise<SearchHit[]> }[] = [
  { key: "orders", label: "Orders", permission: "orders.view", run: orders },
  { key: "customers", label: "Customers", permission: "customers.view", run: customers },
  { key: "products", label: "Products", permission: "catalog.view", run: products },
  { key: "concierge", label: "Concierge requests", permission: "concierge.view", run: concierge },
  { key: "tickets", label: "Tickets", permission: "support.tickets", run: tickets },
];

async function search(query: GlobalSearchQuery, perms: Set<Permission>) {
  const q = query.q.trim();
  const allowed = GROUPS.filter((g) => perms.has(g.permission));
  const results = await Promise.all(allowed.map(async (g) => ({ key: g.key, label: g.label, permission: g.permission, items: await g.run(q, query.limit) })));
  return { q, groups: results.filter((g) => g.items.length) as SearchGroup[], total: results.reduce((n, g) => n + g.items.length, 0) };
}

export const globalSearchService = { search };
