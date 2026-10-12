/**
 * Storefront merchandising that asl-web hard-codes today, so the web can render the same thing from
 * GET /store/announcements, /store/banners, /store/slots and /store/home:
 *  - announcement bar   ← asl-web StorefrontAnnouncementBar + announcements-store seed
 *  - banners            ← asl-admin banners-store seed (top bar, checkout trust strip, cart nudge, ribbons, concierge strip)
 *  - home / shop slots  ← asl-web HeroCarousel (heroSlides), DesktopHome / MobileHome PromoBanners, ConciergeBanner, HomeEditSections
 *  - sales slot         ← asl-web SalesHero
 * The free-shipping amount is never hard-coded: texts use {{freeShippingThreshold}} (filled from settings.shipping).
 * Idempotent: rows have fixed ids and are only created when missing, so admin edits survive a re-seed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient, Prisma } from "../../src/generated/prisma/client";
import { mediaService } from "../../src/modules/content/media/media.service";

const dir = path.dirname(fileURLToPath(import.meta.url));
const days = (d: number) => new Date(Date.now() + d * 86_400_000);

const announcements = (): Prisma.AnnouncementCreateManyInput[] => [
  {
    id: "ann_free_delivery", title: "Free Lagos delivery",
    message: "Complimentary same-day delivery in Lagos on orders over {{freeShippingThreshold}}.",
    ctaLabel: "Shop now", ctaHref: "/shop", style: "solid", bg: "#0d0d0d", fg: "#ffffff",
    placement: "site_top", audience: "everyone", device: "all", dismissible: true, priority: 10, status: "live", startsAt: days(-5),
  },
  {
    id: "ann_signature_preview", title: "Signature preview",
    message: "ASL Signature members: preview the new Loro Piana capsule tonight at 8pm.",
    ctaLabel: "Reserve seat", ctaHref: "/account/benefits", style: "gradient", bg: "linear-gradient(90deg,#0d0d0d,#3b2e12)", fg: "#f1d799",
    placement: "site_top", audience: "club_signature", device: "all", dismissible: true, priority: 8, status: "scheduled", startsAt: days(1), endsAt: days(3),
  },
  {
    id: "ann_checkout_wallet", title: "Checkout · wallet bonus",
    message: "Pay with ASL Wallet and earn 2x points on this order.",
    style: "minimal", bg: "#f7f2e6", fg: "#3f2f11",
    placement: "checkout_top", audience: "members", device: "all", dismissible: false, priority: 5, status: "live", startsAt: days(-30), endsAt: days(60),
  },
  {
    id: "ann_ramadan_hours", title: "Ramadan hours",
    message: "Concierge hours shift to 10am - 8pm through the holy month.",
    style: "outline", bg: "#ffffff", fg: "#0d0d0d",
    placement: "site_top", audience: "everyone", device: "all", dismissible: true, priority: 3, status: "expired", startsAt: days(-90), endsAt: days(-40),
    impressions: 42_100, clicks: 620, dismisses: 8_800,
  },
];

const banners = (): Prisma.BannerCreateManyInput[] => [
  {
    id: "bnr_free_shipping", name: "Free shipping site-wide", placement: "top_bar", priority: 1, status: "live", device: "all", audience: "all", style: "solid",
    message: "Complimentary shipping on orders over {{freeShippingThreshold}} · Lagos · Abuja · Port Harcourt",
    cta: "See details", linkTo: "/customer-care/shipping-policy", bg: "#0f0f0f", fg: "#faf6ea", accent: "#c9a86a", dismissible: false, icon: "truck", startsAt: days(-30),
  },
  {
    id: "bnr_signature_preview", name: "Signature member preview", placement: "top_bar", priority: 2, status: "live", device: "all", audience: "vip", style: "gradient",
    message: "Signature Members · First look at the winter drop", cta: "Enter preview", linkTo: "/shop/browse",
    bg: "#241a12", fg: "#e8c98f", accent: "#c9a86a", dismissible: true, icon: "crown", startsAt: days(-5), endsAt: days(20),
  },
  {
    id: "bnr_ramadan_edit", name: "Ramadan Edit · Scheduled", placement: "top_bar", priority: 3, status: "scheduled", device: "all", audience: "all", style: "gradient",
    message: "Ramadan Edit · Launching Friday", cta: "Notify me", linkTo: "/customer-care/contact-us",
    bg: "#2b1d3a", fg: "#faf6ea", accent: "#e8c98f", dismissible: true, icon: "sparkles", startsAt: days(3), endsAt: days(24),
  },
  {
    id: "bnr_nye_strip", name: "Old NYE strip", placement: "top_bar", priority: 4, status: "expired", device: "all", audience: "all", style: "solid",
    message: "Happy New Year · 24-hour flash sale", cta: "Shop now", linkTo: "/shop/sales",
    bg: "#0f0f0f", fg: "#e8c98f", accent: "#c9a86a", dismissible: true, icon: "sparkles", startsAt: days(-60), endsAt: days(-59),
    impressions: 208_400, clicks: 24_600, dismissals: 12_400,
  },
  {
    id: "bnr_cart_gift", name: "Cart · Add ₦20k for gift", placement: "cart_nudge", priority: 1, status: "live", device: "all", audience: "all", style: "outline",
    message: "Add ₦20,000 more and receive a complimentary fragrance sample.", cta: "Shop fragrance", linkTo: "/shop/fragrance",
    bg: "#faf6ea", fg: "#0f0f0f", accent: "#c9a86a", dismissible: true, icon: "gift", startsAt: days(-14),
  },
  {
    id: "bnr_checkout_trust", name: "Checkout · Trust strip", placement: "checkout", priority: 1, status: "live", device: "all", audience: "all", style: "solid",
    message: "Authenticated by ASL Concierge · 14-day returns on eligible items",
    bg: "#faf6ea", fg: "#0f0f0f", accent: "#0f0f0f", dismissible: false, icon: "sparkles", startsAt: days(-60),
  },
  {
    id: "bnr_sale_ribbon", name: "Sale · 40% off ribbon", placement: "category_ribbon", priority: 1, status: "live", device: "all", audience: "all", style: "gradient",
    message: "Up to 40% off · Ends Sunday at midnight", cta: "Shop sale", linkTo: "/shop/sales",
    bg: "#7a1420", fg: "#faf6ea", accent: "#e8c98f", dismissible: false, icon: "flame", startsAt: days(-6), endsAt: days(2),
  },
  {
    id: "bnr_stock_alert", name: "Product · Mobile stock alert", placement: "product_ribbon", priority: 1, status: "paused", device: "mobile", audience: "all", style: "solid",
    message: "Only 2 left in your size · Lagos warehouse", bg: "#faf6ea", fg: "#7a1420", accent: "#7a1420", dismissible: false, icon: "flame", startsAt: days(-10),
  },
  {
    id: "bnr_concierge_rare", name: "Concierge · Rare finds", placement: "concierge_strip", priority: 1, status: "live", device: "all", audience: "all", style: "solid",
    message: "Can't find it? Our sourcing desk covers 40+ luxury houses.", cta: "Start a request", linkTo: "/start-request",
    bg: "#0f0f0f", fg: "#faf6ea", accent: "#c9a86a", dismissible: true, icon: "sparkles", startsAt: days(-45),
  },
];

type SeedSlot = Omit<Prisma.SlotCreateManyInput, "imageUrl"> & { image?: string };

/** The web places product rows between these (Best Sellers after the heroes, New Arrivals after "Coming Soon", …). */
const slots = (): SeedSlot[] => {
  const heroes = (page: "home" | "shop", from: number): SeedSlot[] => [
    { id: `slot_${page}_hero_season`, image: "hero-sneakers", eyebrow: "NEW SEASON", headline: "PREMIUM STYLE.\nORIGINAL ALWAYS.",
      subhead: "Curated luxury streetwear & lifestyle pieces from the world's most exclusive brands." },
    { id: `slot_${page}_hero_culture`, image: "hero-bag", eyebrow: "ARRIVING NOW", headline: "CARRIED BY\nTHE CULTURE.",
      subhead: "Handpicked leather goods, sourced globally, delivered nationwide." },
    { id: `slot_${page}_hero_timeless`, image: "hero-watch", eyebrow: "TIMELESS", headline: "EVERY SECOND\nCOUNTS.",
      subhead: "Signature timepieces from icons of horology, ready to ship." },
  ].map((h, i) => ({
    ...h, name: `${page === "home" ? "Home" : "Shop"} hero · ${h.eyebrow}`, page, position: from + i, type: "hero", status: "live", device: "all", audience: "all",
    cta: "Shop Now", linkTo: "/shop", secondaryCta: "New Arrivals", secondaryLinkTo: "/new-arrivals", imageColor: "#0f0f0f", accent: "#c9a86a", startsAt: days(-10),
  }));
  const promo = (s: Omit<SeedSlot, "page" | "type" | "status" | "device" | "audience"> & { type?: string }): SeedSlot => ({
    page: "home", type: "banner", status: "live", device: "all", audience: "all", imageColor: "#0f0f0f", accent: "#c9a86a", startsAt: days(-10), ...s,
  });
  return [
    ...heroes("home", 1),
    promo({
      id: "slot_home_coming_soon", name: "Coming Soon · Reserve", position: 4, image: "hero-sneakers", eyebrow: "Coming Soon", headline: "RESERVE\nBEFORE IT DROPS.",
      subhead: "Secure upcoming drops with a 50% deposit. Balance payable on release day.", cta: "View Drops", linkTo: "/coming-soon",
      notes: "The web may swap the subhead / secondary button for the next drop (GET /store/drops).",
    }),
    promo({
      id: "slot_home_concierge", name: "Fashion Concierge", position: 5, image: "concierge", eyebrow: "Concierge", headline: "FASHION\nCONCIERGE",
      cta: "Start Request", linkTo: "/start-request", secondaryCta: "How It Works", secondaryLinkTo: "/how-it-works",
    }),
    promo({
      id: "slot_home_sneaker_edit", name: "The Sneaker Edit", position: 6, type: "editorial", image: "cat-footwear", eyebrow: "Curated for you", headline: "THE SNEAKER\nEDIT",
      subhead: "Hand-picked silhouettes from the houses that matter.", cta: "Shop Sneakers", linkTo: "/shop", secondaryCta: "All Brands", secondaryLinkTo: "/brands",
    }),
    promo({
      id: "slot_home_watch_edit", name: "The Watch Edit", position: 7, type: "editorial", image: "p-watch", eyebrow: "Timepieces", headline: "THE WATCH\nEDIT",
      subhead: "Precision, heritage, and statement pieces for the wrist.", cta: "Shop Watches", linkTo: "/shop", secondaryCta: "All Brands", secondaryLinkTo: "/brands",
    }),
    promo({
      id: "slot_home_back_in_stock", name: "Back in Stock", position: 8, type: "editorial", image: "cat-clothing", eyebrow: "Restocked", headline: "BACK IN\nSTOCK",
      subhead: "The pieces you asked for — returned in limited numbers.", cta: "Shop Restocks", linkTo: "/shop", secondaryCta: "New Arrivals", secondaryLinkTo: "/new-arrivals",
    }),
    promo({
      id: "slot_home_brands", name: "Discover More Brands", position: 9, image: "banner-brands", eyebrow: "The Directory", headline: "DISCOVER MORE\nBRANDS",
      subhead: "From street icons to heritage houses — explore them all.", cta: "View All Brands", linkTo: "/brands", secondaryCta: "Shop Now", secondaryLinkTo: "/shop",
    }),
    { id: "slot_home_ramadan", name: "Ramadan Edit (draft)", page: "home", position: 10, type: "hero", status: "draft", device: "all", audience: "all",
      headline: "Ramadan Edit · Coming Soon", cta: "Notify me", linkTo: "/customer-care/contact-us", imageColor: "#2b1d3a", accent: "#e8c98f", startsAt: days(20) },
    { id: "slot_home_fall", name: "Old Fall Hero", page: "home", position: 11, type: "hero", status: "expired", device: "all", audience: "all",
      headline: "The Fall Portfolio", subhead: "Autumn essentials, curated.", cta: "Shop fall", linkTo: "/shop", imageColor: "#3a2818", accent: "#c9a86a",
      startsAt: days(-90), endsAt: days(-20), impressions: 208_400, clicks: 14_600, revenue: 6_840_000_000n },
    ...heroes("shop", 1),
    { id: "slot_shop_sneaker_drop", name: "Sneaker Drop Countdown", page: "shop", position: 4, type: "countdown", status: "scheduled", device: "all", audience: "all",
      headline: "Sneaker Drop · Friday 6PM", subhead: "10 pairs. Members only.", cta: "Set reminder", linkTo: "/coming-soon",
      imageColor: "#101418", accent: "#c9a86a", startsAt: days(3), endsAt: days(4) },
    { id: "slot_sales_hero", name: "Sales hero", page: "sales", position: 1, type: "hero", status: "live", device: "all", audience: "all",
      eyebrow: "SALES", headline: "BIG STYLES.\nBETTER PRICES.", subhead: "Enjoy up to 50% off on your favorite items.", cta: "Shop All Sales", linkTo: "/shop/sales",
      imageColor: "#111111", accent: "#e11d48", startsAt: days(-10) },
  ];
};

