import { ModuleRouter, idParam } from "@/core/http/router";
import { publicLimiter } from "@/core/middleware/rate-limit";
import { seoController as c } from "./seo.controller";
import {
  hitsBody, metaQuery, redirectCreate, redirectListQuery, redirectPatch, seoConfigPatch, seoPageCreate, seoPageListQuery, seoPagePatch, sitemapCreate, sitemapPatch,
} from "./seo.schemas";

/** crawlers: the web server proxies /robots.txt and /sitemap.xml here */
export const seoPublicRoutes = new ModuleRouter({ surface: "public", prefix: "", tag: "SEO" })
  .get("/robots.txt", { summary: "robots.txt (admin → SEO → robots; Sitemap line added automatically)" }, c.robots)
  .get("/sitemap.xml", { summary: "sitemap.xml — products, categories, brands, collections, pages, blog + manual entries / exclusions" }, c.sitemap);

/** web SSR head tags + redirect middleware */
export const seoStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/seo", tag: "SEO" })
  .get("/meta", { summary: "Head tags for a storefront path (title, description, canonical, robots, OG, Twitter)", query: metaQuery }, c.meta)
  .get("/redirects", { summary: "Enabled redirects for the web server (cache 60 s; to = null for 410 Gone)" }, c.redirects)
  .post("/redirects/hits", { summary: "Report redirect hits (batched by the web server)", body: hitsBody, middleware: [publicLimiter] }, c.hits);

const audit = (action: string, entity = "seo") => ({ category: "content", action, entity });

/** asl-admin /seo */
export const seoAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/seo", tag: "SEO", defaultAuth: "admin", defaultPermission: "content.publish" })
  .get("/config", { summary: "Global SEO settings" }, c.config)
  .patch("/config", { summary: "Update global SEO settings (title template, robots.txt, OG default, GA, GSC …)", body: seoConfigPatch, audit: audit("seo.config_updated") }, c.updateConfig)
  .get("/audit", { summary: "Findings: missing titles, long descriptions, broken redirects / chains / loops, duplicate canonicals" }, c.audit)
  .get("/pages", { summary: "Per-path SEO (with Search Console KPIs)", query: seoPageListQuery }, c.pages)
  .post("/pages", { summary: "Add SEO settings for a path", body: seoPageCreate, status: 201, audit: audit("seo.page_created", "seo_page") }, c.createPage)
  .patch("/pages/:id", { summary: "Update SEO for a path", params: idParam, body: seoPagePatch, audit: audit("seo.page_updated", "seo_page") }, c.updatePage)
  .delete("/pages/:id", { summary: "Remove SEO overrides for a path", params: idParam, audit: audit("seo.page_deleted", "seo_page") }, c.removePage)
  .get("/redirects", { summary: "Redirects (hits, last hit)", query: redirectListQuery }, c.redirectList)
  .post("/redirects", { summary: "Add redirect (loops refused)", body: redirectCreate, status: 201, audit: audit("redirect.created", "redirect") }, c.addRedirect)
  .patch("/redirects/:id", { summary: "Update redirect (loops refused)", params: idParam, body: redirectPatch, audit: audit("redirect.updated", "redirect") }, c.updateRedirect)
  .post("/redirects/:id/toggle", { summary: "Enable / disable redirect", params: idParam, audit: audit("redirect.toggled", "redirect") }, c.toggleRedirect)
  .delete("/redirects/:id", { summary: "Delete redirect", params: idParam, audit: audit("redirect.deleted", "redirect") }, c.removeRedirect)
  .get("/sitemap", { summary: "Manual sitemap entries / exclusions (+ how many URLs are generated)" }, c.sitemapEntries)
  .post("/sitemap", { summary: "Add sitemap entry (included: false = exclude that URL)", body: sitemapCreate, status: 201, audit: audit("sitemap.entry_added", "sitemap_entry") }, c.addSitemapEntry)
  .patch("/sitemap/:id", { summary: "Update sitemap entry", params: idParam, body: sitemapPatch, audit: audit("sitemap.entry_updated", "sitemap_entry") }, c.updateSitemapEntry)
  .post("/sitemap/:id/toggle", { summary: "Include / exclude", params: idParam, audit: audit("sitemap.entry_toggled", "sitemap_entry") }, c.toggleSitemapEntry)
  .delete("/sitemap/:id", { summary: "Delete sitemap entry", params: idParam, audit: audit("sitemap.entry_deleted", "sitemap_entry") }, c.removeSitemapEntry);
