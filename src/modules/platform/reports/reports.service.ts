/**
 * Report library (SavedReport) + runs (ReportRun).
 *
 * POST /:id/run → ReportRun "queued" → job `reports.run` builds the file (generator → renderer) →
 * private storage → "ready" (or "failed" with the error). Scheduled reports (`reports.scheduled`, every
 * 15 min) run every format of each due report and email the files to its recipients (template report.ready).
 * Finance generators (VAT, wallet liabilities, inventory valuation) need finance.view everywhere.
 */
import type { Prisma, ReportRun, SavedReport } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { defineJob } from "@/core/queue/queue";
import { toCsv } from "@/core/utils/csv";
import { logger } from "@/core/utils/logger";
import { slugify } from "@/core/utils/slug";
import type { Permission } from "@/core/auth/permissions";
import { messaging } from "@/modules/marketing/messaging/messaging.service";
import { dayKey } from "@/modules/platform/analytics/analytics.dates";
import { GENERATORS, generatorList, resolveSpan } from "./reports.generators";
import { CONTENT_TYPES, renderReport } from "./reports.render";
import { reportStorage } from "./reports.storage";
import type { GeneratorKey, ReportBody, ReportFormat, ReportListQuery, ReportParams, ReportPatch, RunListQuery, Schedule, ScheduleBody } from "./reports.schemas";

type Actor = { id: string; email: string; permissions: Set<Permission> };

const FINANCE_KEYS = Object.values(GENERATORS).filter((g) => g.finance).map((g) => g.key as string);
const canFinance = (a: { permissions: Set<Permission> }) => a.permissions.has("finance.view");
/** library rows the caller may see */
const visible = (a: { permissions: Set<Permission> }): Prisma.SavedReportWhereInput => (canFinance(a) ? {} : { generator: { notIn: FINANCE_KEYS } });
function assertAllowed(generator: string, a: { permissions: Set<Permission> }) {
  if (GENERATORS[generator as GeneratorKey]?.finance && !canFinance(a)) throw ApiError.forbidden("Finance reports need the finance.view permission.");
}

// ── schedule: next 07:00 Lagos (daily) / Monday 07:00 (weekly) / 1st of the month 07:00 (monthly) ──
const RUN_HOUR = 7;
export function nextRunAt(schedule: Schedule, after = new Date()): Date | null {
  if (schedule === "off") return null;
  const lagos = new Date(after.getTime() + 3_600_000); // Lagos wall clock in UTC fields
  const c = new Date(Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate(), RUN_HOUR));
  const ok = (d: Date) => d > lagos && (schedule === "daily" || (schedule === "weekly" ? d.getUTCDay() === 1 : d.getUTCDate() === 1));
  for (let i = 0; i < 40 && !ok(c); i++) c.setUTCDate(c.getUTCDate() + 1);
  return new Date(c.getTime() - 3_600_000);
}

const ext = (f: string) => (f === "xlsx" ? "xlsx" : f === "pdf" ? "pdf" : "csv");
const fileName = (r: Pick<SavedReport, "name">, run: Pick<ReportRun, "format" | "startedAt">) => `${slugify(r.name) || "report"}-${dayKey(run.startedAt)}.${ext(run.format)}`;

function toRun(r: ReportRun & { report?: Pick<SavedReport, "name" | "category" | "generator"> }) {
  return {
    id: r.id, reportId: r.reportId, reportName: r.report?.name ?? null, category: r.report?.category ?? null, generator: r.report?.generator ?? null,
    status: r.status, format: r.format, rows: r.rows, sizeBytes: r.sizeBytes, sizeKB: r.sizeBytes == null ? null : Math.max(1, Math.round(r.sizeBytes / 1024)),
    error: r.error, requestedBy: r.requestedBy, startedAt: r.startedAt, finishedAt: r.finishedAt,
    downloadUrl: r.status === "ready" ? `/api/v1/admin/reports/runs/${r.id}/download` : null,
  };
}

function toReport(r: SavedReport & { runs?: ReportRun[] }) {
  const g = GENERATORS[r.generator as GeneratorKey];
  const last = r.runs?.[0];
  return {
    id: r.id, name: r.name, description: r.description, category: r.category, generator: r.generator, generatorLabel: g?.label ?? r.generator,
    finance: g?.finance ?? false, params: (r.params ?? {}) as ReportParams, owner: r.owner, favorite: r.favorite, schedule: r.schedule,
    formats: r.formats as ReportFormat[], recipients: r.recipients as string[], nextRunAt: r.nextRunAt, createdAt: r.createdAt, updatedAt: r.updatedAt,
    lastRunAt: last?.startedAt ?? null, lastStatus: last?.status ?? null, rowsLastRun: last?.rows ?? null, lastRun: last ? toRun(last) : null,
  };
}

