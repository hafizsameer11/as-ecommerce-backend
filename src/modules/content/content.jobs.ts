import { defineJob } from "@/core/queue/queue";
import { logger } from "@/core/utils/logger";
import { pagesService } from "./pages/pages.service";
import { blogService } from "./blog/blog.service";

/** scheduled pages + blog posts whose time has come → published */
export async function publishScheduledContent(now = new Date()) {
  const pages = await pagesService.publishDue(now);
  const posts = await blogService.publishDue(now);
  if (pages || posts) logger.info({ pages, posts }, "scheduled content published");
  return { pages, posts };
}

export const publishScheduledJob = defineJob("content.publish-scheduled", async () => {
  await publishScheduledContent();
});

/** imported from registerListeners() so the job processor is registered in the worker */
export function registerContentJobs() {
  return publishScheduledJob;
}
