import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";
import { patchOf } from "@/core/http/patch-schema";

export const addressBody = z.object({
  label: z.string().trim().min(1).max(40).default("Home"),
  type: z.enum(["shipping", "billing", "pickup"]).default("shipping"),
  recipient: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(30),
  line1: z.string().trim().min(3).max(190),
  line2: z.string().trim().max(190).nullable().optional(),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  country: z.string().trim().min(2).max(56).default("NG"),
  postalCode: z.string().trim().max(20).nullable().optional(),
  isDefault: z.boolean().optional(),
});
export const addressPatch = patchOf(addressBody);

export const adminAddressQuery = pageQuery.extend({
  tab: z.enum(["all", "shipping", "billing", "pickup", "flagged", "unverified"]).default("all"),
  customerId: z.string().optional(),
});
export const adminAddressPatch = addressPatch.extend({ notes: z.string().max(500).nullable().optional() });

export type AddressBody = z.infer<typeof addressBody>;
export type AddressPatch = z.infer<typeof addressPatch>;
export type AdminAddressQuery = z.infer<typeof adminAddressQuery>;