/** starter library for a fresh install (only when the table is empty) */
const DEFAULT_LIBRARY: { name: string; description: string; generator: GeneratorKey; params?: ReportParams; formats: ReportFormat[]; favorite?: boolean }[] = [
  { name: "Daily sales snapshot", description: "Gross, refunds, net, orders and AOV segmented by channel.", generator: "sales_summary", params: { range: "yesterday" }, formats: ["csv", "xlsx"], favorite: true },
  { name: "Sales · last 30 days", description: "Daily sales by channel over the last 30 days.", generator: "sales_summary", params: { range: "30d" }, formats: ["xlsx"] },
  { name: "VAT collected · monthly", description: "VAT included in prices and VAT added, per paid order, for filing.", generator: "vat_report", params: { range: "last_month" }, formats: ["xlsx", "pdf"], favorite: true },
  { name: "Wallet liabilities", description: "Money customers hold in their ASL Wallet (owed by the business).", generator: "wallet_liabilities", formats: ["xlsx"] },
  { name: "Inventory valuation", description: "Stock on hand at cost and at retail per SKU and warehouse.", generator: "inventory_valuation", formats: ["xlsx", "csv"] },
  { name: "Concierge pipeline", description: "Requests, status, quotes and payments for the last 30 days.", generator: "concierge_pipeline", params: { range: "30d" }, formats: ["csv"] },
  { name: "Customer list", description: "Customers with tier, orders, lifetime spend and marketing consent.", generator: "customer_list", formats: ["csv"] },
  { name: "Orders export · 30 days", description: "Every order placed in the last 30 days.", generator: "orders_export", params: { range: "30d" }, formats: ["csv", "xlsx"] },
];
let seeding: Promise<void> | null = null;
async function ensureLibrary() {
  if (await prisma.savedReport.count()) return;
  seeding ??= (async () => {
    if (await prisma.savedReport.count()) return;
    await prisma.savedReport.createMany({
      data: DEFAULT_LIBRARY.map((d) => ({
        name: d.name, description: d.description, generator: d.generator, category: GENERATORS[d.generator].category, params: d.params ?? {},
        owner: "system", favorite: d.favorite ?? false, schedule: "off", formats: d.formats, recipients: [],
      })),
    });
  })().finally(() => (seeding = null));
  await seeding;
}

async function load(id: string, a: Actor) {
  const r = await prisma.savedReport.findUnique({ where: { id }, include: { runs: { orderBy: { startedAt: "desc" }, take: 1 } } });
  if (!r) throw ApiError.notFound("Report");
  assertAllowed(r.generator, a);
  return r;
}

