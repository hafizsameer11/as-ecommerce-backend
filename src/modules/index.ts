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
import { dropsStoreRoutes, stockAlertsStoreRoutes } from "./catalog/drops/drops.routes";
import { inventoryAdminRoutes, warehousesAdminRoutes } from "./inventory/inventory.routes";
import { addressesAdminRoutes, addressesStoreRoutes } from "./platform/addresses/addresses.routes";
import { cartsStoreRoutes } from "./commerce/carts/carts.routes";
import { wishlistStoreRoutes } from "./commerce/wishlist/wishlist.routes";
import { couponsAdminRoutes, myCouponsStoreRoutes } from "./commerce/coupons/coupons.routes";
import { checkoutStoreRoutes } from "./commerce/checkout/checkout.routes";
import { myOrdersStoreRoutes, ordersAdminRoutes, ordersStoreRoutes } from "./commerce/orders/orders.routes";
import { shippingStoreRoutes, shippingZonesAdminRoutes } from "./fulfilment/shipping-zones/shipping-zones.routes";
import { pickupLocationsAdminRoutes, pickupLocationsStoreRoutes } from "./fulfilment/pickups/pickups.routes";
import { taxAdminRoutes } from "./fulfilment/tax/tax.routes";
import { paymentsAdminRoutes, paymentsStoreRoutes, paymentWebhookRoutes } from "./payments/payments/payments.routes";
import { bankAccountsStoreRoutes, banksStoreRoutes, walletsAdminRoutes, walletStoreRoutes } from "./payments/wallets/wallets.routes";
import { paymentMethodsStoreRoutes } from "./payments/payment-methods/payment-methods.routes";

export const moduleRouters: ModuleRouter[] = [
  // identity
  authStoreRoutes,
  accountStoreRoutes,
  adminAuthRoutes,
  adminMeRoutes,
  teamAdminRoutes,
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
  // inventory
  inventoryAdminRoutes,
  warehousesAdminRoutes,
  // commerce
  addressesStoreRoutes,
  addressesAdminRoutes,
  cartsStoreRoutes,
  wishlistStoreRoutes,
  myCouponsStoreRoutes,
  couponsAdminRoutes,
  checkoutStoreRoutes,
  myOrdersStoreRoutes,
  ordersStoreRoutes,
  ordersAdminRoutes,
  // fulfilment
  shippingStoreRoutes,
  shippingZonesAdminRoutes,
  pickupLocationsStoreRoutes,
  pickupLocationsAdminRoutes,
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
];

/** side-effect imports: event listeners + job processors */
export async function registerListeners() {
  // filled as modules with listeners are added
}