export async function seedMerchandising(prisma: PrismaClient, log = console.log) {
  const a = await prisma.announcement.createMany({ data: announcements(), skipDuplicates: true });
  const b = await prisma.banner.createMany({ data: banners(), skipDuplicates: true });

  const all = slots();
  const existing = new Set((await prisma.slot.findMany({ where: { id: { in: all.map((s) => s.id!) } }, select: { id: true } })).map((s) => s.id));
  const urls = new Map<string, string>();
  async function image(name?: string) {
    if (!name) return null;
    if (!urls.has(name)) {
      const buffer = fs.readFileSync(path.join(dir, "assets/merch", `${name}.webp`));
      const asset = await mediaService.upload({ buffer, originalname: `${name}.webp`, mimetype: "image/webp", size: buffer.length }, "hero", "seed");
      urls.set(name, asset.url);
    }
    return urls.get(name)!;
  }
  let created = 0;
  for (const { image: img, ...s } of all.filter((x) => !existing.has(x.id!))) {
    const row = await prisma.slot.create({ data: { ...s, imageUrl: await image(img) } });
    if (row.imageUrl) await mediaService.syncUsage("slot", row.id, [row.imageUrl]);
    created++;
  }
  log(`merchandising: ${a.count} announcements, ${b.count} banners, ${created} slots added (${urls.size} images)`);
}
