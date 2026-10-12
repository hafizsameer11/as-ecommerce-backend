import { beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { api, bearer, createAdmin, registerCustomer } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { prisma } from "@/core/db/prisma";
import { seedCatalog } from "../../prisma/seed/catalog";
import { seedContent } from "../../prisma/seed/content";
import { publishScheduledContent } from "@/modules/content/content.jobs";

const S = "/api/v1/store";
const A = "/api/v1/admin";

let admin: string;
let support: string;
let editor: string;
let png: Buffer;

beforeAll(async () => {
  await resetDb();
  await seedCatalog(prisma, () => undefined);
  await seedContent(prisma, () => undefined);
  admin = (await createAdmin("super_admin")).token;
  support = (await createAdmin("support")).token;
  editor = (await createAdmin("content_editor")).token;
  png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#cc5000" } }).png().toBuffer();
}, 240_000);

const text = (o: unknown) => JSON.stringify(o);

describe("seeded CMS pages", () => {
  it("return policy renders the return window from settings, and follows a settings change", async () => {
    const r = await api().get(`${S}/content/pages/customer-care/return-policy`).expect(200);
    expect(r.body.data.title).toBe("Return Policy");
    expect(r.body.data.path).toBe("/customer-care/return-policy");
    expect(text(r.body.data.blocks)).toContain("<strong>7 days</strong>");
    expect(r.body.data.subtitle).toBe("Not completely happy? We accept returns within 7 days of delivery.");
    expect(text(r.body.data)).not.toContain("{{");

    await api().patch(`${A}/settings/returns`).set(bearer(admin)).send({ windowDays: 14 }).expect(200);
    const after = await api().get(`${S}/content/pages/customer-care/return-policy`).expect(200);
    expect(text(after.body.data.blocks)).toContain("<strong>14 days</strong>");
    expect(after.body.data.seo.description).toContain("within 14 days");
    // FAQs use the same value
    const faqs = await api().get(`${S}/content/faqs?category=returns`).expect(200);
    expect(faqs.body.data.find((f: { question: string }) => f.question === "What is your return and refund policy?").answer).toContain("within 14 days");
    await api().patch(`${A}/settings/returns`).set(bearer(admin)).send({ windowDays: 7 }).expect(200);
  });

  it("shipping policy builds its fee + time tables from the shipping zones (not the old ₦15,000 copy)", async () => {
    const r = await api().get(`${S}/content/pages/customer-care/shipping-policy`).expect(200);
    const s = text(r.body.data.blocks);
    expect(s).toContain("<table>");
    expect(s).toContain("₦4,000");
    expect(s).toContain("Same day delivery");
    expect(s).toContain("free over ₦150,000");
    expect(s).not.toContain("₦15,000");
  });

  it("navigation lists header + footer links", async () => {
    const r = await api().get(`${S}/content/navigation`).expect(200);
    const header = r.body.data.header.map((l: { href: string }) => l.href);
    expect(header).toEqual(expect.arrayContaining(["/customer-care/about-us", "/how-it-works"]));
    const footer = r.body.data.footer.map((l: { href: string }) => l.href);
    expect(footer).toContain("/customer-care/privacy-policy");
    expect(r.body.data.footerGroups.find((g: { title: string }) => g.title === "Legal").links.length).toBeGreaterThanOrEqual(5);
  });

  it("unknown / draft pages are 404 and members-only pages need a login", async () => {
    await api().get(`${S}/content/pages/nope`).expect(404);
    const p = await api().post(`${A}/content/pages`).set(bearer(admin))
      .send({ title: "Club Benefits", slug: "/club/benefits", visibility: "members", status: "published", blocks: [{ type: "hero", title: "Members only" }] }).expect(201);
    expect(p.body.data.slug).toBe("club/benefits");
    await api().get(`${S}/content/pages/club/benefits`).expect(401);
    const c = await registerCustomer();
    const r = await api().get(`${S}/content/pages/club/benefits`).set(bearer(c.token)).expect(200);
    expect(r.body.data.blocks[0].title).toBe("Members only");

    const d = await api().post(`${A}/content/pages`).set(bearer(admin)).send({ title: "Secret Draft" }).expect(201);
    await api().get(`${S}/content/pages/${d.body.data.slug}`).expect(404);
    await api().get(`${A}/content/pages/${d.body.data.id}/preview`).set(bearer(admin)).expect(200);
  });
});

describe("page editor", () => {
  let id: string;

  it("sanitises rich text: <script> and event handlers are stripped, safe markup kept", async () => {
    const r = await api().post(`${A}/content/pages`).set(bearer(admin)).send({
      title: "Story <b>time</b>", slug: "story-time",
      blocks: [{ type: "rich_text", body: '<p onclick="steal()">Hello <strong>there</strong></p><script>alert(1)</script><a href="javascript:alert(1)">x</a><img src="x" onerror="alert(1)">' }],
    }).expect(201);
    id = r.body.data.id;
    expect(r.body.data.title).toBe("Story time");
    const body = r.body.data.blocks[0].body as string;
    expect(body).toContain("<strong>there</strong>");
    expect(body).not.toContain("<script");
    expect(body).not.toContain("onclick");
    expect(body).not.toContain("javascript:");
    expect(body).not.toContain("onerror");
  });

  it("blocks: add (defaults), update (validated per type), move, remove", async () => {
    const added = await api().post(`${A}/content/pages/${id}/blocks`).set(bearer(admin)).send({ type: "cta" }).expect(201);
    expect(added.body.data.blocks).toHaveLength(2);
    const cta = added.body.data.blocks[1];
    expect(cta.ctaHref).toBe("/shop");

    await api().patch(`${A}/content/pages/${id}/blocks/${cta.id}`).set(bearer(admin)).send({ ctaHref: "javascript:alert(1)" }).expect(400);
    const upd = await api().patch(`${A}/content/pages/${id}/blocks/${cta.id}`).set(bearer(admin)).send({ ctaLabel: "Explore <i>now</i>", body: "<p>Go</p><iframe src='x'></iframe>" }).expect(200);
    expect(upd.body.data.blocks[1].ctaLabel).toBe("Explore now");
    expect(upd.body.data.blocks[1].body).toBe("<p>Go</p>");
    await api().post(`${A}/content/pages/${id}/blocks`).set(bearer(admin)).send({ type: "video", videoUrl: "http://insecure.dev/v" }).expect(400);

    const moved = await api().post(`${A}/content/pages/${id}/blocks/${cta.id}/move`).set(bearer(admin)).send({ dir: -1 }).expect(200);
    expect(moved.body.data.blocks[0].id).toBe(cta.id);

    const removed = await api().delete(`${A}/content/pages/${id}/blocks/${cta.id}`).set(bearer(admin)).expect(200);
    expect(removed.body.data.blocks).toHaveLength(1);
  });

  it("duplicate, status, list tabs, slug conflicts", async () => {
    const dup = await api().post(`${A}/content/pages/${id}/duplicate`).set(bearer(admin)).expect(201);
    expect(dup.body.data.slug).toBe("story-time-copy");
    expect(dup.body.data.status).toBe("draft");
    await api().patch(`${A}/content/pages/${dup.body.data.id}`).set(bearer(admin)).send({ slug: "story-time" }).expect(409);
    await api().patch(`${A}/content/pages/${id}/status`).set(bearer(admin)).send({ status: "scheduled" }).expect(400);
    await api().patch(`${A}/content/pages/${id}/status`).set(bearer(admin)).send({ status: "published" }).expect(200);
    await api().get(`${S}/content/pages/story-time`).expect(200);
    const list = await api().get(`${A}/content/pages?status=draft`).set(bearer(admin)).expect(200);
    expect(list.body.meta.tabs.published).toBeGreaterThanOrEqual(12);
    expect(list.body.data.every((p: { status: string }) => p.status === "draft")).toBe(true);
    const tokens = await api().get(`${A}/content/pages/tokens`).set(bearer(admin)).expect(200);
    expect(tokens.body.data).toEqual(expect.arrayContaining([{ token: "{{returns.windowDays}}", value: "7" }]));
  });

  it("a scheduled page goes live when the publish job runs", async () => {
    const p = await api().post(`${A}/content/pages`).set(bearer(admin)).send({ title: "Black Friday", slug: "campaigns/black-friday" }).expect(201);
    const at = new Date(Date.now() + 60 * 60_000);
    await api().patch(`${A}/content/pages/${p.body.data.id}/status`).set(bearer(admin)).send({ status: "scheduled", scheduledFor: at.toISOString() }).expect(200);
    await api().get(`${S}/content/pages/campaigns/black-friday`).expect(404);
    expect(await publishScheduledContent(new Date())).toEqual({ pages: 0, posts: 0 });
    const r = await publishScheduledContent(new Date(at.getTime() + 1000));
    expect(r.pages).toBe(1);
    const live = await api().get(`${S}/content/pages/campaigns/black-friday`).expect(200);
    expect(new Date(live.body.data.publishedAt).getTime()).toBe(at.getTime());
  });
});

describe("FAQs", () => {
  it("lists by category with settings tokens rendered; feedback + views count", async () => {
    const cats = await api().get(`${S}/content/faqs/categories`).expect(200);
    expect(cats.body.data.map((c: { slug: string }) => c.slug)).toEqual(["orders", "payment", "shipping", "returns", "other"]);
    const r = await api().get(`${S}/content/faqs?category=payment`).expect(200);
    const pm = r.body.data.find((f: { question: string }) => f.question === "What payment methods do you accept?");
    expect(pm.answer).toContain("ASL Wallet");
    // gift cards are seeded as a draft (no gift-card feature) → hidden
    expect(r.body.data.some((f: { question: string }) => f.question.includes("gift cards"))).toBe(false);

    await api().post(`${S}/content/faqs/${pm.id}/feedback`).send({ helpful: true }).expect(200);
    await api().post(`${S}/content/faqs/${pm.id}/feedback`).send({ helpful: true }).expect(200);
    const fb = await api().post(`${S}/content/faqs/${pm.id}/feedback`).send({ helpful: false }).expect(200);
    expect(fb.body.data).toMatchObject({ helpful: 2, notHelpful: 1 });
    await api().post(`${S}/content/faqs/${pm.id}/view`).expect(200);
    const row = await prisma.faqItem.findUniqueOrThrow({ where: { id: pm.id } });
    expect(row.views30d).toBe(1);
    const featured = await api().get(`${S}/content/faqs?featured=true`).expect(200);
    expect(featured.body.data.length).toBeGreaterThanOrEqual(4);
  });

  it("admin: categories + items CRUD, move, feature, status, duplicate", async () => {
    const cat = await api().post(`${A}/content/faqs/categories`).set(bearer(editor)).send({ name: "Gift Cards" }).expect(201);
    expect(cat.body.data.slug).toBe("gift-cards");
    const a = await api().post(`${A}/content/faqs`).set(bearer(editor)).send({ categoryId: cat.body.data.id, question: "Q1", answer: "<p>A1</p><script>x()</script>", status: "published" }).expect(201);
    expect(a.body.data.answer).toBe("<p>A1</p>");
    const b = await api().post(`${A}/content/faqs`).set(bearer(editor)).send({ categoryId: cat.body.data.id, question: "Q2", answer: "A2" }).expect(201);
    await api().post(`${A}/content/faqs/${b.body.data.id}/move`).set(bearer(editor)).send({ dir: -1 }).expect(200);
    const list = await api().get(`${A}/content/faqs?categoryId=${cat.body.data.id}`).set(bearer(editor)).expect(200);
    expect(list.body.data.map((i: { question: string }) => i.question)).toEqual(["Q2", "Q1"]);
    const dup = await api().post(`${A}/content/faqs/${a.body.data.id}/duplicate`).set(bearer(editor)).expect(201);
    expect(dup.body.data.status).toBe("draft");
    const f = await api().post(`${A}/content/faqs/${a.body.data.id}/feature`).set(bearer(editor)).expect(200);
    expect(f.body.data.featured).toBe(true);
    await api().patch(`${A}/content/faqs/${b.body.data.id}/status`).set(bearer(editor)).send({ status: "published" }).expect(200);
    const store = await api().get(`${S}/content/faqs?category=gift-cards`).expect(200);
    expect(store.body.data.map((i: { question: string }) => i.question)).toEqual(["Q2", "Q1"]);
    await api().post(`${A}/content/faqs/categories/${cat.body.data.id}/move`).set(bearer(editor)).send({ dir: -1 }).expect(200);
    const del = await api().delete(`${A}/content/faqs/categories/${cat.body.data.id}`).set(bearer(editor)).expect(200);
    expect(del.body.data.deletedItems).toBe(3);
  });
});

describe("blog", () => {
  let postId: string;
  let categoryId: string;
  let authorId: string;

  it("admin creates a post; store lists, filters, shows and likes it", async () => {
    categoryId = (await api().get(`${A}/content/blog/categories`).set(bearer(admin)).expect(200)).body.data.find((c: { slug: string }) => c.slug === "guides").id;
    authorId = (await api().post(`${A}/content/blog/authors`).set(bearer(admin)).send({ name: "Chidi Nwosu", role: "Concierge lead" }).expect(201)).body.data.id;
    const p = await api().post(`${A}/content/blog`).set(bearer(admin)).send({
      title: "Inside the ASL vault", categoryId, authorId, excerpt: "How we authenticate.", status: "published", featured: true,
      content: "<h2>Step one</h2><p>We inspect.</p><script>evil()</script>", tags: ["authenticity"],
    }).expect(201);
    postId = p.body.data.id;
    expect(p.body.data.slug).toBe("inside-the-asl-vault");
    expect(p.body.data.content).not.toContain("script");
    await api().post(`${A}/content/blog`).set(bearer(admin)).send({ title: "Draft post", categoryId, authorId }).expect(201);

    const list = await api().get(`${S}/content/blog?category=guides`).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.meta.total).toBe(1);
    expect(list.body.data[0].author.name).toBe("Chidi Nwosu");
    expect((await api().get(`${S}/content/blog?featured=true&tag=authenticity`).expect(200)).body.data).toHaveLength(1);
    expect((await api().get(`${S}/content/blog?category=style`).expect(200)).body.data).toHaveLength(0);

    const d = await api().get(`${S}/content/blog/inside-the-asl-vault`).expect(200);
    expect(d.body.data.content).toContain("<h2>Step one</h2>");
    await api().get(`${S}/content/blog/draft-post`).expect(404);

    await api().post(`${S}/content/blog/${postId}/like`).expect(200);
    const l = await api().post(`${S}/content/blog/${postId}/like`).expect(200);
    expect(l.body.data.likes).toBe(2);
  });

  it("duplicate, feature, schedule → job publishes, category in use can't be deleted", async () => {
    const dup = await api().post(`${A}/content/blog/${postId}/duplicate`).set(bearer(admin)).expect(201);
    expect(dup.body.data).toMatchObject({ slug: "inside-the-asl-vault-copy", status: "draft", featured: false });
    const at = new Date(Date.now() + 5 * 60_000);
    await api().patch(`${A}/content/blog/${dup.body.data.id}/status`).set(bearer(admin)).send({ status: "scheduled", scheduledFor: at }).expect(200);
    expect((await publishScheduledContent(new Date(at.getTime() + 1))).posts).toBe(1);
    await api().get(`${S}/content/blog/inside-the-asl-vault-copy`).expect(200);
    const f = await api().post(`${A}/content/blog/${postId}/feature`).set(bearer(admin)).expect(200);
    expect(f.body.data.featured).toBe(false);
    await api().delete(`${A}/content/blog/categories/${categoryId}`).set(bearer(admin)).expect(409);
    await api().delete(`${A}/content/blog/authors/${authorId}`).set(bearer(admin)).expect(409);
    const list = await api().get(`${A}/content/blog?status=published`).set(bearer(admin)).expect(200);
    expect(list.body.meta.tabs).toMatchObject({ published: 2, draft: 1 });
  });
});

