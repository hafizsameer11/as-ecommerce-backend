import { ModuleRouter, idParam } from "@/core/http/router";
import { abandonedCartsController as c } from "./abandoned-carts.controller";
import { abandonedListQuery, recoveryRulesBody, remindBody, remindBulkBody } from "./abandoned-carts.schemas";

const audit = (action: string) => ({ category: "marketing", action, entity: "cart" });

/** asl-admin /carts (abandoned-cart recovery) */
export const abandonedCartsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/carts", tag: "Abandoned carts", defaultAuth: "admin", defaultPermission: "marketing.manage" })
  .get("/abandoned", { summary: "Abandoned carts (stage tabs Just abandoned → Reminder 1/2 sent → Recovered → Lost, KPIs)", query: abandonedListQuery }, c.list)
  .post("/remind-bulk", { summary: "Email the next reminder to many abandoned carts (all with an email when `ids` is omitted)", body: remindBulkBody, audit: audit("cart.reminder_bulk") }, c.remindBulk)
  .get("/recovery-rules", { summary: "Reminder cadence (+ abandon minutes and lost-after days)" }, c.rules)
  .put("/recovery-rules", { summary: "Save the reminder cadence", body: recoveryRulesBody, audit: { ...audit("cart.recovery_rules_saved"), entity: "recovery_rule" } }, c.saveRules)
  .post("/:id/remind", { summary: "Send the next reminder now (email or push)", params: idParam, body: remindBody, audit: audit("cart.reminder_sent") }, c.remind);
