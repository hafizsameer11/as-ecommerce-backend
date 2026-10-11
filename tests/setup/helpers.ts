import request from "supertest";
import { createApp } from "@/app";
import { prisma } from "@/core/db/prisma";
import { hashPassword } from "@/core/auth/password";
import type { AdminRole } from "@/generated/prisma/enums";
import { events } from "@/core/events/bus";
import { flushInlineJobs } from "@/core/queue/queue";

export const app = createApp();
export const api = () => request(app);

let n = 0;
export const uniq = (p = "u") => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;

export async function registerCustomer(over: Partial<{ email: string; password: string; name: string }> = {}) {
  const email = over.email ?? `${uniq("c")}@test.dev`;
  const password = over.password ?? "Password123!";
  const res = await api().post("/api/v1/store/auth/register").send({ name: over.name ?? "John Doe", email, password });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { email, password, token: res.body.data.accessToken as string, refreshToken: res.body.data.refreshToken as string, customer: res.body.data.customer };
}

export async function createAdmin(role: AdminRole = "super_admin", password = "AdminPass123!") {
  const email = `${uniq("a")}@asl.dev`;
  const admin = await prisma.adminUser.create({ data: { email, name: `Admin ${role}`, role, status: "active", passwordHash: await hashPassword(password) } });
  const res = await api().post("/api/v1/admin/auth/login").send({ email, password });
  if (res.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(res.body)}`);
  return { admin, token: res.body.data.accessToken as string, email, password };
}

export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/** wait for async event listeners + inline jobs */
export async function settle() {
  await events.flush();
  await flushInlineJobs();
  await events.flush();
}