describe("SEO", () => {
  it("redirects: loops and self-redirects are refused, hits recorded", async () => {
    await api().post(`${A}/seo/redirects`).set(bearer(admin)).send({ from: "/a", to: "/a" }).expect(400);
    const ab = await api().post(`${A}/seo/redirects`).set(bearer(admin)).send({ from: "/a", to: "/b" }).expect(201);
    await api().post(`${A}/seo/redirects`).set(bearer(admin)).send({ from: "/b", to: "/c" }).expect(201);
    const loop = await api().post(`${A}/seo/redirects`).set(bearer(admin)).send({ from: "/c/", to: "https://example.com/x" }).expect(201);
    // /c → /a would close the loop a → b → c → a
    const bad = await api().patch(`${A}/seo/redirects/${loop.body.data.id}`).set(bearer(admin)).send({ to: "/a" }).expect(400);
    expect(bad.body.error.message).toContain("/c → /a → /b → /c");
    await api().post(`${A}/seo/redirects`).set(bearer(admin)).send({ from: "/gone", status: 410 }).expect(201);
    await api().post(`${A}/seo/redirects`).set(bearer(admin)).send({ from: "/x" }).expect(400);

    const pub = await api().get(`${S}/seo/redirects`).expect(200);
    expect(pub.body.data.redirects).toEqual(expect.arrayContaining([{ from: "/a", to: "/b", status: 301 }, { from: "/gone", to: null, status: 410 }]));
    await api().post(`${S}/seo/redirects/hits`).send({ hits: [{ from: "/a", count: 3 }, { from: "/a/" }] }).expect(200);
    const row = await prisma.redirect.findUniqueOrThrow({ where: { id: ab.body.data.id } });
    expect(row.hits).toBe(4);

    // disabling drops it from the web server's list; re-enabling is loop-checked again
    await api().post(`${A}/seo/redirects/${ab.body.data.id}/toggle`).set(bearer(admin)).expect(200);
    expect((await api().get(`${S}/seo/redirects`).expect(200)).body.data.redirects.some((r: { from: string }) => r.from === "/a")).toBe(false);
    await api().post(`${A}/seo/redirects`).set(bearer(admin)).send({ from: "/z", to: "/a", enabled: true }).expect(201);
    const on = await api().post(`${A}/seo/redirects/${ab.body.data.id}/toggle`).set(bearer(admin)).expect(200);
    expect(on.body.data.enabled).toBe(true);
  });

  it("audit reports chains, long descriptions, duplicate canonicals", async () => {
    await api().post(`${A}/seo/pages`).set(bearer(admin)).send({ path: "/promo-1", title: "", description: "x".repeat(200), canonical: "/promo" }).expect(201);
    await api().post(`${A}/seo/pages`).set(bearer(admin)).send({ path: "/promo-2", title: "Promo", description: "Short", canonical: "/promo" }).expect(201);
    await api().post(`${A}/seo/redirects`).set(bearer(admin)).send({ from: "/old-product", to: "/product/does-not-exist" }).expect(201);
    const r = await api().get(`${A}/seo/audit`).set(bearer(admin)).expect(200);
    const types = r.body.data.findings.map((f: { type: string }) => f.type);
    expect(types).toEqual(expect.arrayContaining(["missing_title", "long_description", "duplicate_canonical", "redirect_chain", "broken_redirect"]));
    expect(r.body.data.summary.errors).toBeGreaterThan(0);
  });

  it("robots.txt and sitemap.xml are public and built from the catalogue + CMS", async () => {
    const robots = await api().get("/robots.txt").expect(200);
    expect(robots.headers["content-type"]).toContain("text/plain");
    expect(robots.text).toContain("Disallow: /checkout");
    expect(robots.text).toMatch(/Sitemap: .*\/sitemap\.xml/);

    const product = await prisma.product.findFirstOrThrow({ where: { status: "active", deletedAt: null } });
    const brand = await prisma.brand.findFirstOrThrow({ where: { status: "active" } });
    const xml = await api().get("/sitemap.xml").expect(200);
    expect(xml.headers["content-type"]).toContain("xml");
    expect(xml.text).toContain(`/product/${product.handle}</loc>`);
    expect(xml.text).toContain(`/brands/${brand.handle}</loc>`);
    expect(xml.text).toContain("/customer-care/return-policy</loc>");
    expect(xml.text).toContain("/blog/inside-the-asl-vault</loc>");
    expect(xml.text).not.toContain("/club/benefits</loc>"); // members-only

    // exclude a product through a sitemap toggle
    const e = await api().post(`${A}/seo/sitemap`).set(bearer(admin)).send({ loc: `/product/${product.handle}`, included: false }).expect(201);
    expect((await api().get("/sitemap.xml")).text).not.toContain(`/product/${product.handle}</loc>`);
    await api().post(`${A}/seo/sitemap/${e.body.data.id}/toggle`).set(bearer(admin)).expect(200);
    expect((await api().get("/sitemap.xml")).text).toContain(`/product/${product.handle}</loc>`);

    await api().patch(`${A}/seo/config`).set(bearer(admin)).send({ robotsTxt: "User-agent: *\nDisallow: /", siteUrl: "https://asloriginals.online" }).expect(200);
    expect((await api().get("/robots.txt")).text).toContain("Sitemap: https://asloriginals.online/sitemap.xml");
    await api().patch(`${A}/seo/config`).set(bearer(admin)).send({ defaultTitleTemplate: "no placeholder" }).expect(400);
  });

  it("meta for products, CMS pages and overrides", async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { status: "active", deletedAt: null }, include: { brand: true } });
    const m = await api().get(`${S}/seo/meta?path=/product/${product.handle}`).expect(200);
    expect(m.body.data.title).toContain(product.name);
    expect(m.body.data.title).toContain("· ASL ORIGINALS");
    expect(m.body.data.canonical).toBe(`https://asloriginals.online/product/${product.handle}`);
    expect(m.body.data.schemaType).toBe("Product");
    const p = await api().get(`${S}/seo/meta?path=/customer-care/return-policy`).expect(200);
    expect(p.body.data.description).toContain("within 7 days");
    const home = await api().get(`${S}/seo/meta?path=/`).expect(200);
    expect(home.body.data.title).toBe("ASL ORIGINALS - Luxury footwear, fashion & fragrance");
    const red = await api().get(`${S}/seo/meta?path=/b`).expect(200);
    expect(red.body.data.redirect).toEqual({ to: "/c", status: 301 });
  });
});

