import { ModuleRouter } from "@/core/http/router";
import { publicLimiter } from "@/core/middleware/rate-limit";
import { impressionsController as c } from "./impressions.controller";
import { impressionsBody } from "./impressions.schemas";

/** Banner / announcement / slot counters (anonymous allowed; 300 batches per minute per IP). */
export const impressionsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/impressions", tag: "Merchandising" })
  .post("/", {
    summary: "Record up to 50 events: [{ kind: banner|announcement|slot, id, event: impression|click|dismiss }]",
    body: impressionsBody, middleware: [publicLimiter],
  }, c.record);
