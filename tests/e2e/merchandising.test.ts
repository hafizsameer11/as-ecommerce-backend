import { beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { api, bearer, createAdmin, registerCustomer } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { prisma } from "@/core/db/prisma";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { impressionsService } from "@/modules/marketing/impressions/impressions.service";
import { seedMerchandising } from "../../prisma/seed/merchandising";

const S = "/api/v1/store";
const A = "/api/v1/admin";
const N = (naira: number) => naira * 100;
const hour = 3_600_000;

let admin: string;
let marketing: string;
let editor: string;
let support: string;
let gold: string;
let standard: string;

beforeAll(async () => {
  await resetDb();
  await seedMerchandising(prisma, () => undefined);
  [admin, marketing, editor, support] = (await Promise.all([createAdmin(), createAdmin("marketing"), createAdmin("content_editor"), createAdmin("support")])).map((a) => a.token);
  const g = await registerCustomer({ name: "Gold Member" });
  await prisma.customer.update({ where: { id: g.customer.id }, data: { tier: "Gold" } });
  gold = g.token;
  standard = (await registerCustomer({ name: "Standard Member" })).token;
}, 60_000);

describe("seeded storefront merchandising", () => {
  it("is idempotent (a second seed adds nothing)", async () => {
    const before = await Promise.all([prisma.banner.count(), prisma.announcement.count(), prisma.slot.count()]);
    await seedMerchandising(prisma, () => undefined);
    expect(await Promise.all([prisma.banner.count(), prisma.announcement.count(), prisma.slot.count()])).toEqual(before);
  });

  it("serves the announcement bar with the real free-shipping threshold from settings", async () => {
    const r = await api().get(`${S}/announcements?placement=site_top`);
    expect(r.status).toBe(200);
    expect(r.body.data[0].id).toBe("ann_free_delivery");
    expect(r.body.data[0].message).toBe("Complimentary same-day delivery in Lagos on orders over ₦150,000.");
    // scheduled + expired ones are not served
    expect(r.body.data.map((a: any) => a.id)).not.toContain("ann_ramadan_hours");
    expect(r.body.data.map((a: any) => a.id)).not.toContain("ann_signature_preview");

    await settingsService.update("shipping", { freeShippingThreshold: N(200_000) }, "test");
    const after = await api().get(`${S}/announcements`);
    expect(after.body.data[0].message).toContain("₦200,000");
    const top = await api().get(`${S}/banners?placement=top_bar`);
    expect(top.body.data[0].message).toBe("Complimentary shipping on orders over ₦200,000 · Lagos · Abuja · Port Harcourt");
    await settingsService.update("shipping", { freeShippingThreshold: N(150_000) }, "test");

    // the admin sees the raw template
    const raw = await api().get(`${A}/announcements/ann_free_delivery`).set(bearer(admin));
    expect(raw.body.data.message).toContain("{{freeShippingThreshold}}");
  });

  it("serves home + sales slots like the web renders them today", async () => {
    const home = await api().get(`${S}/home`);
    expect(home.status).toBe(200);
    expect(home.body.data.hero.map((h: any) => h.eyebrow)).toEqual(["NEW SEASON", "ARRIVING NOW", "TIMELESS"]);
    expect(home.body.data.hero[0].imageUrl).toMatch(/\.webp$/);
    expect(home.body.data.slots.map((s: any) => s.headline)).toEqual([
      "RESERVE\nBEFORE IT DROPS.", "FASHION\nCONCIERGE", "THE SNEAKER\nEDIT", "THE WATCH\nEDIT", "BACK IN\nSTOCK", "DISCOVER MORE\nBRANDS",
    ]);
    const concierge = home.body.data.slots[1];
    expect(concierge).toMatchObject({ cta: "Start Request", linkTo: "/start-request", secondaryCta: "How It Works", secondaryLinkTo: "/how-it-works" });
    expect(concierge.impressions).toBeUndefined(); // counters are admin-only

    const sales = await api().get(`${S}/slots?page=sales`);
    expect(sales.body.data).toHaveLength(1);
    expect(sales.body.data[0]).toMatchObject({ eyebrow: "SALES", cta: "Shop All Sales" });
    // seeded slot images are in the media library (folder hero) with a usage per slot
    const asset = await prisma.mediaAsset.findFirst({ where: { url: home.body.data.hero[0].imageUrl }, include: { usages: true } });
    expect(asset?.folder).toBe("hero");
    expect(asset?.usages.map((u) => u.entityType)).toContain("slot");
  });
});

describe("audience + device", () => {
  it("announcements: guests vs Gold members (club_gold, members-only checkout)", async () => {
    const c = await api().post(`${A}/announcements`).set(bearer(marketing)).send({
      title: "Gold early access", message: "Gold members: early access to the sale.", audience: "club_gold", priority: 50, status: "live",
    });
    expect(c.status).toBe(201);
    expect(c.body.data.status).toBe("live");

    const guest = await api().get(`${S}/announcements`);
    const goldR = await api().get(`${S}/announcements`).set(bearer(gold));
    const std = await api().get(`${S}/announcements`).set(bearer(standard));
    expect(guest.body.data.map((a: any) => a.id)).not.toContain(c.body.data.id);
    expect(std.body.data.map((a: any) => a.id)).not.toContain(c.body.data.id);
    expect(goldR.body.data[0].id).toBe(c.body.data.id); // highest priority first
    // checkout_top "members" bar: members yes, guests no
    expect(guest.body.data.map((a: any) => a.id)).not.toContain("ann_checkout_wallet");
    expect(std.body.data.map((a: any) => a.id)).toContain("ann_checkout_wallet");
    const checkout = await api().get(`${S}/announcements?placement=checkout_top`).set(bearer(gold));
    expect(checkout.body.data.map((a: any) => a.id)).toEqual(["ann_checkout_wallet"]);
  });

  it("banners: vip (Gold+) strip only for Gold; device filter", async () => {
    const guest = await api().get(`${S}/banners?placement=top_bar`);
    const goldR = await api().get(`${S}/banners?placement=top_bar`).set(bearer(gold));
    expect(guest.body.data.map((b: any) => b.id)).toEqual(["bnr_free_shipping"]);
    expect(goldR.body.data.map((b: any) => b.id)).toEqual(["bnr_free_shipping", "bnr_signature_preview"]);

    const m = await api().post(`${A}/banners`).set(bearer(admin)).send({
      name: "Mobile app nudge", placement: "cart_nudge", device: "mobile", message: "Get the app for faster checkout", status: "live",
    });
    expect(m.status).toBe(201);
    expect(m.body.data.priority).toBe(2); // appended after the seeded cart nudge
    const mobile = await api().get(`${S}/banners?placement=cart_nudge&device=mobile`);
    const desktop = await api().get(`${S}/banners?placement=cart_nudge&device=desktop`);
    expect(mobile.body.data.map((b: any) => b.id)).toEqual(["bnr_cart_gift", m.body.data.id]);
    expect(desktop.body.data.map((b: any) => b.id)).toEqual(["bnr_cart_gift"]);
  });

  it("slots: a vip home slot appears in /home only for Gold", async () => {
    const s = await api().post(`${A}/slots`).set(bearer(editor)).send({
      name: "VIP Preview Carousel", page: "home", type: "carousel", audience: "vip", headline: "Signature Members · First Look", status: "live",
    });
    expect(s.status).toBe(201);
    const guest = await api().get(`${S}/home`);
    const goldR = await api().get(`${S}/home`).set(bearer(gold));
    expect(guest.body.data.slots.map((x: any) => x.id)).not.toContain(s.body.data.id);
    expect(goldR.body.data.slots.map((x: any) => x.id)).toContain(s.body.data.id);
    await api().delete(`${A}/slots/${s.body.data.id}`).set(bearer(editor)).expect(200);
  });
});

describe("schedule", () => {
  it("live with a future start is stored as scheduled; the job flips scheduled → live → expired", async () => {
    const now = Date.now();
    const b = await api().post(`${A}/banners`).set(bearer(admin)).send({
      name: "Flash sale", placement: "top_bar", message: "Flash sale · 3 hours only", status: "live",
      startsAt: new Date(now + hour).toISOString(), endsAt: new Date(now + 4 * hour).toISOString(),
    });
    const a = await api().post(`${A}/announcements`).set(bearer(admin)).send({
      title: "Flash", message: "Flash sale starts soon", status: "live", startsAt: new Date(now + hour).toISOString(), endsAt: new Date(now + 4 * hour).toISOString(),
    });
    const s = await api().post(`${A}/slots`).set(bearer(admin)).send({
      name: "Flash hero", page: "sales", type: "countdown", headline: "Flash sale", status: "live",
      startsAt: new Date(now + hour).toISOString(), endsAt: new Date(now + 4 * hour).toISOString(),
    });
    expect([b.body.data.status, a.body.data.status, s.body.data.status]).toEqual(["scheduled", "scheduled", "scheduled"]);
    expect((await api().get(`${S}/banners?placement=top_bar`)).body.data.map((x: any) => x.id)).not.toContain(b.body.data.id);

    const r1 = await impressionsService.runSchedule(new Date(now + 2 * hour));
    expect(r1.live).toMatchObject({ banners: 1, announcements: 1, slots: 1 });
    const rows = await Promise.all([
      prisma.banner.findUnique({ where: { id: b.body.data.id } }),
      prisma.announcement.findUnique({ where: { id: a.body.data.id } }),
      prisma.slot.findUnique({ where: { id: s.body.data.id } }),
    ]);
    expect(rows.map((x) => x?.status)).toEqual(["live", "live", "live"]);

    const r2 = await impressionsService.runSchedule(new Date(now + 5 * hour));
    expect(r2.expired.banners).toBeGreaterThanOrEqual(1);
    const after = await Promise.all([
      prisma.banner.findUnique({ where: { id: b.body.data.id } }),
      prisma.announcement.findUnique({ where: { id: a.body.data.id } }),
      prisma.slot.findUnique({ where: { id: s.body.data.id } }),
    ]);
    expect(after.map((x) => x?.status)).toEqual(["expired", "expired", "expired"]);

    // can't publish something whose window already ended
    const bad = await api().patch(`${A}/banners/${b.body.data.id}/status`).set(bearer(admin)).send({ status: "live" });
    expect(bad.status).toBe(200); // window (now+1h..now+4h) is still in the future in real time → scheduled
    expect(bad.body.data.status).toBe("scheduled");
    await prisma.banner.update({ where: { id: b.body.data.id }, data: { endsAt: new Date(now - hour), startsAt: new Date(now - 2 * hour) } });
    const ended = await api().patch(`${A}/banners/${b.body.data.id}/status`).set(bearer(admin)).send({ status: "live" });
    expect(ended.status).toBe(400);
    expect(ended.body.error.code).toBe("INVALID_STATE");
    // clean up: these were for the job only
    await api().delete(`${A}/banners/${b.body.data.id}`).set(bearer(admin)).expect(200);
    await api().delete(`${A}/announcements/${a.body.data.id}`).set(bearer(admin)).expect(200);
    await api().delete(`${A}/slots/${s.body.data.id}`).set(bearer(admin)).expect(200);
  });
});

describe("admin", () => {
  it("reorders slots within a page and moves banners up / down", async () => {
    const list = await api().get(`${A}/slots?slotPage=home&pageSize=50`).set(bearer(editor));
    expect(list.status).toBe(200);
    expect(list.body.meta.tabs).toMatchObject({ live: 9, draft: 1, expired: 1 });
    expect(list.body.meta.pages.find((p: any) => p.page === "home")).toMatchObject({ total: 11, live: 9 });
    const ids: string[] = list.body.data.map((s: any) => s.id);
    expect(ids.slice(0, 3)).toEqual(["slot_home_hero_season", "slot_home_hero_culture", "slot_home_hero_timeless"]);

    // brands promo to the top
    const r = await api().post(`${A}/slots/reorder`).set(bearer(editor)).send({ page: "home", ids: ["slot_home_brands", "slot_home_hero_season"] });
    expect(r.status).toBe(200);
    expect(r.body.data.slice(0, 3).map((s: any) => [s.id, s.position])).toEqual([["slot_home_brands", 1], ["slot_home_hero_season", 2], ["slot_home_hero_culture", 3]]);
    expect(r.body.data.at(-1).position).toBe(11);
    const home = await api().get(`${S}/slots?page=home`);
    expect(home.body.data[0].id).toBe("slot_home_brands");
    // ids from another page are rejected
    expect((await api().post(`${A}/slots/reorder`).set(bearer(editor)).send({ page: "home", ids: ["slot_sales_hero"] })).status).toBe(400);
    // move + pin
    const mv = await api().post(`${A}/slots/slot_home_brands/move`).set(bearer(editor)).send({ direction: "down" });
    expect(mv.body.data.slice(0, 2).map((s: any) => s.id)).toEqual(["slot_home_hero_season", "slot_home_brands"]);
    const pin = await api().post(`${A}/slots/slot_home_concierge/pin`).set(bearer(editor));
    expect(pin.body.data.pinned).toBe(true);
    expect((await api().get(`${S}/slots?page=home`)).body.data[0].id).toBe("slot_home_concierge");
    await api().post(`${A}/slots/slot_home_concierge/pin`).set(bearer(editor)).expect(200);

    const up = await api().post(`${A}/banners/bnr_signature_preview/move`).set(bearer(marketing)).send({ direction: "up" });
    expect(up.body.data.slice(0, 2).map((b: any) => b.id)).toEqual(["bnr_signature_preview", "bnr_free_shipping"]);
    const back = await api().post(`${A}/banners/reorder`).set(bearer(marketing)).send({ placement: "top_bar", ids: ["bnr_free_shipping"] });
    expect(back.body.data.map((b: any) => [b.id, b.priority])).toEqual([
      ["bnr_free_shipping", 1], ["bnr_signature_preview", 2], ["bnr_ramadan_edit", 3], ["bnr_nye_strip", 4],
    ]);
  });

  it("CRUD, duplicate, status, template check, list tabs", async () => {
    const bad = await api().post(`${A}/banners`).set(bearer(admin)).send({ name: "x", placement: "top_bar", message: "Spend {{minimumSpend}}" });
    expect(bad.status).toBe(400);
    const c = await api().post(`${A}/banners`).set(bearer(admin)).send({ name: "Draft strip", placement: "checkout", message: "Free gift wrap over {{freeShippingThreshold}}" });
    expect(c.body.data).toMatchObject({ status: "draft", priority: 2, bg: "#0f0f0f" });
    const u = await api().patch(`${A}/banners/${c.body.data.id}`).set(bearer(admin)).send({ cta: "Learn more" });
    expect(u.body.data).toMatchObject({ cta: "Learn more", bg: "#0f0f0f", status: "draft", device: "all" }); // PATCH keeps other fields
    const d = await api().post(`${A}/banners/${c.body.data.id}/duplicate`).set(bearer(admin));
    expect(d.body.data).toMatchObject({ name: "Draft strip (copy)", status: "draft", priority: 3 });
    const live = await api().patch(`${A}/banners/${d.body.data.id}/status`).set(bearer(admin)).send({ status: "live" });
    expect(live.body.data.status).toBe("live");
    const store = await api().get(`${S}/banners?placement=checkout`);
    expect(store.body.data.map((b: any) => b.message)).toContain("Free gift wrap over ₦150,000");

    const list = await api().get(`${A}/banners?placement=checkout`).set(bearer(admin));
    expect(list.body.meta.tabs).toMatchObject({ all: 3, live: 2, draft: 1 });
    expect(list.body.meta.placements.find((p: any) => p.placement === "checkout")).toMatchObject({ total: 3, live: 2 });
    const drafts = await api().get(`${A}/banners?placement=checkout&status=draft`).set(bearer(admin));
    expect(drafts.body.data.map((b: any) => b.id)).toEqual([c.body.data.id]);

    const ann = await api().post(`${A}/announcements/ann_free_delivery/duplicate`).set(bearer(admin));
    expect(ann.body.data).toMatchObject({ title: "Free Lagos delivery (copy)", status: "paused", impressions: 0 });
    await api().delete(`${A}/announcements/${ann.body.data.id}`).set(bearer(admin)).expect(200);
    await api().delete(`${A}/banners/${c.body.data.id}`).set(bearer(admin)).expect(200);
    await api().delete(`${A}/banners/${d.body.data.id}`).set(bearer(admin)).expect(200);
    expect((await api().get(`${A}/banners/${c.body.data.id}`).set(bearer(admin))).status).toBe(404);
    const audit = await prisma.auditEvent.findFirst({ where: { action: "banner.status_changed" } });
    expect(audit?.category).toBe("marketing");
  });

  it("uploads a slot image into the media library (hero folder) or takes a URL", async () => {
    const png = await sharp({ create: { width: 1200, height: 600, channels: 3, background: "#7a1420" } }).png().toBuffer();
    const r = await api().post(`${A}/slots/slot_sales_hero/image`).set(bearer(editor)).field("folder", "campaigns").attach("file", png, { filename: "sale.png", contentType: "image/png" });
    expect(r.status).toBe(200);
    expect(r.body.data.imageUrl).toMatch(/\.webp$/);
    const asset = await prisma.mediaAsset.findFirst({ where: { url: r.body.data.imageUrl }, include: { usages: true } });
    expect(asset?.folder).toBe("campaigns");
    expect(asset?.usages).toEqual([expect.objectContaining({ entityType: "slot", entityId: "slot_sales_hero" })]);

    const url = await api().patch(`${A}/slots/slot_sales_hero`).set(bearer(editor)).send({ imageUrl: "https://cdn.example.com/sale.jpg" });
    expect(url.body.data.imageUrl).toBe("https://cdn.example.com/sale.jpg");
    expect(await prisma.mediaUsage.count({ where: { entityType: "slot", entityId: "slot_sales_hero" } })).toBe(0);
    expect((await api().patch(`${A}/slots/slot_sales_hero`).set(bearer(editor)).send({ imageUrl: "javascript:alert(1)" })).status).toBe(400);
  });

  it("permissions: support 403, content editor + marketing allowed, anonymous 401", async () => {
    for (const path of ["/banners", "/announcements", "/slots"]) {
      expect((await api().get(`${A}${path}`).set(bearer(support))).status).toBe(403);
      expect((await api().get(`${A}${path}`).set(bearer(editor))).status).toBe(200);
      expect((await api().get(`${A}${path}`).set(bearer(marketing))).status).toBe(200);
      expect((await api().get(`${A}${path}`)).status).toBe(401);
    }
    expect((await api().post(`${A}/banners`).set(bearer(support)).send({ name: "x", placement: "top_bar", message: "x" })).status).toBe(403);
    expect((await api().post(`${A}/slots/slot_home_brands/pin`).set(bearer(support))).status).toBe(403);
    // the admin-app bar is readable by any staff
    expect((await api().get(`${A}/announcements/admin-bar`).set(bearer(support))).status).toBe(200);
  });
});

describe("impressions", () => {
  it("batches events into counters (anonymous); unknown ids ignored; max 50", async () => {
    const r = await api().post(`${S}/impressions`).send([
      { kind: "banner", id: "bnr_free_shipping", event: "impression" },
      { kind: "banner", id: "bnr_free_shipping", event: "impression" },
      { kind: "banner", id: "bnr_free_shipping", event: "impression" },
      { kind: "banner", id: "bnr_free_shipping", event: "impression" },
      { kind: "banner", id: "bnr_free_shipping", event: "click" },
      { kind: "announcement", id: "ann_free_delivery", event: "impression" },
      { kind: "announcement", id: "ann_free_delivery", event: "dismiss" },
      { kind: "slot", id: "slot_home_concierge", event: "impression" },
      { kind: "slot", id: "slot_home_concierge", event: "click" },
      { kind: "slot", id: "slot_home_concierge", event: "dismiss" },
      { kind: "slot", id: "nope", event: "click" },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ received: 11, recorded: 9 });
    // { events: [...] } form (sendBeacon) works too
    await api().post(`${S}/impressions`).set(bearer(gold)).send({ events: [{ kind: "announcement", id: "ann_free_delivery", event: "click" }] }).expect(200);

    const b = await api().get(`${A}/banners/bnr_free_shipping`).set(bearer(admin));
    expect(b.body.data).toMatchObject({ impressions: 4, clicks: 1, dismissals: 0, ctr: 25 });
    const a = await api().get(`${A}/announcements/ann_free_delivery`).set(bearer(admin));
    expect(a.body.data).toMatchObject({ impressions: 1, clicks: 1, dismisses: 1, ctr: 100 });
    const s = await api().get(`${A}/slots/slot_home_concierge`).set(bearer(admin));
    expect(s.body.data).toMatchObject({ impressions: 1, clicks: 1, ctr: 100 });
    const kpis = (await api().get(`${A}/banners?placement=top_bar`).set(bearer(admin))).body.meta.kpis;
    expect(kpis).toMatchObject({ impressions: 4 + 208_400, clicks: 1 + 24_600 });

    const many = Array.from({ length: 51 }, () => ({ kind: "banner", id: "bnr_free_shipping", event: "impression" }));
    expect((await api().post(`${S}/impressions`).send(many)).status).toBe(400);
    expect((await api().post(`${S}/impressions`).send([{ kind: "coupon", id: "x", event: "impression" }])).status).toBe(400);
  });
});
