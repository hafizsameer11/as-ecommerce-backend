import type { Ctx } from "@/core/http/router";
import { pickupsService as svc } from "./pickups.service";
import type { BookingAdvanceBody, BookingListQuery, BookingRescheduleBody, LocationBody } from "./pickups.schemas";

type Id = { id: string };

export const pickupsController = {
  storeLocations: () => svc.storeLocations(),
  listLocations: () => svc.listLocations(),
  createLocation: ({ body }: Ctx<LocationBody>) => svc.createLocation(body),
  updateLocation: async ({ params, body, res }: Ctx<Partial<LocationBody>, unknown, Id>) => {
    const r = await svc.updateLocation(params.id, body);
    res.locals.audit = { entityId: params.id, before: r.before, after: r.after, summary: `Updated pick-up store ${r.after.name}` };
    return r.after;
  },
  removeLocation: ({ params }: Ctx<unknown, unknown, Id>) => svc.removeLocation(params.id),

  // bookings
  listBookings: ({ query }: Ctx<unknown, BookingListQuery>) => svc.listBookings(query),
  getBooking: ({ params }: Ctx<unknown, unknown, Id>) => svc.getBooking(params.id),
  advanceBooking: async ({ params, body, admin, res }: Ctx<BookingAdvanceBody, unknown, Id>) => {
    const b = await svc.advanceBooking(params.id, body, admin.name);
    res.locals.audit = { entityId: b.id, summary: `Pick-up ${b.number} (${b.orderNumber}) → ${b.statusLabel}${b.collectedBy && body.status === "collected" ? ` by ${b.collectedBy}` : ""}` };
    return b;
  },
  bookingNote: async ({ params, body, res }: Ctx<{ note: string }, unknown, Id>) => {
    const b = await svc.setBookingNote(params.id, body.note);
    res.locals.audit = { entityId: b.id, summary: `Note on pick-up ${b.number}` };
    return b;
  },
  reschedule: async ({ params, body, admin, res }: Ctx<BookingRescheduleBody, unknown, Id>) => {
    const r = await svc.rescheduleBooking(params.id, body, admin.name);
    res.locals.audit = { entityId: r.after.id, before: r.before, after: { scheduledAt: r.after.scheduledAt, locationId: r.after.locationId }, summary: `Rescheduled pick-up ${r.after.number}` };
    return r.after;
  },
};
