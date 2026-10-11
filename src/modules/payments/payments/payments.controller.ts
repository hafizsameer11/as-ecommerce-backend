import type { Ctx } from "@/core/http/router";
import { ApiError } from "@/core/http/errors";
import { isProd } from "@/config/env";
import { MockPaymentProvider, paymentProvider } from "@/providers/payment/payment";
import { paymentsService as svc } from "./payments.service";
import { mockCheckoutPage, mockResultPage } from "./mock-checkout.page";

type Ref = { reference: string };

function mock() {
  if (isProd || !(paymentProvider instanceof MockPaymentProvider)) throw ApiError.notFound("Page");
  return paymentProvider;
}

export const paymentsController = {
  status: ({ params, req }: Ctx<unknown, unknown, Ref>) => svc.publicStatus(params.reference, req.customer?.id),
  /** app returns from the payment page → confirm with the gateway (don't wait for the webhook) */
  verify: async ({ params, req }: Ctx<unknown, unknown, Ref>) => {
    await svc.publicStatus(params.reference, req.customer?.id); // ownership check
    return svc.settle(params.reference);
  },
  webhook: ({ params, req, body }: Ctx<unknown, unknown, { provider: string }>) =>
    svc.webhook(params.provider, (req as unknown as { rawBody?: Buffer }).rawBody, req.header("x-paystack-signature") ?? req.header("x-signature"), body),

  // ── mock gateway (dev / staging only) ──
  mockPage: async ({ params, res }: Ctx<unknown, unknown, Ref>) => {
    mock();
    const p = await svc.getByReference(params.reference);
    // the result redirects back to the app/site, so allow any form target on this page only
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action *");
    res.type("html").send(mockCheckoutPage(p));
  },
  mockComplete: async ({ params, body, res }: Ctx<{ outcome: "success" | "failed" }, unknown, Ref>) => {
    const gw = mock();
    const p = await svc.getByReference(params.reference);
    gw.settle(p.reference, body.outcome, p.amount);
    const st = await svc.settle(p.reference);
    if (st.returnUrl) {
      const u = new URL(st.returnUrl);
      u.searchParams.set("reference", st.reference);
      u.searchParams.set("status", st.status);
      return res.redirect(303, u.toString());
    }
    res.type("html").send(mockResultPage(st));
  },

  adminList: ({ query }: Ctx<unknown, { page: number; pageSize: number; q?: string; status?: string; purpose?: string }>) => svc.adminList(query),
};
