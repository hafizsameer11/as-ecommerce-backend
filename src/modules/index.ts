/**
 * Every module router is registered here. Adding a module = one line.
 */
import type { ModuleRouter } from "@/core/http/router";
import { authStoreRoutes } from "./identity/auth/auth.routes";
import { accountStoreRoutes } from "./identity/account/account.routes";
import { adminAuthRoutes, adminMeRoutes } from "./identity/admin-auth/admin-auth.routes";
import { teamAdminRoutes } from "./identity/team/team.routes";
import { settingsAdminRoutes, settingsStoreRoutes } from "./platform/settings/settings.routes";
import { auditAdminRoutes } from "./platform/audit/audit.routes";
import { productsAdminRoutes, productsStoreRoutes } from "./catalog/products/products.routes";
import { categoriesAdminRoutes, categoriesStoreRoutes } from "./catalog/categories/categories.routes";
import { brandsAdminRoutes, brandsStoreRoutes, conciergeBrandsStoreRoutes } from "./catalog/brands/brands.routes";
import { collectionsAdminRoutes, collectionsStoreRoutes } from "./catalog/collections/collections.routes";
import { sizeGuidesAdminRoutes, sizeGuidesStoreRoutes } from "./catalog/size-guides/size-guides.routes";
import { reviewsAdminRoutes, reviewsStoreRoutes } from "./catalog/reviews/reviews.routes";
import { searchStoreRoutes } from "./catalog/search/search.routes";
import { homeStoreRoutes } from "./catalog/search/home.routes";
import { dropsAdminRoutes, dropsStoreRoutes, myReservationsStoreRoutes, stockAlertsStoreRoutes } from "./catalog/drops/drops.routes";
import { inventoryAdminRoutes, warehousesAdminRoutes } from "./inventory/inventory.routes";
import { addressesAdminRoutes, addressesStoreRoutes } from "./platform/addresses/addresses.routes";
import { cartsStoreRoutes } from "./commerce/carts/carts.routes";
import { abandonedCartsAdminRoutes } from "./commerce/carts/abandoned-carts.routes";
import { customersAdminRoutes } from "./identity/customers/customers.routes";
import { wishlistStoreRoutes } from "./commerce/wishlist/wishlist.routes";
import { couponsAdminRoutes, myCouponsStoreRoutes } from "./commerce/coupons/coupons.routes";
import { checkoutStoreRoutes } from "./commerce/checkout/checkout.routes";
import { myOrdersStoreRoutes, ordersAdminRoutes, ordersStoreRoutes } from "./commerce/orders/orders.routes";
import { myOrderDocumentsStoreRoutes, orderDocumentsAdminRoutes, orderDocumentsStoreRoutes } from "./commerce/documents/documents.routes";
import { draftOrdersAdminRoutes, draftPayStoreRoutes } from "./commerce/draft-orders/draft-orders.routes";
import { myReturnsStoreRoutes, returnableStoreRoutes, returnsAdminRoutes } from "./commerce/returns/returns.routes";
import { registerReturnListeners } from "./commerce/returns/returns.listeners";
import { shippingStoreRoutes, shippingZonesAdminRoutes } from "./fulfilment/shipping-zones/shipping-zones.routes";
import { pickupBookingsAdminRoutes, pickupLocationsAdminRoutes, pickupLocationsStoreRoutes } from "./fulfilment/pickups/pickups.routes";
import { myTrackingStoreRoutes, orderFulfilAdminRoutes, shipmentsAdminRoutes, tokenTrackingStoreRoutes } from "./fulfilment/shipments/shipments.routes";
import { registerPickupListeners } from "./fulfilment/pickups/pickups.listeners";
import { registerShipmentListeners } from "./fulfilment/shipments/shipments.listeners";
import { registerOrderListeners } from "./commerce/orders/orders.listeners";
import { taxAdminRoutes } from "./fulfilment/tax/tax.routes";
import { paymentsAdminRoutes, paymentsStoreRoutes, paymentWebhookRoutes } from "./payments/payments/payments.routes";
import { bankAccountsStoreRoutes, banksStoreRoutes, walletsAdminRoutes, walletStoreRoutes } from "./payments/wallets/wallets.routes";
import { paymentMethodsStoreRoutes } from "./payments/payment-methods/payment-methods.routes";
import { ledgerAdminRoutes } from "./payments/ledger/ledger.routes";
import { registerLedgerListeners } from "./payments/ledger/ledger.listeners";
import { payoutsAdminRoutes } from "./payments/payouts/payouts.routes";
import { conciergeRequestsAdminRoutes, conciergeRequestsStoreRoutes } from "./concierge/requests/requests.routes";
import { conciergeQuotesAdminRoutes, conciergeQuotesStoreRoutes } from "./concierge/quotes/quotes.routes";
import { conciergeChatAdminRoutes, conciergeChatStoreRoutes } from "./concierge/chat/chat.routes";
import { suppliersAdminRoutes } from "./concierge/suppliers/suppliers.routes";
import { registerConciergeListeners } from "./concierge/requests/requests.listeners";
import { clubAdminRoutes, clubStoreRoutes } from "./loyalty/club/club.routes";
import { registerClubListeners } from "./loyalty/club/club.listeners";
import { myReferralsStoreRoutes, referralsAdminRoutes, referralsStoreRoutes } from "./loyalty/referrals/referrals.routes";
import { registerReferralListeners } from "./loyalty/referrals/referrals.listeners";
import { myTicketsStoreRoutes, supportStoreRoutes, ticketsAdminRoutes } from "./support/tickets/tickets.routes";
import { registerTicketListeners } from "./support/tickets/tickets.listeners";
import { feedbackAdminRoutes, feedbackStoreRoutes } from "./support/feedback/feedback.routes";
import { myNotificationPreferencesStoreRoutes, myNotificationsStoreRoutes } from "./support/notifications/notifications.routes";
import { registerNotificationListeners } from "./support/notifications/notifications.listeners";
import { adminNotificationsRoutes, notificationSettingsAdminRoutes } from "./platform/notification-settings/notification-settings.routes";
import { registerStaffAlertListeners } from "./platform/notification-settings/notification-settings.listeners";
import { messagingAdminRoutes, pushOpensStoreRoutes } from "./marketing/messaging/messaging.routes";
import { segmentsAdminRoutes } from "./marketing/segments/segments.routes";
import { campaignsAdminRoutes, campaignTrackingRoutes, unsubscribeRoutes } from "./marketing/campaigns/campaigns.routes";

