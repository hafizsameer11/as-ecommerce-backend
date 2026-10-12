import { ModuleRouter, idParam } from "@/core/http/router";
import { publicLimiter } from "@/core/middleware/rate-limit";
import { faqsController as c } from "./faqs.controller";
import { categoryCreate, categoryPatch, feedbackBody, itemCreate, itemListQuery, itemPatch, itemStatusBody, moveBody, storeFaqQuery } from "./faqs.schemas";

/** /faq, /customer-care/faqs, account → help topics (?category=orders|payment|shipping|returns|other) */
export const faqsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/content/faqs", tag: "Content" })
  .get("/", { summary: "Published FAQs (?category=<slug>, featured, q). Answers render settings values ({{returns.windowDays}} …)", query: storeFaqQuery }, c.storeList)
  .get("/categories", { summary: "FAQ categories that have published questions" }, c.storeCategories)
  .post("/:id/feedback", { summary: "\"Was this helpful?\" — counts helpful / not helpful", params: idParam, body: feedbackBody, middleware: [publicLimiter] }, c.feedback)
  .post("/:id/view", { summary: "Count a view (question opened)", params: idParam, middleware: [publicLimiter] }, c.view);

const audit = (action: string, entity = "faq") => ({ category: "content", action, entity });

/** asl-admin /content/faqs */
export const faqsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/content/faqs", tag: "Content FAQs", defaultAuth: "admin", defaultPermission: "content.publish" })
  .get("/categories", { summary: "FAQ categories (with question counts)" }, c.categories)
  .post("/categories", { summary: "Add category", body: categoryCreate, status: 201, audit: audit("faq_category.created", "faq_category") }, c.createCategory)
  .patch("/categories/:id", { summary: "Update category", params: idParam, body: categoryPatch, audit: audit("faq_category.updated", "faq_category") }, c.updateCategory)
  .delete("/categories/:id", { summary: "Delete category and its questions", params: idParam, audit: audit("faq_category.deleted", "faq_category") }, c.removeCategory)
  .post("/categories/:id/move", { summary: "Move category up / down", params: idParam, body: moveBody, audit: audit("faq_category.moved", "faq_category") }, c.moveCategory)
  .get("/", { summary: "Questions (categoryId, status, featured, q) + helpfulness KPIs", query: itemListQuery }, c.items)
  .get("/:id", { summary: "Question", params: idParam }, c.getItem)
  .post("/", { summary: "Add question", body: itemCreate, status: 201, audit: audit("faq.created") }, c.createItem)
  .patch("/:id", { summary: "Update question", params: idParam, body: itemPatch, audit: audit("faq.updated") }, c.updateItem)
  .delete("/:id", { summary: "Delete question", params: idParam, audit: audit("faq.deleted") }, c.removeItem)
  .post("/:id/duplicate", { summary: "Duplicate (as draft, right below)", params: idParam, status: 201, audit: audit("faq.duplicated") }, c.duplicateItem)
  .patch("/:id/status", { summary: "Publish / unpublish / archive", params: idParam, body: itemStatusBody, audit: audit("faq.status_changed") }, c.setItemStatus)
  .post("/:id/feature", { summary: "Feature / unfeature", params: idParam, audit: audit("faq.featured") }, c.toggleFeatured)
  .post("/:id/move", { summary: "Move up / down inside its category", params: idParam, body: moveBody, audit: audit("faq.moved") }, c.moveItem);
