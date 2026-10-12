import type { Ctx } from "@/core/http/router";
import { faqsService as svc } from "./faqs.service";
import type { CategoryCreate, CategoryPatch, ItemCreate, ItemListQuery, ItemPatch, StoreFaqQuery } from "./faqs.schemas";

type Id = { id: string };

export const faqsController = {
  /* store */
  storeList: ({ query }: Ctx<unknown, StoreFaqQuery>) => svc.storeList(query),
  storeCategories: () => svc.storeCategories(),
  feedback: ({ params, body }: Ctx<{ helpful: boolean }, unknown, Id>) => svc.feedback(params.id, body.helpful),
  view: ({ params }: Ctx<unknown, unknown, Id>) => svc.view(params.id),

  /* admin: categories */
  categories: () => svc.categories(),
  createCategory: async ({ body, res }: Ctx<CategoryCreate>) => {
    const c = await svc.createCategory(body);
    res.locals.audit = { entityId: c.id, summary: `Created FAQ category ${c.name}` };
    return c;
  },
  updateCategory: async ({ params, body, res }: Ctx<CategoryPatch, unknown, Id>) => {
    const r = await svc.updateCategory(params.id, body);
    res.locals.audit = { before: r.before, after: r.after, summary: `Updated FAQ category ${r.after.name}` };
    return r.after;
  },
  removeCategory: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const r = await svc.removeCategory(params.id);
    res.locals.audit = { summary: `Deleted FAQ category ${r.name} (${r.deletedItems} questions)` };
    return r;
  },
  moveCategory: ({ params, body }: Ctx<{ dir: -1 | 1 }, unknown, Id>) => svc.moveCategory(params.id, body.dir),

  /* admin: items */
  items: ({ query }: Ctx<unknown, ItemListQuery>) => svc.items(query),
  getItem: ({ params }: Ctx<unknown, unknown, Id>) => svc.getItem(params.id),
  createItem: async ({ body, admin, res }: Ctx<ItemCreate>) => {
    const i = await svc.createItem(body, admin.name);
    res.locals.audit = { entityId: i.id, summary: `Added FAQ "${i.question.slice(0, 120)}"` };
    return i;
  },
  updateItem: async ({ params, body, res }: Ctx<ItemPatch, unknown, Id>) => {
    const r = await svc.updateItem(params.id, body);
    res.locals.audit = { before: r.before, after: r.after, summary: `Updated FAQ "${r.after.question.slice(0, 120)}"` };
    return r.after;
  },
  removeItem: ({ params }: Ctx<unknown, unknown, Id>) => svc.removeItem(params.id),
  duplicateItem: ({ params, admin }: Ctx<unknown, unknown, Id>) => svc.duplicateItem(params.id, admin.name),
  setItemStatus: ({ params, body }: Ctx<{ status: "published" | "draft" | "archived" }, unknown, Id>) => svc.setItemStatus(params.id, body.status),
  toggleFeatured: ({ params }: Ctx<unknown, unknown, Id>) => svc.toggleFeatured(params.id),
  moveItem: ({ params, body }: Ctx<{ dir: -1 | 1 }, unknown, Id>) => svc.moveItem(params.id, body.dir),
};
