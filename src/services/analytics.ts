import { Account } from "@prisma/client";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { getAccessToken } from "./tokens.js";
import {
  getUserInsights,
  getUserThreads,
  getMediaInsights,
  InsightMetric,
} from "../threads/client.js";

const ENGAGEMENT = ["views", "likes", "replies", "reposts", "quotes"];

function total(m: InsightMetric): number {
  if (m.total_value) return m.total_value.value ?? 0;
  if (m.values?.length) return m.values.reduce((s, v) => s + (v.value ?? 0), 0);
  return 0;
}

function byName(metrics: InsightMetric[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of metrics) out[m.name] = total(m);
  return out;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Capture today's account-level snapshot (followers + daily engagement). */
export async function captureSnapshot(account: Account): Promise<void> {
  const token = getAccessToken(account);
  const until = Math.floor(Date.now() / 1000);
  const since = until - 86_400;

  let followers: number | null = null;
  let eng: Record<string, number> = {};

  try {
    const [fc] = await getUserInsights({
      userId: account.threadsUserId,
      accessToken: token,
      metrics: ["followers_count"],
    });
    if (fc) followers = total(fc);
  } catch (err) {
    logger.debug({ accountId: account.id, err: (err as Error).message }, "followers snapshot failed");
  }

  try {
    const metrics = await getUserInsights({
      userId: account.threadsUserId,
      accessToken: token,
      metrics: ENGAGEMENT,
      since,
      until,
    });
    eng = byName(metrics);
  } catch (err) {
    logger.debug({ accountId: account.id, err: (err as Error).message }, "engagement snapshot failed");
  }

  const day = startOfToday();
  await prisma.metricSnapshot.upsert({
    where: { accountId_day: { accountId: account.id, day } },
    create: {
      accountId: account.id,
      day,
      followers,
      views: eng.views ?? null,
      likes: eng.likes ?? null,
      replies: eng.replies ?? null,
      reposts: eng.reposts ?? null,
      quotes: eng.quotes ?? null,
    },
    update: {
      followers,
      views: eng.views ?? null,
      likes: eng.likes ?? null,
      replies: eng.replies ?? null,
      reposts: eng.reposts ?? null,
      quotes: eng.quotes ?? null,
      capturedAt: new Date(),
    },
  });
}

/** Capture per-post insights for an account's recent posts. */
export async function capturePostInsights(account: Account): Promise<void> {
  const token = getAccessToken(account);
  let threads;
  try {
    threads = await getUserThreads({
      userId: account.threadsUserId,
      accessToken: token,
      limit: 25,
      fields: "id,permalink,timestamp,media_type",
    });
  } catch (err) {
    logger.debug({ accountId: account.id, err: (err as Error).message }, "threads list failed");
    return;
  }

  for (const t of threads.data ?? []) {
    try {
      const metrics = byName(await getMediaInsights({ mediaId: t.id, accessToken: token }));
      await prisma.postInsight.upsert({
        where: { mediaId: t.id },
        create: {
          accountId: account.id,
          mediaId: t.id,
          permalink: t.permalink ?? null,
          postedAt: t.timestamp ? new Date(t.timestamp) : null,
          views: metrics.views ?? null,
          likes: metrics.likes ?? null,
          replies: metrics.replies ?? null,
          reposts: metrics.reposts ?? null,
          quotes: metrics.quotes ?? null,
          shares: metrics.shares ?? null,
        },
        update: {
          permalink: t.permalink ?? null,
          views: metrics.views ?? null,
          likes: metrics.likes ?? null,
          replies: metrics.replies ?? null,
          reposts: metrics.reposts ?? null,
          quotes: metrics.quotes ?? null,
          shares: metrics.shares ?? null,
          capturedAt: new Date(),
        },
      });
    } catch (err) {
      logger.debug({ mediaId: t.id, err: (err as Error).message }, "post insight failed");
    }
  }
}

/** Capture snapshots + post insights for all active accounts. */
export async function captureAllDaily(): Promise<number> {
  const accounts = await prisma.account.findMany({ where: { disabled: false } });
  for (const account of accounts) {
    await captureSnapshot(account);
    await capturePostInsights(account);
  }
  return accounts.length;
}

// ---- Read models for the analytics dashboard ----

export async function getAnalytics(accountId: string, days = 30) {
  const from = new Date();
  from.setDate(from.getDate() - days);
  from.setHours(0, 0, 0, 0);

  const snapshots = await prisma.metricSnapshot.findMany({
    where: { accountId, day: { gte: from } },
    orderBy: { day: "asc" },
  });

  const series = snapshots.map((s) => ({
    day: s.day.toISOString().slice(0, 10),
    followers: s.followers,
    views: s.views,
    likes: s.likes,
    replies: s.replies,
    reposts: s.reposts,
    quotes: s.quotes,
  }));

  const followerVals = snapshots.map((s) => s.followers).filter((v): v is number => v != null);
  const sum = (k: "views" | "likes" | "replies" | "reposts" | "quotes") =>
    snapshots.reduce((acc, s) => acc + (s[k] ?? 0), 0);

  const summary = {
    days,
    points: snapshots.length,
    followersStart: followerVals[0] ?? null,
    followersEnd: followerVals[followerVals.length - 1] ?? null,
    followersGrowth:
      followerVals.length >= 2 ? followerVals[followerVals.length - 1] - followerVals[0] : null,
    totalViews: sum("views"),
    totalLikes: sum("likes"),
    totalReplies: sum("replies"),
    totalReposts: sum("reposts"),
    totalQuotes: sum("quotes"),
  };

  return { series, summary };
}

export async function getPostAnalytics(accountId: string, limit = 50) {
  const posts = await prisma.postInsight.findMany({
    where: { accountId },
    orderBy: { views: "desc" },
    take: limit,
  });
  return posts;
}
