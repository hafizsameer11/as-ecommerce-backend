/**
 * socket.io server: handshake auth (same rules as core/middleware/auth.ts), automatic personal rooms,
 * `join` / `leave` with per-room authorisation, and the concierge typing indicator.
 * Rooms + events are listed in realtime.ts.
 */
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import IORedis from "ioredis";
import jwt from "jsonwebtoken";
import { env, isTest } from "@/config/env";
import { prisma } from "@/core/db/prisma";
import { verifyAccessToken, type Audience } from "@/core/auth/tokens";
import { ADMIN_COOKIE, CUSTOMER_COOKIE } from "@/core/middleware/auth";
import type { Permission } from "@/core/auth/permissions";
import { logger } from "@/core/utils/logger";
import { effectivePermissions } from "@/modules/identity/team/team.permissions";
import { realtime, setServer } from "./realtime";

type CustomerIdentity = { kind: "customer"; id: string; sid: string; name: string };
type AdminIdentity = { kind: "admin"; id: string; sid: string; name: string; role: string; permissions: Set<Permission> };
export type SocketIdentity = CustomerIdentity | AdminIdentity;
type AppSocket = Socket & { data: { who: SocketIdentity; typingAt: Map<string, number> } };
type Ack = (r: { ok: boolean; room?: string; error?: string }) => void;

export const TYPING_INTERVAL_MS = 1500;

