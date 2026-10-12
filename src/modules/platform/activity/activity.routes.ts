import { ModuleRouter } from "@/core/http/router";
import { activityController as c } from "./activity.controller";
import { activityFilters } from "./activity.schemas";

/** asl-admin /activity live feed + dashboard ticker (any admin; rows filtered by the caller's permissions) */
export const activityAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/activity", tag: "Activity", defaultAuth: "admin" })
  .get("/", {
    summary: "Activity feed",
    description:
      "Newest first. Filters: type (key, comma list or prefix `order.*`), from/to, since (ticker polling), q. " +
      "Each type is only returned to staff with its view permission (orders.view, concierge.view, catalog.view, finance.view…). " +
      "meta.types = the types the caller can see; meta.tabs = counts per type.",
    query: activityFilters,
  }, c.list);
