import { ModuleRouter, idParam } from "@/core/http/router";
import { dropsController as c } from "./drops.controller";
import { notifyMeBody, notifyMeQuery } from "./drops.schemas";

/** /coming-soon and /drop/:id (reserving needs payments → commerce phase) */
export const dropsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/drops", tag: "Drops" })
  .get("/", { summary: "Upcoming & live drops" }, c.list)
  .get("/:id", { summary: "One drop", params: idParam }, c.get);

/** "Notify me" when a sold-out product / size is back */
export const stockAlertsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/products/:id/notify-me", tag: "Products", defaultAuth: "customer" })
  .post("/", { summary: "Notify me when back in stock", params: idParam, body: notifyMeBody }, c.notifyMe)
  .delete("/", { summary: "Stop notifying", params: idParam, query: notifyMeQuery }, c.stopNotifying);
