/**
 * Built-in templates. Seeded into MessageTemplate so admin → /messaging can edit them;
 * the code falls back to these if a row is missing. Variables use {{name}}.
 */
export type DefaultTemplate = {
  code: string; name: string; channel: "email" | "sms" | "push" | "whatsapp";
  category: "transactional" | "lifecycle" | "concierge" | "system";
  trigger: string; subject?: string; body: string; ctaLabel?: string; linkTo?: string;
};

export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  { code: "auth.welcome", name: "Welcome", channel: "email", category: "lifecycle", trigger: "customer.registered",
    subject: "Welcome to ASL ORIGINALS, {{firstName}}", body: "Hi {{firstName}},\n\nYour account is ready. Discover authentic luxury, curated for you.", ctaLabel: "Start shopping", linkTo: "/shop" },
  { code: "auth.password_reset", name: "Password reset", channel: "email", category: "system", trigger: "password.forgot",
    subject: "Reset your ASL ORIGINALS password", body: "Hi {{firstName}},\n\nUse the link below to set a new password. It expires in 30 minutes.\n\n{{resetUrl}}\n\nIf you didn't ask for this, you can ignore this email." },
  { code: "auth.otp", name: "One-time code", channel: "email", category: "system", trigger: "otp.requested",
    subject: "Your ASL ORIGINALS code: {{code}}", body: "Your one-time code is {{code}}. It expires in 10 minutes." },
  { code: "auth.otp", name: "One-time code (SMS)", channel: "sms", category: "system", trigger: "otp.requested",
    body: "ASL ORIGINALS code: {{code}}. Expires in 10 min. Never share it." },
  { code: "admin.invite", name: "Team invite", channel: "email", category: "system", trigger: "team.invited",
    subject: "You've been invited to ASL ORIGINALS Admin", body: "Hi {{name}},\n\n{{inviter}} invited you as {{role}}. Set your password here (valid 7 days):\n\n{{inviteUrl}}" },
  { code: "order.confirmed", name: "Order confirmed", channel: "email", category: "transactional", trigger: "order.paid",
    subject: "Order {{orderNumber}} confirmed", body: "Hi {{firstName}},\n\nThank you for your order {{orderNumber}} ({{total}}). We'll let you know when it ships.", ctaLabel: "View order", linkTo: "{{orderUrl}}" },
  { code: "order.confirmed", name: "Order confirmed (push)", channel: "push", category: "transactional", trigger: "order.paid",
    subject: "Order Confirmed", body: "Your order {{orderNumber}} has been confirmed." },
  { code: "order.shipped", name: "Order shipped", channel: "email", category: "transactional", trigger: "order.shipped",
    subject: "Your order {{orderNumber}} is on its way", body: "Good news! Your order {{orderNumber}} has shipped with {{carrier}}. Tracking: {{tracking}}", ctaLabel: "Track order", linkTo: "{{orderUrl}}" },
  { code: "order.shipped", name: "Order shipped (push)", channel: "push", category: "transactional", trigger: "order.shipped",
    subject: "Order Shipped", body: "Good news! Your order {{orderNumber}} has been shipped." },
  { code: "order.delivered", name: "Order delivered", channel: "push", category: "transactional", trigger: "order.delivered",
    subject: "Order Delivered", body: "Your order {{orderNumber}} has been delivered. Enjoy!" },
  { code: "pickup.ready", name: "Ready for pickup", channel: "sms", category: "transactional", trigger: "pickup.ready",
    body: "ASL ORIGINALS: order {{orderNumber}} is ready for pick-up at {{location}}." },
  { code: "pickup.ready", name: "Ready for pickup (push)", channel: "push", category: "transactional", trigger: "pickup.ready",
    subject: "Ready for pick-up", body: "Your order {{orderNumber}} is ready for pick-up at {{location}}." },
  { code: "pickup.ready", name: "Ready for pickup (email)", channel: "email", category: "transactional", trigger: "pickup.ready",
    subject: "Order {{orderNumber}} is ready for pick-up", body: "Hi {{firstName}},\n\nYour order {{orderNumber}} is ready at {{location}} ({{address}}).\n\nOpening hours: {{hours}}. Please bring a valid ID.", ctaLabel: "View order", linkTo: "{{orderUrl}}" },
  { code: "order.cancelled", name: "Order cancelled", channel: "email", category: "transactional", trigger: "order.cancelled",
    subject: "Order {{orderNumber}} cancelled", body: "Hi {{firstName}},\n\nYour order {{orderNumber}} ({{total}}) has been cancelled. {{reason}}\n\nIf you paid, the refund is on its way to your original payment method or ASL Wallet.", ctaLabel: "View order", linkTo: "{{orderUrl}}" },
  { code: "return.updated", name: "Return update", channel: "email", category: "transactional", trigger: "return.updated",
    subject: "Return {{returnNumber}}: {{status}}", body: "Your return request {{returnNumber}} is now: {{status}}.\n\n{{note}}", ctaLabel: "View return", linkTo: "/account/returns" },
  { code: "concierge.received", name: "Concierge request received", channel: "email", category: "concierge", trigger: "concierge.requested",
    subject: "Request {{requestNumber}} received", body: "We've received your request for {{itemName}}. A client advisor will be in touch within 24 - 48 hours." },
  { code: "concierge.quoted", name: "Concierge quote ready", channel: "email", category: "concierge", trigger: "concierge.quoted",
    subject: "Your quote for {{itemName}} is ready", body: "Your quote total is {{total}} (valid until {{expiresAt}}).", ctaLabel: "View quote", linkTo: "/account/requests" },
  { code: "ticket.received", name: "Support request received", channel: "email", category: "transactional", trigger: "ticket.created",
    subject: "We received your request ({{ticketNumber}})", body: "Thank you for contacting ASL ORIGINALS. A member of our Client Support team will be in touch within 24 hours. Reference: {{ticketNumber}}." },
  { code: "ticket.reply", name: "Support reply", channel: "email", category: "transactional", trigger: "ticket.replied",
    subject: "Re: {{subject}} ({{ticketNumber}})", body: "{{agent}} replied:\n\n{{body}}" },
  { code: "wallet.topup", name: "Wallet top-up", channel: "push", category: "transactional", trigger: "wallet.topup",
    subject: "Wallet topped up", body: "{{amount}} has been added to your wallet." },
  { code: "order.invoice", name: "Order invoice", channel: "email", category: "transactional", trigger: "order.invoice_emailed",
    subject: "Invoice {{invoiceNumber}} for order {{orderNumber}}", body: "Hi {{firstName}},\n\nPlease find attached the invoice {{invoiceNumber}} for your order {{orderNumber}} ({{total}}).\n\nThank you for shopping with ASL ORIGINALS." },
  { code: "draft.pay_link", name: "Draft order pay link", channel: "email", category: "transactional", trigger: "draft.sent",
    subject: "Your ASL ORIGINALS order {{draftNumber}} is ready to pay", body: "Hi {{firstName}},\n\nWe've prepared your order {{draftNumber}} ({{total}}). Review it and pay securely here:\n\n{{payUrl}}\n\nThis link is valid until {{expiresAt}}.", ctaLabel: "Review and pay", linkTo: "{{payUrl}}" },
  { code: "cart.reminder", name: "Abandoned cart reminder", channel: "email", category: "lifecycle", trigger: "cart.abandoned",
    subject: "You left something behind", body: "Hi {{firstName}},\n\nYour bag is waiting: {{items}} ({{total}}).", ctaLabel: "Return to bag", linkTo: "{{recoverUrl}}" },
  { code: "cart.reminder", name: "Abandoned cart reminder (push)", channel: "push", category: "lifecycle", trigger: "cart.abandoned",
    subject: "Your bag is waiting", body: "{{items}} are still in your bag." },
];
