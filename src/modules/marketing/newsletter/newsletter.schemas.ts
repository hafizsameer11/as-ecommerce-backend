import { z } from "zod";

const email = z.string().trim().toLowerCase().email().max(190);

export const newsletterBody = z.object({ email });
export type NewsletterBody = z.infer<typeof newsletterBody>;