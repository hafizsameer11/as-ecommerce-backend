import type { Ctx } from "@/core/http/router";
import { ApiError } from "@/core/http/errors";
import { sendCsv } from "@/core/http/response";
import { draftImportService as svc } from "./draft-import.service";
import type { ImportDraftsBody } from "./draft-import.schemas";

export const draftImportController = {
  import: async ({ body, files, admin, res }: Ctx<ImportDraftsBody>) => {
    const file = files[0];
    if (!file) throw ApiError.badRequest("VALIDATION_FAILED", "Attach the CSV file as `file`.", [{ in: "body", path: "file", message: "Required" }]);
    const r = await svc.import(file.buffer.toString("utf8"), admin.name, body.dryRun);
    res.locals.audit = {
      summary: r.created.length
        ? `Imported ${r.created.length} draft order(s) from ${file.originalname}: ${r.created.map((d) => d.number).join(", ")}`
        : `Draft import ${body.dryRun ? "check" : "rejected"} (${file.originalname}): ${r.errors.length} error(s), nothing created`,
    };
    return r;
  },
  template: async ({ res }: Ctx) => sendCsv(res, "draft-orders-template", await svc.template()),
};
