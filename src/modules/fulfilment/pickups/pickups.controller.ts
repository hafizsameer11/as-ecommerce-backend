import type { Ctx } from "@/core/http/router";
import { pickupsService as svc } from "./pickups.service";
import type { LocationBody } from "./pickups.schemas";

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
};
