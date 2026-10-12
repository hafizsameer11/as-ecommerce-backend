import { ModuleRouter, idParam } from "@/core/http/router";
import { referralsController as c } from "./referrals.controller";
import { advocateListQuery, advocateStatusBody, clickBody, codeParam, configBody, noteBody, referralListQuery } from "./referrals.schemas";

/** /account/referrals */
export const myReferralsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/me/referrals", tag: "Referrals", defaultAuth: "customer" })
  .get("/", { summary: "My code, share link, stats (clicks / invited / joined / earned) and friends" }, c.mine);

/** share link landing page (/r/:code) and the register form's code check — public */
export const referralsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/referrals", tag: "Referrals" })
  .post("/click/:code", { summary: "Count a share-link visit; returns what the friend gets", params: codeParam, body: clickBody }, c.click)
  .get("/:code", { summary: "Check a referral code (no click counted)", params: codeParam }, c.lookup);

const audit = (action: string, entity = "referral") => ({ category: "marketing", action, entity });

/** asl-admin /referrals — reads need customers.view, changes need marketing.manage */
export const referralsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/referrals", tag: "Referrals", defaultAuth: "admin", defaultPermission: "marketing.manage" })
  .get("/overview", { summary: "KPIs, funnel, channels, leaderboard", permission: "customers.view" }, c.overview)
  .get("/config", { summary: "Programme settings", permission: "customers.view" }, c.config)
  .put("/config", { summary: "Update programme settings", body: configBody, audit: audit("referrals.config_updated", "settings") }, c.updateConfig)
  .get("/advocates", { summary: "Advocates with clicks, sign-ups, rewards, revenue driven", permission: "customers.view", query: advocateListQuery }, c.advocates)
  .patch("/advocates/:id/status", { summary: "Pause / ban / reactivate an advocate", params: idParam, body: advocateStatusBody, audit: audit("referrals.advocate_status", "advocate") }, c.setAdvocateStatus)
  .get("/", { summary: "Referrals (status tabs: pending / qualified / rewarded / flagged / expired / rejected)", permission: "customers.view", query: referralListQuery }, c.list)
  .get("/:id", { summary: "Referral", permission: "customers.view", params: idParam }, c.get)
  .post("/:id/approve", { summary: "Approve → reward the advocate now (and the friend if not yet)", params: idParam, body: noteBody, audit: audit("referrals.approved") }, c.approve)
  .post("/:id/reject", { summary: "Reject (no reward)", params: idParam, body: noteBody, audit: audit("referrals.rejected") }, c.reject)
  .post("/:id/flag", { summary: "Flag for review (auto-reward stops)", params: idParam, body: noteBody, audit: audit("referrals.flagged") }, c.flag)
  .post("/:id/reopen", { summary: "Move back to pending", params: idParam, body: noteBody, audit: audit("referrals.reopened") }, c.reopen);
