import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { publishPost, mediaUrls } from "../services/posts.js";
import { runAction } from "../services/actions.js";
import { refreshExpiringTokens } from "../services/tokens.js";
import { deleteByUrls, cleanupExpiredUploads } from "../services/media.js";
import { captureAllDaily } from "../services/analytics.js";

let running = false;
let stopped = false;

/**
 * Resolve a chained post's dependency. Returns:
 *  - "ready": dependency published; replyToId has been set on the post.
 *  - "wait":  dependency not done yet; try again next tick.
 *  - "failed": dependency failed/cancelled; this post should be failed too.
 */
async function resolveDependency(post: {
  id: string;
  dependsOnPostId: string | null;
}): Promise<"ready" | "wait" | "failed"> {
  if (!post.dependsOnPostId) return "ready";
  const dep = await prisma.scheduledPost.findUnique({ where: { id: post.dependsOnPostId } });
  if (!dep) return "failed";
  if (dep.status === "PUBLISHED" && dep.publishedId) {
    await prisma.scheduledPost.update({
      where: { id: post.id },
      data: { replyToId: dep.publishedId },
    });
    return "ready";
  }
  if (dep.status === "FAILED" || dep.status === "CANCELLED") return "failed";
  return "wait";
}

/** Process one batch of due posts. */
async function processDuePosts(): Promise<void> {
  const due = await prisma.scheduledPost.findMany({
    where: { status: "PENDING", scheduledAt: { lte: new Date() } },
    orderBy: { scheduledAt: "asc" },
    take: 10,
    include: { account: true },
  });

  for (const post of due) {
    // Chained posts wait on their predecessor before being claimed.
    const dep = await resolveDependency(post);
    if (dep === "wait") continue;
    if (dep === "failed") {
      await prisma.scheduledPost.update({
        where: { id: post.id, status: "PENDING" } as any,
        data: { status: "FAILED", lastError: "Previous post in chain failed" },
      }).catch(() => undefined);
      continue;
    }

    // Atomic claim: only one worker wins this row.
    const claim = await prisma.scheduledPost.updateMany({
      where: { id: post.id, status: "PENDING" },
      data: { status: "PROCESSING", attempts: { increment: 1 } },
    });
    if (claim.count === 0) continue;

    if (post.account.disabled) {
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: { status: "FAILED", lastError: "Account disabled" },
      });
      continue;
    }

    try {
      // Reload to pick up a replyToId set during dependency resolution.
      const fresh = await prisma.scheduledPost.findUnique({ where: { id: post.id } });
      const publishedId = await publishPost(fresh ?? post, post.account);
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: { status: "PUBLISHED", publishedId, lastError: null },
      });
      // Media is now on Threads — remove the temporary local files.
      const urls = mediaUrls(fresh ?? post);
      if (urls.length > 0) await deleteByUrls(urls).catch(() => undefined);
    } catch (err) {
      await handleFailure("scheduledPost", post.id, post.attempts + 1, post.maxAttempts, err);
    }
  }
}

/** Process one batch of due actions (replies). */
async function processDueActions(): Promise<void> {
  const due = await prisma.action.findMany({
    where: { status: "PENDING", scheduledAt: { lte: new Date() } },
    orderBy: { scheduledAt: "asc" },
    take: 10,
    include: { account: true },
  });

  for (const action of due) {
    const claim = await prisma.action.updateMany({
      where: { id: action.id, status: "PENDING" },
      data: { status: "PROCESSING", attempts: { increment: 1 } },
    });
    if (claim.count === 0) continue;

    if (action.account.disabled) {
      await prisma.action.update({
        where: { id: action.id },
        data: { status: "FAILED", lastError: "Account disabled" },
      });
      continue;
    }

    try {
      const resultId = await runAction(action, action.account);
      await prisma.action.update({
        where: { id: action.id },
        data: { status: "PUBLISHED", resultId, lastError: null },
      });
    } catch (err) {
      await handleFailure("action", action.id, action.attempts + 1, action.maxAttempts, err);
    }
  }
}

/** Either reschedule for retry or mark FAILED based on attempt count. */
async function handleFailure(
  kind: "scheduledPost" | "action",
  id: string,
  attempts: number,
  maxAttempts: number,
  err: unknown
): Promise<void> {
  const message = (err as Error).message ?? String(err);
  const exhausted = attempts >= maxAttempts;
  const data = exhausted
    ? { status: "FAILED" as const, lastError: message }
    : { status: "PENDING" as const, lastError: message };

  if (kind === "scheduledPost") {
    await prisma.scheduledPost.update({ where: { id }, data });
  } else {
    await prisma.action.update({ where: { id }, data });
  }
  logger.warn(
    { kind, id, attempts, maxAttempts, exhausted, err: message },
    exhausted ? "Job failed permanently" : "Job failed, will retry"
  );
}

let lastTokenSweep = 0;
const TOKEN_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h

async function maybeRefreshTokens(): Promise<void> {
  const now = Date.now();
  if (now - lastTokenSweep < TOKEN_SWEEP_INTERVAL_MS) return;
  lastTokenSweep = now;
  try {
    const n = await refreshExpiringTokens();
    if (n > 0) logger.info({ refreshed: n }, "Token refresh sweep complete");
  } catch (err) {
    logger.error({ err: (err as Error).message }, "Token refresh sweep failed");
  }
}

let lastUploadSweep = 0;
const UPLOAD_SWEEP_INTERVAL_MS = 30 * 60 * 1000; // every 30 min

async function maybeCleanupUploads(): Promise<void> {
  const now = Date.now();
  if (now - lastUploadSweep < UPLOAD_SWEEP_INTERVAL_MS) return;
  lastUploadSweep = now;
  try {
    await cleanupExpiredUploads();
  } catch (err) {
    logger.error({ err: (err as Error).message }, "Upload cleanup sweep failed");
  }
}

let lastAnalyticsSweep = 0;
const ANALYTICS_SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000; // every 12h

async function maybeCaptureAnalytics(): Promise<void> {
  const now = Date.now();
  if (now - lastAnalyticsSweep < ANALYTICS_SWEEP_INTERVAL_MS) return;
  lastAnalyticsSweep = now;
  try {
    const n = await captureAllDaily();
    if (n > 0) logger.info({ accounts: n }, "Analytics snapshot sweep complete");
  } catch (err) {
    logger.error({ err: (err as Error).message }, "Analytics sweep failed");
  }
}

async function tick(): Promise<void> {
  if (running) return; // avoid overlapping ticks
  running = true;
  try {
    await maybeRefreshTokens();
    await maybeCleanupUploads();
    await maybeCaptureAnalytics();
    await processDuePosts();
    await processDueActions();
  } catch (err) {
    logger.error({ err: (err as Error).message }, "Scheduler tick error");
  } finally {
    running = false;
  }
}

export function startScheduler(): void {
  const intervalMs = config.SCHEDULER_POLL_SECONDS * 1000;
  logger.info(`Scheduler started (poll every ${config.SCHEDULER_POLL_SECONDS}s)`);
  // Run an immediate token sweep on boot.
  lastTokenSweep = 0;

  const loop = async () => {
    if (stopped) return;
    await tick();
    if (!stopped) setTimeout(loop, intervalMs);
  };
  loop();
}

export function stopScheduler(): void {
  stopped = true;
}
