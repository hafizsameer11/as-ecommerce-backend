import { z } from "zod";

/** multipart: `file` (CSV) + optional `dryRun=true` to validate without creating */
export const importDraftsBody = z.object({
  dryRun: z.preprocess((v) => v === true || v === "true" || v === "1", z.boolean()).default(false),
});
export type ImportDraftsBody = z.infer<typeof importDraftsBody>;