export const reportsService = {
  generators: (a: Actor) => generatorList().map((g) => ({ ...g, allowed: !g.finance || canFinance(a) })),

  async list(q: ReportListQuery, a: Actor) {
    await ensureLibrary();
    const base: Prisma.SavedReportWhereInput = {
      ...visible(a),
      ...(q.category !== "all" ? { category: q.category } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q } }, { description: { contains: q.q } }, { owner: { contains: q.q } }] } : {}),
    };
    const where: Prisma.SavedReportWhereInput = {
      ...base,
      ...(q.tab === "scheduled" ? { schedule: { not: "off" } } : q.tab === "favorites" ? { favorite: true } : {}),
    };
    const dayAgo = new Date(Date.now() - 86_400_000);
    const runWhere: Prisma.ReportRunWhereInput = { report: visible(a) };
    const [rows, total, library, scheduled, favorites, runs, runsToday, failed, next] = await Promise.all([
      prisma.savedReport.findMany({
        where, ...paging(q), orderBy: [{ favorite: "desc" }, { name: "asc" }],
        include: { runs: { orderBy: { startedAt: "desc" }, take: 1 } },
      }),
      prisma.savedReport.count({ where }),
      prisma.savedReport.count({ where: base }),
      prisma.savedReport.count({ where: { ...base, schedule: { not: "off" } } }),
      prisma.savedReport.count({ where: { ...base, favorite: true } }),
      prisma.reportRun.count({ where: runWhere }),
      prisma.reportRun.count({ where: { ...runWhere, startedAt: { gte: dayAgo } } }),
      prisma.reportRun.count({ where: { ...runWhere, status: "failed", startedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } }),
      prisma.savedReport.findFirst({ where: { ...visible(a), schedule: { not: "off" }, nextRunAt: { not: null } }, orderBy: { nextRunAt: "asc" }, select: { id: true, name: true, nextRunAt: true } }),
    ]);
    return withMeta(rows.map(toReport), {
      ...pageMeta(q, total),
      tabs: { library, scheduled, favorites, runs },
      kpis: { library, scheduled, runsToday, failed, nextRun: next },
    });
  },

  async get(id: string, a: Actor) {
    return toReport(await load(id, a));
  },

  async create(b: ReportBody, a: Actor) {
    assertAllowed(b.generator, a);
    const r = await prisma.savedReport.create({
      data: {
        name: b.name, description: b.description, generator: b.generator, category: b.category ?? GENERATORS[b.generator].category, params: b.params,
        owner: a.email, favorite: b.favorite, schedule: b.schedule, formats: b.formats, recipients: b.recipients, nextRunAt: nextRunAt(b.schedule),
      },
    });
    return toReport(r);
  },

  async update(id: string, b: ReportPatch, a: Actor) {
    const before = await load(id, a);
    if (b.generator) assertAllowed(b.generator, a);
    const schedule = b.schedule ?? (before.schedule as Schedule);
    const r = await prisma.savedReport.update({
      where: { id },
      data: {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.description !== undefined ? { description: b.description } : {}),
        ...(b.generator !== undefined ? { generator: b.generator, ...(b.category === undefined ? { category: GENERATORS[b.generator].category } : {}) } : {}),
        ...(b.category !== undefined ? { category: b.category } : {}),
        ...(b.params !== undefined ? { params: b.params } : {}),
        ...(b.favorite !== undefined ? { favorite: b.favorite } : {}),
        ...(b.formats !== undefined ? { formats: b.formats } : {}),
        ...(b.recipients !== undefined ? { recipients: b.recipients } : {}),
        ...(b.schedule !== undefined && b.schedule !== before.schedule ? { schedule, nextRunAt: nextRunAt(schedule) } : {}),
      },
      include: { runs: { orderBy: { startedAt: "desc" }, take: 1 } },
    });
    return { before: toReport(before), after: toReport(r) };
  },

  async remove(id: string, a: Actor) {
    const r = await load(id, a);
    const runs = await prisma.reportRun.findMany({ where: { reportId: id, fileKey: { not: null } }, select: { fileKey: true } });
    await prisma.savedReport.delete({ where: { id } });
    await Promise.all(runs.map((x) => reportStorage.delete(x.fileKey!).catch(() => undefined)));
    return { deleted: true, name: r.name };
  },

  async toggleFavorite(id: string, a: Actor) {
    const r = await load(id, a);
    await prisma.savedReport.update({ where: { id }, data: { favorite: !r.favorite } });
    return this.get(id, a);
  },

  async setSchedule(id: string, b: ScheduleBody, a: Actor) {
    const r = await load(id, a);
    const recipients = b.recipients ?? (r.recipients as string[]);
    if (b.schedule !== "off" && !recipients.length) throw ApiError.badRequest("VALIDATION_FAILED", "Add at least one recipient for a scheduled report.");
    await prisma.savedReport.update({
      where: { id },
      data: { schedule: b.schedule, recipients, ...(b.formats ? { formats: b.formats } : {}), nextRunAt: nextRunAt(b.schedule) },
    });
    return this.get(id, a);
  },

  /** queue a run; the `reports.run` job builds the file */
  async run(id: string, format: ReportFormat, a: Actor) {
    await load(id, a);
    const run = await prisma.reportRun.create({ data: { reportId: id, format, requestedBy: a.email, status: "queued" } });
    await reportRunJob({ runId: run.id });
    return toRun(run);
  },

  async runs(q: RunListQuery, a: Actor) {
    const where: Prisma.ReportRunWhereInput = {
      report: visible(a),
      ...(q.reportId ? { reportId: q.reportId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { OR: [{ report: { name: { contains: q.q } } }, { requestedBy: { contains: q.q } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.reportRun.findMany({ where, ...paging(q), orderBy: { startedAt: "desc" }, include: { report: { select: { name: true, category: true, generator: true } } } }),
      prisma.reportRun.count({ where }),
    ]);
    return withMeta(rows.map(toRun), pageMeta(q, total));
  },

  async exportRuns(q: RunListQuery, a: Actor) {
    const rows = await prisma.reportRun.findMany({
      where: { report: visible(a), ...(q.reportId ? { reportId: q.reportId } : {}), ...(q.status ? { status: q.status } : {}) },
      orderBy: { startedAt: "desc" }, take: 10_000, include: { report: { select: { name: true, category: true, generator: true } } },
    });
    return toCsv(
      rows.map((r) => ({ ...toRun(r), startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? "" })),
      ["id", "reportName", "category", "status", "format", "rows", "sizeKB", "requestedBy", "startedAt", "finishedAt", "error"],
      ["Run", "Report", "Category", "Status", "Format", "Rows", "Size (KB)", "Requested by", "Started", "Finished", "Error"],
    );
  },

  async getRun(runId: string, a: Actor) {
    const r = await prisma.reportRun.findUnique({ where: { id: runId }, include: { report: { select: { name: true, category: true, generator: true } } } });
    if (!r) throw ApiError.notFound("Report run");
    assertAllowed(r.report.generator, a);
    return toRun(r);
  },

  async download(runId: string, a: Actor) {
    const r = await prisma.reportRun.findUnique({ where: { id: runId }, include: { report: { select: { name: true, generator: true } } } });
    if (!r) throw ApiError.notFound("Report run");
    assertAllowed(r.report.generator, a);
    if (r.status !== "ready" || !r.fileKey) throw ApiError.conflict("INVALID_STATE", r.status === "failed" ? "This run failed — run the report again." : "The file is not ready yet.");
    const buffer = await reportStorage.read(r.fileKey).catch(() => {
      throw ApiError.notFound("Report file");
    });
    return { buffer, filename: fileName(r.report, r), contentType: CONTENT_TYPES[r.format as ReportFormat] ?? "application/octet-stream" };
  },

  /** build one run's file (job body; also used by the scheduler). Never throws: failures are stored on the run. */
  async execute(runId: string) {
    const claimed = await prisma.reportRun.updateMany({ where: { id: runId, status: "queued" }, data: { status: "running", startedAt: new Date() } });
    if (!claimed.count) return null;
    const run = await prisma.reportRun.findUniqueOrThrow({ where: { id: runId }, include: { report: true } });
    try {
      const g = GENERATORS[run.report.generator as GeneratorKey];
      if (!g) throw new Error(`Unknown report generator "${run.report.generator}"`);
      const data = await g.build((run.report.params ?? {}) as ReportParams);
      const buffer = await renderReport(data, run.format as ReportFormat);
      const d = new Date();
      const key = `reports/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${run.id}.${ext(run.format)}`;
      await reportStorage.put(key, buffer, CONTENT_TYPES[run.format as ReportFormat]);
      await prisma.reportRun.update({ where: { id: runId }, data: { status: "ready", rows: data.rows.length, sizeBytes: buffer.length, fileKey: key, finishedAt: new Date() } });
      return { buffer, filename: fileName(run.report, run), contentType: CONTENT_TYPES[run.format as ReportFormat], rows: data.rows.length, period: data.period };
    } catch (err) {
      logger.error({ err, runId }, "report run failed");
      await prisma.reportRun.update({ where: { id: runId }, data: { status: "failed", error: String((err as Error)?.message ?? err).slice(0, 2000), finishedAt: new Date() } });
      return null;
    }
  },

  /** due scheduled reports: run every format, email the files, move nextRunAt forward */
  async runScheduled(now = new Date()) {
    const due = await prisma.savedReport.findMany({ where: { schedule: { not: "off" }, nextRunAt: { lte: now } }, take: 50 });
    let sent = 0;
    for (const r of due) {
      // claim: only one worker moves nextRunAt forward
      const claimed = await prisma.savedReport.updateMany({ where: { id: r.id, nextRunAt: r.nextRunAt }, data: { nextRunAt: nextRunAt(r.schedule as Schedule, now) } });
      if (!claimed.count) continue;
      const files = [];
      for (const format of r.formats as ReportFormat[]) {
        const run = await prisma.reportRun.create({ data: { reportId: r.id, format, requestedBy: "scheduler", status: "queued" } });
        const f = await this.execute(run.id);
        if (f) files.push(f);
      }
      const recipients = r.recipients as string[];
      if (!files.length || !recipients.length) continue;
      const g = GENERATORS[r.generator as GeneratorKey];
      const period = files[0].period ?? resolveSpan((r.params ?? {}) as ReportParams, g?.defaultRange ?? "30d", now).label;
      for (const to of recipients) {
        await messaging.email(to, "report.ready", {
          reportName: r.name, period, schedule: r.schedule, files: files.map((f) => f.filename).join(", "), rows: files[0].rows, generatedAt: now.toISOString().slice(0, 16).replace("T", " "),
        }, files.map((f) => ({ filename: f.filename, content: f.buffer, contentType: f.contentType })));
        sent++;
      }
    }
    if (due.length) logger.info({ due: due.length, sent }, "reports.scheduled");
    return { due: due.length, sent };
  },
};

export const reportRunJob = defineJob("reports.run", async ({ runId }: { runId: string }) => {
  await reportsService.execute(runId);
});
export const reportsScheduledJob = defineJob("reports.scheduled", async () => {
  await reportsService.runScheduled();
});

/** imported from registerListeners() so the job processors are registered in the worker */
export function registerReportJobs() {
  return [reportRunJob, reportsScheduledJob];
}
