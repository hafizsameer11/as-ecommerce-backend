import { z } from "zod";
import { ModuleRouter, idParam } from "@/core/http/router";
import { addressesController as c } from "./addresses.controller";
import { addressBody, addressPatch, adminAddressPatch, adminAddressQuery } from "./addresses.schemas";

/** /account/addresses, /account/addresses/new, checkout address prefill */
export const addressesStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/me/addresses", tag: "Addresses", defaultAuth: "customer" })
  .get("/", { summary: "My saved addresses (default first)" }, c.list)
  .post("/", { summary: "Add an address", body: addressBody, status: 201 }, c.create)
  .get("/:id", { summary: "One address", params: idParam }, c.get)
  .patch("/:id", { summary: "Edit an address", params: idParam, body: addressPatch }, c.update)
  .post("/:id/default", { summary: "Make default", params: idParam }, c.setDefault)
  .delete("/:id", { summary: "Delete an address", params: idParam }, c.remove);

const audit = (action: string) => ({ category: "customers", action, entity: "address" });

/** asl-admin /addresses */
export const addressesAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/addresses", tag: "Addresses", defaultAuth: "admin", defaultPermission: "customers.edit" })
  .get("/", { summary: "Address book (tabs: shipping / billing / pickup / flagged / unverified)", permission: "customers.view", query: adminAddressQuery }, c.adminList)
  .get("/export", { summary: "Export addresses (CSV)", permission: "customers.view", query: adminAddressQuery }, c.exportCsv)
  .patch("/:id", { summary: "Edit address", params: idParam, body: adminAddressPatch, audit: audit("address.updated") }, c.adminUpdate)
  .post("/:id/verify", { summary: "Mark verified", params: idParam, audit: audit("address.verified") }, c.verify)
  .post("/:id/flag", { summary: "Flag / unflag", params: idParam, body: z.object({ flagged: z.boolean() }), audit: audit("address.flagged") }, c.flag)
  .post("/:id/default", { summary: "Make default for the customer", params: idParam, audit: audit("address.default") }, c.adminDefault)
  .delete("/:id", { summary: "Delete address", params: idParam, audit: audit("address.deleted") }, c.adminRemove);
