import type { Customer } from "@/generated/prisma/client";

export function toCustomerDto(c: Customer & { twoFactor?: { enabledAt: Date | null } | null }) {
  return {
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    name: `${c.firstName} ${c.lastName}`.trim(),
    email: c.email,
    emailVerified: !!c.emailVerifiedAt,
    phone: c.phone,
    phoneCountry: c.phoneCountry,
    dateOfBirth: c.dateOfBirth ? c.dateOfBirth.toISOString().slice(0, 10) : null,
    gender: c.gender,
    avatarUrl: c.avatarUrl,
    tier: c.tier,
    status: c.status,
    marketingOptIn: c.marketingOptIn,
    hasOnboarded: c.hasOnboarded,
    preferences: c.preferences ?? defaultPreferences,
    referralCode: c.referralCode,
    twoFactorEnabled: !!c.twoFactor?.enabledAt,
    createdAt: c.createdAt,
  };
}

export const defaultPreferences = {
  language: "English",
  currency: "NGN",
  privacy: { analytics: true, personalization: true, marketingCookies: false },
};

/** prisma select for "who is this customer" in other modules' lists */
export const customerBrief = { id: true, firstName: true, lastName: true, email: true } as const;
export const fullName = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`.trim();
