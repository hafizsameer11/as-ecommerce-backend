import type { Ctx } from "@/core/http/router";
import { abandonedCartsService as svc } from "./abandoned-carts.service";
import type { AbandonedListQuery, RecoveryRulesBody, ReminderChannel } from "./abandoned-carts.schemas";

type Id = { id: string };

export const abandonedCartsController = {
  list: ({ query }: Ctx<unknown, AbandonedListQuery>) => svc.list(query),
  remind: async ({ params, body, res }: Ctx<{ channel: ReminderChannel }, unknown, Id>) => {
    const r = await svc.remind(params.id, body.channel);
    res.locals.audit = { after: { stage: r.stage, channel: body.channel }, summary: `${body.channel === "push" ? "Push" : "Email"} reminder sent for cart ${r.ref} (${r.stage})` };
    return r;
  },
  remindBulk: async ({ body, res }: Ctx<{ ids?: string[] }>) => {
    const r = await svc.remindBulk(body.ids);
    res.locals.audit = { after: r, summary: `Bulk cart reminder sent to ${r.sent} cart(s)` };
    return r;
  },
  rules: () => svc.rules(),
  saveRules: async ({ body, res }: Ctx<RecoveryRulesBody>) => {
    const r = await svc.saveRules(body);
    res.locals.audit = { before: r.before.rules, after: r.after.rules, summary: "Recovery rules saved" };
    return r.after;
  },
};
