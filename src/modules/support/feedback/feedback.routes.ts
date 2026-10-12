import { ModuleRouter, idParam } from "@/core/http/router";
import { feedbackController as c } from "./feedback.controller";
import { adminFeedbackQuery, feedbackBody, feedbackStatusBody } from "./feedback.schemas";

/** /account/feedback */
export const feedbackStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/feedback", tag: "Support", defaultAuth: "customer" })
  .post("/", { summary: "Send feedback (idea / bug / praise, area, message, optional reply e-mail)", body: feedbackBody, status: 201 }, c.create);

/** asl-admin feedback inbox (no screen yet — issue U7) */
export const feedbackAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/feedback", tag: "Support", defaultAuth: "admin", defaultPermission: "support.tickets" })
  .get("/", { summary: "Feedback (tabs by status new / triaged / done; counts by type)", query: adminFeedbackQuery }, c.adminList)
  .patch("/:id/status", { summary: "Triage", params: idParam, body: feedbackStatusBody, audit: { category: "support", action: "feedback.status_changed", entity: "feedback" } }, c.setStatus);
