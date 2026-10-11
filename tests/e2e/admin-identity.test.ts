import { beforeEach, describe, expect, it } from "vitest";
import { api, bearer, createAdmin, settle } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { mail } from "@/providers/mail/mail";
import { prisma } from "@/core/db/prisma";

beforeEach(resetDb);

describe("admin auth + team", () => {
  it("returns profile with role permissions", async () => {
    const { token } = await createAdmin("finance");
    const me = await api().get("/api/v1/admin/me").set(bearer(token));
    expect(me.body.data.role).toBe("finance");
    expect(me.body.data.permissions).toContain("finance.ledger");
    expect(me.body.data.permissions).not.toContain("team.manage");
  });

  it("customer token cannot reach admin routes", async () => {
    const reg = await api().post("/api/v1/store/auth/register").send({ name: "A B", email: "x@y.dev", password: "Password123!" });
    const r = await api().get("/api/v1/admin/me").set(bearer(reg.body.data.accessToken));
    expect(r.status).toBe(401);
  });

  it("enforces permissions (support cannot manage team)", async () => {
    const { token } = await createAdmin("support");
    const r = await api().get("/api/v1/admin/team/members").set(bearer(token));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("FORBIDDEN");
  });

  it("invite → accept → login; audit records it", async () => {
    const { token } = await createAdmin("super_admin");
    const inv = await api().post("/api/v1/admin/team/members").set(bearer(token)).send({ name: "Tolu", email: "tolu@asl.dev", role: "concierge_agent" });
    expect(inv.status).toBe(201);
    expect(mail.outbox!.some((m) => m.to === "tolu@asl.dev")).toBe(true);
    const acc = await api().post("/api/v1/admin/auth/invite/accept").send({ token: inv.body.data.inviteToken, password: "VerySecure123" });
    expect(acc.status).toBe(200);
    expect(acc.body.data.admin.status).toBe("active");
    await settle();
    const audit = await api().get("/api/v1/admin/audit?category=team").set(bearer(token));
    expect(audit.body.data[0].action).toBe("team.invited");
    expect(audit.body.data[0].summary).toContain("tolu@asl.dev");
  });

  it("suspending a member revokes their sessions; last super admin is protected", async () => {
    const { token, admin } = await createAdmin("super_admin");
    const other = await createAdmin("marketing");
    await api().patch(`/api/v1/admin/team/members/${other.admin.id}`).set(bearer(token)).send({ status: "suspended" }).expect(200);
    expect((await api().get("/api/v1/admin/me").set(bearer(other.token))).status).toBe(401);
    const self = await api().patch(`/api/v1/admin/team/members/${admin.id}`).set(bearer(token)).send({ role: "analyst" });
    expect(self.body.error.code).toBe("INVALID_STATE");
  });

  it("role permission override + reset", async () => {
    const { token } = await createAdmin();
    const sup = await createAdmin("support");
    await api().put("/api/v1/admin/team/roles/support/permissions").set(bearer(token)).send({ permissions: ["support.tickets", "team.manage"] }).expect(200);
    expect((await api().get("/api/v1/admin/team/members").set(bearer(sup.token))).status).toBe(200);
    await api().delete("/api/v1/admin/team/roles/support/permissions").set(bearer(token)).expect(200);
    expect((await api().get("/api/v1/admin/team/members").set(bearer(sup.token))).status).toBe(403);
  });
});

describe("settings: single source of business rules", () => {
  it("public settings expose the unified rules", async () => {
    const r = await api().get("/api/v1/store/settings/public");
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.returns.windowDays).toBe(7);
    expect(d.shipping.freeShippingThreshold).toBe(15_000_000);
    expect(d.tiers.map((t: any) => t.id)).toEqual(["Standard", "Silver", "Gold", "Signature"]);
    const fees = Object.fromEntries(d.deliveryRates.map((z: any) => [z.zone, z.rates[0].fee]));
    expect(fees).toMatchObject({ Lagos: 400_000, Abuja: 500_000, "Other States": 600_000 });
    expect(d.concierge.serviceFee).toBe(5_050_000);
    expect(d.labels.concierge.customer.approved).toBe("Order Confirmed");
    expect(d.paymentMethods.map((p: any) => p.id)).toContain("wallet");
  });

  it("admin edits a rule → storefront sees it; change is audited", async () => {
    const { token } = await createAdmin("super_admin");
    await api().patch("/api/v1/admin/settings/returns").set(bearer(token)).send({ windowDays: 14 }).expect(200);
    expect((await api().get("/api/v1/store/settings/public")).body.data.returns.windowDays).toBe(14);
    const bad = await api().patch("/api/v1/admin/settings/returns").set(bearer(token)).send({ windowDays: "lots" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_FAILED");
    const ev = await prisma.auditEvent.findFirst({ where: { action: "settings.updated" } });
    expect(ev?.entityId).toBe("returns");
  });

  it("maintenance mode blocks the storefront but not settings/admin", async () => {
    const { token } = await createAdmin();
    await api().patch("/api/v1/admin/settings/maintenance").set(bearer(token)).send({ enabled: true }).expect(200);
    const blocked = await api().post("/api/v1/store/auth/login").send({ email: "a@b.dev", password: "x" });
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe("MAINTENANCE_MODE");
    expect((await api().get("/api/v1/store/settings/public")).status).toBe(200);
    expect((await api().get("/api/v1/admin/me").set(bearer(token))).status).toBe(200);
  });
});