/** `connect_error` on the client: err.message = code, err.data = { code, message } */
class AuthError extends Error {
  data: { code: string; message: string };
  constructor(code: string, message: string) {
    super(code);
    this.data = { code, message };
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

/** candidate (token, audience) pairs from the handshake, most specific first */
function candidates(socket: Socket): { token: string; aud: Audience }[] {
  const auth = (socket.handshake.auth ?? {}) as { token?: unknown; audience?: unknown };
  const wanted = auth.audience === "admin" || auth.audience === "customer" ? (auth.audience as Audience) : null;
  const header = socket.handshake.headers.authorization;
  const token = typeof auth.token === "string" && auth.token ? auth.token : header?.startsWith("Bearer ") ? header.slice(7) : null;
  const both: Audience[] = wanted ? [wanted] : ["customer", "admin"];
  if (token) return both.map((aud) => ({ token, aud }));
  const cookies = parseCookies(socket.handshake.headers.cookie);
  const order: Audience[] = wanted ? [wanted] : ["admin", "customer"];
  return order.flatMap((aud) => {
    const t = cookies[aud === "admin" ? ADMIN_COOKIE : CUSTOMER_COOKIE];
    return t ? [{ token: t, aud }] : [];
  });
}

/** same session rules as requireCustomer / requireAdmin */
async function identify(socket: Socket): Promise<{ who: SocketIdentity; exp: number | null }> {
  const list = candidates(socket);
  if (!list.length) throw new AuthError("UNAUTHENTICATED", "Sign in to connect.");
  for (const { token, aud } of list) {
    let p;
    try {
      p = verifyAccessToken(token, aud);
    } catch {
      continue;
    }
    const exp = (jwt.decode(token) as { exp?: number } | null)?.exp ?? null;
    if (aud === "customer") {
      const s = await prisma.customerSession.findUnique({
        where: { id: p.sid },
        select: { revokedAt: true, customerId: true, customer: { select: { status: true, deletedAt: true, firstName: true, lastName: true } } },
      });
      if (s && (s.customer.status === "blocked" || s.customer.deletedAt)) throw new AuthError("ACCOUNT_BLOCKED", "This account is not available.");
      if (!s || s.revokedAt || s.customerId !== p.sub) throw new AuthError("TOKEN_INVALID", "Your session has ended.");
      return { who: { kind: "customer", id: p.sub, sid: p.sid, name: `${s.customer.firstName} ${s.customer.lastName}`.trim() || "Customer" }, exp };
    }
    const s = await prisma.adminSession.findUnique({
      where: { id: p.sid },
      select: { revokedAt: true, admin: { select: { id: true, role: true, status: true, name: true } } },
    });
    if (!s || s.revokedAt || s.admin.id !== p.sub) throw new AuthError("TOKEN_INVALID", "Your session has ended.");
    if (s.admin.status !== "active") throw new AuthError("ACCOUNT_BLOCKED", "This team account is suspended.");
    return {
      who: { kind: "admin", id: s.admin.id, sid: p.sid, name: s.admin.name, role: s.admin.role, permissions: await effectivePermissions(s.admin.role) },
      exp,
    };
  }
  throw new AuthError("TOKEN_INVALID", "Your session has expired.");
}

/** session still alive? (checked again on every join) */
async function stillValid(who: SocketIdentity) {
  if (who.kind === "customer") {
    const s = await prisma.customerSession.findUnique({ where: { id: who.sid }, select: { revokedAt: true, customer: { select: { status: true, deletedAt: true } } } });
    return !!s && !s.revokedAt && s.customer.status !== "blocked" && !s.customer.deletedAt;
  }
  const s = await prisma.adminSession.findUnique({ where: { id: who.sid }, select: { revokedAt: true, admin: { select: { status: true } } } });
  return !!s && !s.revokedAt && s.admin.status === "active";
}

const isAdmin = (w: SocketIdentity): w is AdminIdentity => w.kind === "admin";
const can = (w: SocketIdentity, p: Permission) => isAdmin(w) && w.permissions.has(p);

/** room requested by the client → rooms to join (or an error code) */
async function resolveJoin(who: SocketIdentity, room: string): Promise<{ rooms: string[]; canonical: string } | { error: string }> {
  if (typeof room !== "string" || room.length > 120) return { error: "BAD_ROOM" };
  if (room === `customer:${who.id}` && who.kind === "customer") return { rooms: [room], canonical: room };
  if (room === `admin:${who.id}` && isAdmin(who)) return { rooms: [room], canonical: room };
  if (isAdmin(who) && room === `admin:role:${who.role}`) return { rooms: [room], canonical: room };
  if (room === "admin:activity") {
    if (!isAdmin(who)) return { error: "FORBIDDEN" };
    return { rooms: [room, ...[...who.permissions].map((p) => `admin:activity:${p}`)], canonical: room };
  }
  let m = /^concierge:request:(.+)$/.exec(room);
  if (m) {
    const key = m[1];
    const r = await prisma.conciergeRequest.findFirst({ where: { OR: [{ id: key }, { number: key.toUpperCase() }] }, select: { id: true, customerId: true } });
    if (!r) return { error: "NOT_FOUND" };
    const allowed = who.kind === "customer" ? r.customerId === who.id : can(who, "concierge.view");
    if (!allowed) return { error: who.kind === "customer" ? "NOT_FOUND" : "FORBIDDEN" };
    const canonical = `concierge:request:${r.id}`;
    return { rooms: [canonical], canonical };
  }
  m = /^ticket:([^:]+)$/.exec(room);
  if (m) {
    const key = m[1];
    const t = await prisma.ticket.findFirst({ where: { OR: [{ id: key }, { number: key.toUpperCase() }] }, select: { id: true, customerId: true } });
    if (!t) return { error: "NOT_FOUND" };
    if (who.kind === "customer") {
      if (t.customerId !== who.id) return { error: "NOT_FOUND" };
      return { rooms: [`ticket:${t.id}`], canonical: `ticket:${t.id}` };
    }
    if (!can(who, "support.tickets")) return { error: "FORBIDDEN" };
    return { rooms: [`ticket:${t.id}`, `ticket:${t.id}:staff`], canonical: `ticket:${t.id}` };
  }
  return { error: who.kind === "customer" || room.startsWith("admin:") || room.startsWith("customer:") ? "FORBIDDEN" : "BAD_ROOM" };
}

function onConnection(socket: AppSocket) {
  const who = socket.data.who;
  socket.data.typingAt = new Map();
  if (who.kind === "customer") void socket.join(`customer:${who.id}`);
  else void socket.join([`admin:${who.id}`, `admin:role:${who.role}`, ...[...who.permissions].map((p) => `admin:perm:${p}`)]);

  socket.on("join", async (room: string, ack?: Ack) => {
    const reply = typeof ack === "function" ? ack : () => undefined;
    try {
      if (!(await stillValid(who))) {
        reply({ ok: false, error: "TOKEN_INVALID" });
        socket.disconnect(true);
        return;
      }
      const r = await resolveJoin(who, room);
      if ("error" in r) return reply({ ok: false, error: r.error });
      await socket.join(r.rooms);
      reply({ ok: true, room: r.canonical });
    } catch (err) {
      logger.error({ err, room }, "socket join failed");
      reply({ ok: false, error: "INTERNAL" });
    }
  });

  socket.on("leave", async (room: string, ack?: Ack) => {
    const reply = typeof ack === "function" ? ack : () => undefined;
    if (typeof room !== "string") return reply({ ok: false, error: "BAD_ROOM" });
    // personal rooms stay joined for the life of the socket
    if (room === `customer:${who.id}` || room === `admin:${who.id}` || room.startsWith("admin:role:") || room.startsWith("admin:perm:")) return reply({ ok: true });
    const extra = room === "admin:activity" ? [...socket.rooms].filter((x) => x.startsWith("admin:activity:")) : room.startsWith("ticket:") ? [`${room}:staff`] : [];
    for (const x of [room, ...extra]) await socket.leave(x);
    reply({ ok: true });
  });

  socket.on("concierge:typing", (p: { requestId?: unknown; typing?: unknown }) => {
    if (!p || typeof p.requestId !== "string") return;
    const room = `concierge:request:${p.requestId}`;
    if (!socket.rooms.has(room)) return;
    const typing = p.typing !== false;
    const last = socket.data.typingAt.get(room) ?? 0;
    const now = Date.now();
    // "stopped typing" always goes through; "typing" at most once per interval
    if (typing && now - last < TYPING_INTERVAL_MS) return;
    if (typing) socket.data.typingAt.set(room, now);
    socket.to(room).emit("concierge.typing", { requestId: p.requestId, from: who.kind === "customer" ? "customer" : "agent", name: who.name, typing });
  });
}

/** Attach socket.io to the API's HTTP server (server.ts and tests). Uses the Redis adapter when REDIS_URL is set. */
export function attachRealtime(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    path: "/socket.io",
    serveClient: false,
    cors: { origin: true, credentials: true },
  });

  let cleanup: (() => Promise<unknown>) | undefined;
  if (env.REDIS_URL && !isTest) {
    const pub = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    const sub = pub.duplicate();
    io.adapter(createAdapter(pub, sub));
    cleanup = () => Promise.allSettled([pub.quit(), sub.quit()]);
  }

  io.use((socket, next) => {
    identify(socket)
      .then(({ who, exp }) => {
        (socket as AppSocket).data.who = who;
        if (exp) {
          const ms = exp * 1000 - Date.now();
          const timer = setTimeout(() => {
            socket.emit("auth.expired", { reason: "TOKEN_EXPIRED" });
            socket.disconnect(true);
          }, Math.max(0, Math.min(ms, 2_147_000_000)));
          timer.unref?.();
          socket.on("disconnect", () => clearTimeout(timer));
        }
        next();
      })
      .catch((err) => {
        if (err instanceof AuthError) return next(err);
        logger.error({ err }, "socket auth failed");
        next(new AuthError("INTERNAL", "Could not connect."));
      });
  });

  io.on("connection", (s) => onConnection(s as AppSocket));
  setServer(io, cleanup);
  logger.debug("realtime attached");
  return io;
}

export { realtime };
