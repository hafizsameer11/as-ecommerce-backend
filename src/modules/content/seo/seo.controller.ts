import type { Ctx } from "@/core/http/router";
import { seoService as svc } from "./seo.service";
import type {
  RedirectCreate, RedirectListQuery, RedirectPatch, SeoConfig, SeoPageCreate, SeoPageListQuery, SeoPagePatch, SitemapCreate, SitemapPatch,
} from "./seo.schemas";

type Id = { id: string };

export const seoController = {
  /* public */
  robots: async ({ res }: Ctx) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.type("text/plain").send(await svc.robots());
  },
  sitemap: async ({ res }: Ctx) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.type("application/xml").send(await svc.sitemapXml());
  },

  /* store */
  meta: ({ query }: Ctx<unknown, { path: string }>) => svc.meta(query.path),
  redirects: async ({ res }: Ctx) => {
    res.setHeader("Cache-Control", "public, max-age=60");
    return svc.activeRedirects();
  },
  hits: ({ body }: Ctx<{ hits: { from: string; count: number }[] }>) => svc.recordHits(body.hits),

  /* admin */
  config: () => svc.config(),
  updateConfig: async ({ body, admin, res }: Ctx<Partial<SeoConfig>>) => {
    const r = await svc.updateConfig(body, admin.email);
    res.locals.audit = { before: r.before, after: r.after, summary: "Updated SEO settings" };
    return r.after;
  },
  pages: ({ query }: Ctx<unknown, SeoPageListQuery>) => svc.pages(query),
  createPage: ({ body }: Ctx<SeoPageCreate>) => svc.createPage(body),
  updatePage: async ({ params, body, res }: Ctx<SeoPagePatch, unknown, Id>) => {
    const r = await svc.updatePage(params.id, body);
    res.locals.audit = { before: r.before, after: r.after, summary: `Updated SEO for ${r.after.path}` };
    return r.after;
  },
  removePage: ({ params }: Ctx<unknown, unknown, Id>) => svc.removePage(params.id),
  redirectList: ({ query }: Ctx<unknown, RedirectListQuery>) => svc.redirects(query),
  addRedirect: async ({ body, res }: Ctx<RedirectCreate>) => {
    const r = await svc.addRedirect(body);
    res.locals.audit = { entityId: r.id, summary: `Redirect ${r.from} → ${r.status === 410 ? "410 Gone" : r.to} (${r.status})` };
    return r;
  },
  updateRedirect: async ({ params, body, res }: Ctx<RedirectPatch, unknown, Id>) => {
    const r = await svc.updateRedirect(params.id, body);
    res.locals.audit = { before: r.before, after: r.after, summary: `Updated redirect ${r.after.from}` };
    return r.after;
  },
  toggleRedirect: ({ params }: Ctx<unknown, unknown, Id>) => svc.toggleRedirect(params.id),
  removeRedirect: ({ params }: Ctx<unknown, unknown, Id>) => svc.removeRedirect(params.id),
  sitemapEntries: () => svc.sitemapEntries(),
  addSitemapEntry: ({ body }: Ctx<SitemapCreate>) => svc.addSitemapEntry(body),
  updateSitemapEntry: ({ params, body }: Ctx<SitemapPatch, unknown, Id>) => svc.updateSitemapEntry(params.id, body),
  toggleSitemapEntry: ({ params }: Ctx<unknown, unknown, Id>) => svc.toggleSitemapEntry(params.id),
  removeSitemapEntry: ({ params }: Ctx<unknown, unknown, Id>) => svc.removeSitemapEntry(params.id),
  audit: () => svc.audit(),
};
