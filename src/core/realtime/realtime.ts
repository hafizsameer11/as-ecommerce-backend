/**
 * Realtime (socket.io) — rooms, events and payloads.
 *
 * Connect: `io(API_URL, { auth: { token } , withCredentials: true })`. The token is a customer access token
 * or an admin access token (same JWTs as the REST API); without `auth.token` the `asl_at` / `asl_admin_at`
 * cookies are used (`auth.audience: "admin"` picks the admin cookie when both are present). Revoked sessions,
 * blocked customers and suspended admins are refused (`connect_error` with message TOKEN_INVALID / ACCOUNT_BLOCKED /
 * UNAUTHENTICATED). The server disconnects a socket when its access token expires (event `auth.expired` first):
 * refresh the token and reconnect.
 *
 * ROOMS
 *   customer:<customerId>        joined automatically by a customer socket
 *   admin:<adminId>              joined automatically by an admin socket
 *   admin:role:<role>            joined automatically by an admin socket (role-wide bell rows)
 *   admin:perm:<permission>      joined automatically, one per permission the admin holds (internal fan-out)
 *   admin:activity               any admin, on request: `join` "admin:activity" (rows are filtered by permission:
 *                                internally the socket joins admin:activity:<permission> for each permission it holds)
 *   concierge:request:<id>       the owning customer, or admins with concierge.view (`<id>` = request id or ASL number;
 *                                the ack returns the canonical room with the request id)
 *   ticket:<id>                  the owning customer, or admins with support.tickets (admins also get internal notes)
 *
 * CLIENT → SERVER
 *   join   (room: string, ack?)  → ack({ ok: true, room }) | ack({ ok: false, error: "FORBIDDEN" | "NOT_FOUND" | "BAD_ROOM" })
 *   leave  (room: string, ack?)  → ack({ ok: true })
 *   concierge:typing ({ requestId, typing: boolean })  — must have joined the request room; max one event per
 *                                1.5 s per request per socket (extra events are dropped)
 *
 * SERVER → CLIENT
 *   notification.new     customer:<id>                 inbox row, same shape as GET /store/account/notifications items
 *   order.updated        customer:<id>                 { orderId, number, status, statusLabel, paymentStatus, fulfillmentStatus, event }
 *   concierge.message    concierge:request:<id>, customer:<id> (agent/system messages), admin:perm:concierge.view
 *                        { requestId, number, message: { id, sender, authorName, channel, text, attachments, quote, read, at } }
 *   concierge.updated    concierge:request:<id>, customer:<id>, admin:perm:concierge.view
 *                        { requestId, number, status, statusLabel, event: "status" | "quoted" }
 *   concierge.typing     concierge:request:<id> (not echoed to the sender)  { requestId, from: "customer" | "agent", name, typing }
 *   ticket.message       ticket:<id> + customer:<id> + admin:perm:support.tickets (public replies);
 *                        ticket:<id>:staff + admin:perm:support.tickets (internal notes — never to the customer)
 *                        { ticketId, number, message: { id, author, authorName, body, internal, attachments, at } }
 *   admin.notification   admin:<id> or admin:role:<role>  bell row, same shape as GET /admin/notifications items
 *                        (`id` is null for rows created in bulk — refetch the bell when you need it)
 *   activity.new         admin:activity:<permission> / admin:activity   same shape as GET /admin/activity items
 *   auth.expired         the socket itself, right before the server disconnects it
 *
 * Emitting: `realtime.emit(room | rooms[], event, payload)` from anywhere. It is a no-op until the API attaches the
 * socket server (`attachRealtime(httpServer)`) or the worker attaches a Redis emitter (`attachEmitter()`), so
 * services, scripts and tests without sockets keep working. With REDIS_URL set every API process uses the Redis
 * adapter, and the worker publishes through `@socket.io/redis-emitter`, so any process can reach any socket.
 */
import { Emitter } from "@socket.io/redis-emitter";
import IORedis from "ioredis";
import type { Server } from "socket.io";
import { env } from "@/config/env";
import { logger } from "@/core/utils/logger";

type Rooms = string | string[];

let io: Server | null = null;
let ioCleanup: (() => Promise<unknown>) | undefined;
let emitter: Emitter | null = null;
let emitterRedis: IORedis | null = null;

/** set by the socket server (realtime.server.ts) */
export function setServer(server: Server | null, cleanup?: () => Promise<unknown>) {
  io = server;
  ioCleanup = cleanup;
}

/** worker / scripts: publish to the API processes' sockets through Redis (no-op without REDIS_URL) */
export function attachEmitter() {
  if (emitter || !env.REDIS_URL) return emitter;
  emitterRedis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  emitter = new Emitter(emitterRedis);
  return emitter;
}

const clean = (rooms: Rooms) => [...new Set((Array.isArray(rooms) ? rooms : [rooms]).filter(Boolean))];

/** JSON round-trip: Dates → ISO strings, BigInt → number (socket.io can't encode BigInt) */
const plain = (payload: unknown) => JSON.parse(JSON.stringify(payload ?? null, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));

export type BellRow = {
  id?: string | null;
  adminId?: string | null;
  role?: string | null;
  ruleId?: string | null;
  title: string;
  body: string;
  link?: string | null;
  priority?: string | null;
  createdAt?: Date | string | null;
};

export const realtime = {
  get attached() {
    return Boolean(io || emitter);
  },

  /** emit to one or more rooms (a socket in several of them gets the event once). Never throws. */
  emit(rooms: Rooms, event: string, payload: unknown) {
    if (!io && !emitter) return;
    const list = clean(rooms);
    if (!list.length) return;
    try {
      const data = plain(payload);
      if (io) io.to(list).emit(event, data);
      else emitter!.to(list).emit(event, data);
    } catch (err) {
      logger.error({ err, event, rooms: list }, "realtime emit failed");
    }
  },

  /** new AdminNotification bell rows → `admin.notification` to the admin (or to every admin of the role) */
  bell(rows: BellRow | BellRow[]) {
    for (const n of Array.isArray(rows) ? rows : [rows]) {
      const room = n.adminId ? `admin:${n.adminId}` : n.role ? `admin:role:${n.role}` : null;
      if (!room) continue;
      this.emit(room, "admin.notification", {
        id: n.id ?? null, ruleId: n.ruleId ?? null, title: n.title, body: n.body, link: n.link ?? null, priority: n.priority ?? "normal",
        read: false, readAt: null, createdAt: n.createdAt ?? new Date(), scope: n.adminId ? "me" : "role",
      });
    }
  },

  /** sockets of these rooms reconnect (e.g. after a role / permission change, so their rooms are rebuilt) */
  disconnect(rooms: Rooms) {
    const list = clean(rooms);
    if (!list.length) return;
    try {
      if (io) io.in(list).disconnectSockets(true);
      else emitter?.in(list).disconnectSockets(true);
    } catch (err) {
      logger.error({ err, rooms: list }, "realtime disconnect failed");
    }
  },

  async close() {
    const s = io;
    io = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
    await ioCleanup?.();
    ioCleanup = undefined;
    emitter = null;
    if (emitterRedis) await emitterRedis.quit().catch(() => undefined);
    emitterRedis = null;
  },
};
