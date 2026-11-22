import { prisma } from "@/core/db/prisma";
import type { NewsletterBody } from "./newsletter.schemas";

export const newsletterService = {
  async subscribe({ email }: NewsletterBody, customerId?: string) {
    if (customerId) {
      await prisma.customer.update({ where: { id: customerId }, data: { marketingOptIn: true } });
      return { subscribed: true, marketingOptIn: true };
    }

    const known = await prisma.customer.findFirst({
      where: { email, deletedAt: null },
      select: { id: true, marketingOptIn: true },
    });
    if (known) {
      if (!known.marketingOptIn) await prisma.customer.update({ where: { id: known.id }, data: { marketingOptIn: true } });
      return { subscribed: true, marketingOptIn: true };
    }

    await prisma.newsletterLead.upsert({
      where: { email },
      create: { email },
      update: {},
    });
    return { subscribed: true, marketingOptIn: false, lead: true };
  },
};