export const moduleRouters: ModuleRouter[] = [
  // identity
  authStoreRoutes,
  accountStoreRoutes,
  adminAuthRoutes,
  adminMeRoutes,
  teamAdminRoutes,
  customersAdminRoutes,
  // platform
  settingsStoreRoutes,
  settingsAdminRoutes,
  auditAdminRoutes,
  // catalog (order matters: specific paths before /products/:id)
  homeStoreRoutes,
  stockAlertsStoreRoutes,
  reviewsStoreRoutes,
  reviewsAdminRoutes,
  productsStoreRoutes,
  productsAdminRoutes,
  categoriesStoreRoutes,
  categoriesAdminRoutes,
  conciergeBrandsStoreRoutes,
  brandsStoreRoutes,
  brandsAdminRoutes,
  collectionsStoreRoutes,
  collectionsAdminRoutes,
  sizeGuidesStoreRoutes,
  sizeGuidesAdminRoutes,
  searchStoreRoutes,
  dropsStoreRoutes,
  myReservationsStoreRoutes,
  dropsAdminRoutes,
  // inventory
  inventoryAdminRoutes,
  warehousesAdminRoutes,
  // commerce
  addressesStoreRoutes,
  addressesAdminRoutes,
  cartsStoreRoutes,
  abandonedCartsAdminRoutes,
  wishlistStoreRoutes,
  myCouponsStoreRoutes,
  couponsAdminRoutes,
  checkoutStoreRoutes,
  myOrderDocumentsStoreRoutes, // before the order routers: /orders/:id/invoice.pdf, /orders/print-slips
  orderDocumentsStoreRoutes,
  orderDocumentsAdminRoutes,
  myOrdersStoreRoutes,
  ordersStoreRoutes,
  ordersAdminRoutes,
  draftOrdersAdminRoutes,
  draftPayStoreRoutes,
  returnableStoreRoutes,
  myReturnsStoreRoutes,
  returnsAdminRoutes,
  // fulfilment
  shippingStoreRoutes,
  shippingZonesAdminRoutes,
  pickupLocationsStoreRoutes,
  pickupLocationsAdminRoutes,
  pickupBookingsAdminRoutes,
  orderFulfilAdminRoutes,
  shipmentsAdminRoutes,
  myTrackingStoreRoutes,
  tokenTrackingStoreRoutes,
  taxAdminRoutes,
  // payments
  paymentsStoreRoutes,
  paymentWebhookRoutes,
  paymentsAdminRoutes,
  walletStoreRoutes,
  bankAccountsStoreRoutes,
  banksStoreRoutes,
  walletsAdminRoutes,
  paymentMethodsStoreRoutes,
  ledgerAdminRoutes,
  payoutsAdminRoutes,
  // concierge (store: /concierge/brands is registered with the catalogue above)
  conciergeRequestsStoreRoutes,
  conciergeQuotesStoreRoutes,
  conciergeChatStoreRoutes,
  conciergeRequestsAdminRoutes,
  conciergeQuotesAdminRoutes,
  conciergeChatAdminRoutes,
  suppliersAdminRoutes,
  // loyalty
  clubStoreRoutes,
  clubAdminRoutes,
  myReferralsStoreRoutes,
  referralsStoreRoutes,
  referralsAdminRoutes,
  // support + notifications
  supportStoreRoutes,
  myTicketsStoreRoutes,
  ticketsAdminRoutes,
  feedbackStoreRoutes,
  feedbackAdminRoutes,
  myNotificationsStoreRoutes,
  myNotificationPreferencesStoreRoutes,
  notificationSettingsAdminRoutes,
  adminNotificationsRoutes,
  // marketing: messaging templates + push blasts, segments, campaigns (+ public tracking / unsubscribe)
  messagingAdminRoutes,
  pushOpensStoreRoutes,
  segmentsAdminRoutes,
  campaignsAdminRoutes,
  campaignTrackingRoutes,
  unsubscribeRoutes,
];

/** side-effect imports: event listeners + job processors */
export async function registerListeners() {
  // filled as modules with listeners are added
  registerReturnListeners();
  registerOrderListeners(); registerPickupListeners(); registerShipmentListeners();
  registerLedgerListeners();
  registerConciergeListeners();
  registerClubListeners(); registerReferralListeners();
  registerTicketListeners(); registerNotificationListeners(); registerStaffAlertListeners();
}
