import type { Ctx } from "@/core/http/router";
import { blogService as svc } from "./blog.service";
import type {
  AuthorCreate, AuthorPatch, CategoryCreate, CategoryPatch, PostCreate, PostListQuery, PostPatch, PostStatusBody, StoreBlogQuery,
} from "./blog.schemas";

type Id = { id: string };

export const blogController = {
  /* store */
  storeList: ({ query }: Ctx<unknown, StoreBlogQuery>) => svc.storeList(query),
  storeCategories: () => svc.storeCategories(),
  storeBySlug: ({ params }: Ctx<unknown, unknown, { slug: string }>) => svc.storeBySlug(params.slug),
  like: ({ params }: Ctx<unknown, unknown, Id>) => svc.like(params.id),

  /* admin: posts */
  list: ({ query }: Ctx<unknown, PostListQuery>) => svc.list(query),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.get(params.id),
  create: async ({ body, res }: Ctx<PostCreate>) => {
    const p = await svc.create(body);
    res.locals.audit = { entityId: p.id, summary: `Created post "${p.title}"` };
    return p;
  },
  update: async ({ params, body, res }: Ctx<PostPatch, unknown, Id>) => {
    const r = await svc.update(params.id, body);
    res.locals.audit = { before: { ...r.before, content: undefined }, after: { ...r.after, content: undefined }, summary: `Updated post "${r.after.title}"` };
    return r.after;
  },
  remove: ({ params }: Ctx<unknown, unknown, Id>) => svc.remove(params.id),
  duplicate: ({ params }: Ctx<unknown, unknown, Id>) => svc.duplicate(params.id),
  setStatus: async ({ params, body, res }: Ctx<PostStatusBody, unknown, Id>) => {
    const r = await svc.setStatus(params.id, body);
    res.locals.audit = { before: { status: r.before.status }, after: { status: r.after.status, scheduledFor: r.after.scheduledFor }, summary: `Post "${r.after.title}" → ${r.after.status}` };
    return r.after;
  },
  toggleFeatured: ({ params }: Ctx<unknown, unknown, Id>) => svc.toggleFeatured(params.id),

  /* admin: categories + authors */
  categories: () => svc.categories(),
  createCategory: ({ body }: Ctx<CategoryCreate>) => svc.createCategory(body),
  updateCategory: ({ params, body }: Ctx<CategoryPatch, unknown, Id>) => svc.updateCategory(params.id, body),
  removeCategory: ({ params }: Ctx<unknown, unknown, Id>) => svc.removeCategory(params.id),
  authors: () => svc.authors(),
  createAuthor: ({ body }: Ctx<AuthorCreate>) => svc.createAuthor(body),
  updateAuthor: ({ params, body }: Ctx<AuthorPatch, unknown, Id>) => svc.updateAuthor(params.id, body),
  removeAuthor: ({ params }: Ctx<unknown, unknown, Id>) => svc.removeAuthor(params.id),
};
