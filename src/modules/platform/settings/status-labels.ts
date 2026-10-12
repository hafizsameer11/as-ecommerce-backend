/**
 * U4: one status set in the database, the wording each screen shows comes from here.
 * The apps render `labels.<entity>.<screen>[status]` instead of hard-coding their own sets.
 */
export const STATUS_LABELS = {
  order: {
    customer: {
      pending_payment: "Awaiting payment",
      paid: "Processing",
      processing: "Processing",
      shipped: "Shipped",
      out_for_delivery: "Shipped",
      delivered: "Delivered",
      cancelled: "Cancelled",
      returned: "Returned",
      refunded: "Returned",
      partially_refunded: "Delivered",
    },
    admin: {
      pending_payment: "Awaiting payment",
      paid: "Unfulfilled",
      processing: "Preparing shipment",
      shipped: "Shipped",
      out_for_delivery: "Out for delivery",
      delivered: "Delivered",
      cancelled: "Cancelled",
      returned: "Returned",
      refunded: "Refunded",
      partially_refunded: "Partially refunded",
    },
  },
  concierge: {
    /** admin inbox / sourcing board */
    admin: {
      new: "New", sourcing: "Sourcing", quoted: "Quoted", approved: "Approved", payment_pending: "Payment Pending",
      ordered: "Ordered", in_transit: "In Transit", delivered: "Delivered", cancelled: "Cancelled", unavailable: "Unavailable",
    },
    /** /account/requests and track-request */
    customer: {
      new: "Sourcing", sourcing: "Sourcing", quoted: "Sourcing", approved: "Order Confirmed", payment_pending: "Order Confirmed",
      ordered: "Order Confirmed", in_transit: "In Transit", delivered: "Completed", cancelled: "Cancelled", unavailable: "Cancelled",
    },
    /** concierge cart items */
    cart: {
      new: "Sourcing in Progress", sourcing: "Sourcing in Progress", quoted: "Payment Pending", approved: "Ready to Purchase",
      payment_pending: "Payment Pending", ordered: "Ordered", in_transit: "In Transit", delivered: "Delivered", cancelled: "Cancelled",
      unavailable: "Unavailable",
    },
  },
  return: {
    /** asl-web /account/returns uses four chips */
    customer: {
      requested: "In Progress", approved: "Approved", in_transit_back: "Approved", received: "Approved",
      under_investigation: "In Progress", refunded: "Completed", rejected: "Rejected",
    },
    admin: {
      requested: "Awaiting review", approved: "Approved", in_transit_back: "In transit back", received: "Received",
      under_investigation: "Under investigation", refunded: "Refunded", rejected: "Rejected",
    },
  },
  /** drop reservations (asl-web reservation panel / admin drops) */
  reservation: {
    customer: { pending_deposit: "Awaiting deposit", reserved: "Reserved", balance_paid: "Balance Paid", cancelled: "Cancelled", expired: "Expired" },
    admin: { pending_deposit: "Awaiting deposit", reserved: "Deposit paid", balance_paid: "Converted to order", cancelled: "Cancelled", expired: "Expired (balance unpaid)" },
  },
  drop: { upcoming: "Coming soon", live: "Live", sold_out: "Sold out", ended: "Ended" },
  tier: { Standard: "Standard", Silver: "Silver", Gold: "Gold", Signature: "Signature" },
} as const;
