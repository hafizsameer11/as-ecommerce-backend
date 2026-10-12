import { ModuleRouter, idParam } from "@/core/http/router";
import { publicLimiter } from "@/core/middleware/rate-limit";
import { blogController as c } from "./blog.controller";
import {
  authorCreate, authorPatch, categoryCreate, categoryPatch, postCreate, postListQuery, postPatch, postStatusBody, slugParam, storeBlogQuery,
} from "./blog.schemas";

/** journal (asl-web has no blog screen yet — issue U7) */
export const blogStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/content/blog", tag: "Content" })
  .get("/", { summary: "Published posts (category, featured, tag, q, pagination)", query: storeBlogQuery }, c.storeList)
  .get("/categories", { summary: "Blog categories with published posts" }, c.storeCategories)
  .get("/:slug", { summary: "Post by slug (+ 3 related)", params: slugParam }, c.storeBySlug)
  .post("/:id/like", { summary: "Like a post", params: idParam, middleware: [publicLimiter] }, c.like);

const audit = (action: string, entity = "blog_post") => ({ category: "content", action, entity });

/** asl-admin /content/blog */
export const blogAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/content/blog", tag: "Content blog", defaultAuth: "admin", defaultPermission: "content.publish" })
  .get("/categories", { summary: "Categories" }, c.categories)
  .post("/categories", { summary: "Add category", body: categoryCreate, status: 201, audit: audit("blog_category.created", "blog_category") }, c.createCategory)
  .patch("/categories/:id", { summary: "Update category", params: idParam, body: categoryPatch, audit: audit("blog_category.updated", "blog_category") }, c.updateCategory)
  .delete("/categories/:id", { summary: "Delete category (refused while posts use it)", params: idParam, audit: audit("blog_category.deleted", "blog_category") }, c.removeCategory)
  .get("/authors", { summary: "Authors" }, c.authors)
  .post("/authors", { summary: "Add author", body: authorCreate, status: 201, audit: audit("blog_author.created", "blog_author") }, c.createAuthor)
  .patch("/authors/:id", { summary: "Update author", params: idParam, body: authorPatch, audit: audit("blog_author.updated", "blog_author") }, c.updateAuthor)
  .delete("/authors/:id", { summary: "Delete author (refused while they have posts)", params: idParam, audit: audit("blog_author.deleted", "blog_author") }, c.removeAuthor)
  .get("/", { summary: "Posts (tabs by status, KPIs)", query: postListQuery }, c.list)
  .get("/:id", { summary: "Post", params: idParam }, c.get)
  .post("/", { summary: "Create post", body: postCreate, status: 201, audit: audit("blog_post.created") }, c.create)
  .patch("/:id", { summary: "Update post", params: idParam, body: postPatch, audit: audit("blog_post.updated") }, c.update)
  .delete("/:id", { summary: "Delete post", params: idParam, audit: audit("blog_post.deleted") }, c.remove)
  .post("/:id/duplicate", { summary: "Duplicate as draft", params: idParam, status: 201, audit: audit("blog_post.duplicated") }, c.duplicate)
  .patch("/:id/status", { summary: "draft · scheduled (needs scheduledFor) · published · archived", params: idParam, body: postStatusBody, audit: audit("blog_post.status_changed") }, c.setStatus)
  .post("/:id/feature", { summary: "Feature / unfeature", params: idParam, audit: audit("blog_post.featured") }, c.toggleFeatured);
