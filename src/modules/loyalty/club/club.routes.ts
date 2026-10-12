import { ModuleRouter, idParam } from "@/core/http/router";
import { clubController as c } from "./club.controller";
import {
  adjustBody, adminRedemptionsQuery, cancelBody, customerParam, fulfilBody, historyQuery, ledgerQuery, redemptionsQuery,
  reorderBody, rewardBody, rewardListQuery, rewardParam, rewardPatch, rulesBody, tierParam, tierPatch,
} from "./club.schemas";

/** /account/rewards, /account/rewards/redeem, /account/benefits, account header card */
export const clubStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/me/club", tag: "ASL Club", defaultAuth: "customer" })
  .get("/", { summary: "Points, value, tier + next tier (spend needed), perks, expiring soon, store credit" }, c.summary)
  .get("/history", { summary: "Points activity", query: historyQuery }, c.history)
  .get("/rewards", { summary: "Rewards catalogue (canRedeem / lockedReason per reward)" }, c.rewards)
  .post("/rewards/:id/redeem", {
    summary: "Redeem a reward → coupon code, wallet credit or a request our team fulfils",
    params: rewardParam, idempotent: "club.redeem", status: 201,
  }, c.redeem)
  .get("/redemptions", { summary: "My redemptions", query: redemptionsQuery }, c.myRedemptions);

const audit = (action: string, entity = "club") => ({ category: "marketing", action, entity });

/** asl-admin /club — reads need customers.view, changes need marketing.manage */
export const clubAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/club", tag: "ASL Club", defaultAuth: "admin", defaultPermission: "marketing.manage" })
  .get("/", { summary: "KPIs, tiers (members, spend), rules", permission: "customers.view" }, c.overview)
  .get("/tiers", { summary: "Tiers", permission: "customers.view" }, c.tiers)
  .patch("/tiers/:id", { summary: "Edit tier (min 12-month spend, multiplier, perks, active)", params: tierParam, body: tierPatch, audit: audit("club.tier_updated", "club_tier") }, c.updateTier)
  .get("/rules", { summary: "Points rules", permission: "customers.view" }, c.rules)
  .put("/rules", { summary: "Update points rules", body: rulesBody, audit: audit("club.rules_updated", "settings") }, c.updateRules)
  .get("/rewards", { summary: "Reward catalogue (category tabs)", permission: "customers.view", query: rewardListQuery }, c.adminRewards)
  .post("/rewards", { summary: "Create reward", body: rewardBody, status: 201, audit: audit("club.reward_created", "club_reward") }, c.createReward)
  .post("/rewards/reorder", { summary: "Reorder rewards (ids in display order)", body: reorderBody, audit: audit("club.rewards_reordered", "club_reward") }, c.reorderRewards)
  .get("/rewards/:id", { summary: "Reward", permission: "customers.view", params: idParam }, c.getReward)
  .patch("/rewards/:id", { summary: "Update reward", params: idParam, body: rewardPatch, audit: audit("club.reward_updated", "club_reward") }, c.updateReward)
  .post("/rewards/:id/duplicate", { summary: "Duplicate reward (switched off)", params: idParam, status: 201, audit: audit("club.reward_duplicated", "club_reward") }, c.duplicateReward)
  .post("/rewards/:id/toggle", { summary: "Switch reward on / off", params: idParam, audit: audit("club.reward_toggled", "club_reward") }, c.toggleReward)
  .delete("/rewards/:id", { summary: "Delete reward (only if never redeemed)", params: idParam, audit: audit("club.reward_deleted", "club_reward") }, c.removeReward)
  .post("/points/adjust", { summary: "Add or remove points for a customer", body: adjustBody, audit: audit("club.points_adjusted", "customer") }, c.adjust)
  .get("/ledger", { summary: "Points activity (all customers or one)", permission: "customers.view", query: ledgerQuery }, c.ledger)
  .get("/customers/:customerId", { summary: "A customer's club summary", permission: "customers.view", params: customerParam }, c.customerSummary)
  .get("/redemptions", { summary: "Redemptions (status tabs)", permission: "customers.view", query: adminRedemptionsQuery }, c.adminRedemptions)
  .post("/redemptions/:id/fulfil", { summary: "Mark a pending reward as fulfilled", params: idParam, body: fulfilBody, audit: audit("club.redemption_fulfilled", "redemption") }, c.fulfilRedemption)
  .post("/redemptions/:id/cancel", { summary: "Cancel a redemption (points go back)", params: idParam, body: cancelBody, audit: audit("club.redemption_cancelled", "redemption") }, c.cancelRedemption);