describe("media library", () => {
  it("uploads several files, edits, stars, moves; delete is blocked while a page uses the file", async () => {
    const up = await api().post(`${A}/media`).set(bearer(editor)).field("folder", "hero").field("tags", "summer, banner")
      .attach("files", png, { filename: "hero.png", contentType: "image/png" })
      .attach("files", png, { filename: "hero-2.png", contentType: "image/png" })
      .expect(201);
    expect(up.body.data).toHaveLength(2);
    const [a, b] = up.body.data;
    expect(a).toMatchObject({ folder: "hero", type: "image", tags: ["summer", "banner"], uploadedBy: "Admin content_editor" });

    const patched = await api().patch(`${A}/media/${a.id}`).set(bearer(editor)).send({ altText: "Summer hero", name: "summer-hero.webp" }).expect(200);
    expect(patched.body.data.altText).toBe("Summer hero");
    expect((await api().post(`${A}/media/${a.id}/star`).set(bearer(editor)).expect(200)).body.data.starred).toBe(true);
    await api().post(`${A}/media/move`).set(bearer(editor)).send({ ids: [b.id], folder: "campaigns" }).expect(200);
    const list = await api().get(`${A}/media?folder=hero`).set(bearer(editor)).expect(200);
    expect(list.body.data.map((x: { id: string }) => x.id)).toEqual([a.id]);
    expect(list.body.meta.folders).toMatchObject({ hero: 1, campaigns: 1 });
    expect((await api().get(`${A}/media?starred=true&q=summer`).set(bearer(editor)).expect(200)).body.data).toHaveLength(1);

    // a page uses the image → "used in" + delete blocked
    const page = await api().post(`${A}/content/pages`).set(bearer(editor))
      .send({ title: "Summer", heroImage: a.url, blocks: [{ type: "image", imageUrl: a.url, alt: "x" }] }).expect(201);
    const got = await api().get(`${A}/media/${a.id}`).set(bearer(editor)).expect(200);
    expect(got.body.data.usedIn).toEqual([{ entityType: "page", entityId: page.body.data.id }]);
    await api().delete(`${A}/media/${a.id}`).set(bearer(editor)).expect(409);
    await api().post(`${A}/media/bulk-delete`).set(bearer(editor)).send({ ids: [a.id, b.id] }).expect(409);
    expect(await prisma.mediaAsset.count({ where: { id: { in: [a.id, b.id] } } })).toBe(2);

    // removing the image from the page frees the file
    await api().patch(`${A}/content/pages/${page.body.data.id}`).set(bearer(editor)).send({ heroImage: null, blocks: [{ type: "hero", title: "Summer" }] }).expect(200);
    expect((await api().get(`${A}/media/${a.id}`).set(bearer(editor))).body.data.usedIn).toEqual([]);
    const del = await api().post(`${A}/media/bulk-delete`).set(bearer(editor)).send({ ids: [a.id, b.id] }).expect(200);
    expect(del.body.data.deleted).toBe(2);
  });

  it("force delete removes a used file", async () => {
    const up = await api().post(`${A}/media`).set(bearer(admin)).attach("files", png, { filename: "cover.png", contentType: "image/png" }).expect(201);
    const asset = up.body.data[0];
    const cat = (await api().get(`${A}/content/blog/categories`).set(bearer(admin))).body.data[0].id;
    const author = (await api().get(`${A}/content/blog/authors`).set(bearer(admin))).body.data[0].id;
    await api().post(`${A}/content/blog`).set(bearer(admin)).send({ title: "With cover", categoryId: cat, authorId: author, coverUrl: asset.url }).expect(201);
    await api().delete(`${A}/media/${asset.id}`).set(bearer(admin)).expect(409);
    await api().delete(`${A}/media/${asset.id}?force=true`).set(bearer(admin)).expect(200);
    await api().get(`${A}/media/${asset.id}`).set(bearer(admin)).expect(404);
  });
});

describe("permissions", () => {
  it("support staff can't open content, SEO or media admin", async () => {
    for (const p of ["/content/pages", "/content/faqs", "/content/blog", "/seo/config", "/seo/audit", "/media"]) {
      const r = await api().get(`${A}${p}`).set(bearer(support));
      expect(r.status, p).toBe(403);
    }
    await api().post(`${A}/content/pages`).set(bearer(support)).send({ title: "x" }).expect(403);
    await api().get(`${A}/content/pages`).expect(401);
  });
});
