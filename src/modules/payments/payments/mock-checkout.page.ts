/** Tiny HTML page that stands in for the Paystack checkout while no gateway is chosen. */
import type { Payment } from "@/generated/prisma/client";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const naira = (k: number) => `₦${(k / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;
const shell = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Test payment</title><style>
body{font-family:system-ui,sans-serif;background:#faf8f3;color:#0f0f0f;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
.card{background:#fff;border:1px solid #e6e1d6;border-radius:8px;padding:28px;max-width:380px;width:100%}
h1{font-size:18px;margin:0 0 4px}.muted{color:#6b665c;font-size:13px}.amt{font-size:32px;font-weight:700;margin:20px 0}
button{width:100%;padding:14px;border:0;border-radius:4px;font-size:15px;font-weight:600;cursor:pointer;margin-top:10px}
.pay{background:#cc5000;color:#fff}.fail{background:#eee;color:#333}.tag{display:inline-block;background:#fff3e8;color:#cc5000;font-size:11px;padding:3px 8px;border-radius:99px;font-weight:600}
</style></head><body><div class="card">${body}</div></body></html>`;

export function mockCheckoutPage(p: Payment) {
  if (p.status !== "pending") return mockResultPage({ reference: p.reference, status: p.status });
  return shell(`<span class="tag">TEST MODE — no real money</span>
<h1 style="margin-top:14px">ASL ORIGINALS</h1><div class="muted">${esc(p.email)} · ${esc(p.reference)}</div>
<div class="amt">${naira(p.amount)}</div>
<form method="post" action="./${encodeURIComponent(p.reference)}/complete"><input type="hidden" name="outcome" value="success"><button class="pay">Pay ${naira(p.amount)}</button></form>
<form method="post" action="./${encodeURIComponent(p.reference)}/complete"><input type="hidden" name="outcome" value="failed"><button class="fail">Simulate failed payment</button></form>`);
}

export function mockResultPage(st: { reference: string; status: string }) {
  const ok = st.status === "succeeded";
  return shell(`<h1>${ok ? "Payment successful" : st.status === "failed" ? "Payment failed" : "Payment " + esc(st.status)}</h1>
<p class="muted">Reference ${esc(st.reference)}. You can close this window and return to the app.</p>`);
}
