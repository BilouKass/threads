import { Account } from "@prisma/client";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { getAccessToken } from "./tokens.js";
import {
  getUserInsights,
  getUserThreads,
  getProfile,
  InsightMetric,
} from "../threads/client.js";

const ENGAGEMENT_METRICS = ["views", "likes", "replies", "reposts", "quotes"];

function metricTotal(m: InsightMetric): number {
  if (m.total_value) return m.total_value.value ?? 0;
  if (m.values?.length) return m.values.reduce((sum, v) => sum + (v.value ?? 0), 0);
  return 0;
}

export interface AccountStats {
  accountId: string;
  username: string | null;
  name: string | null;
  profilePictureUrl: string | null;
  biography: string | null;
  tokenExpiresAt: Date | null;
  disabled: boolean;
  periodDays: number;
  followers: number | null;
  engagement: {
    views: number | null;
    likes: number | null;
    replies: number | null;
    reposts: number | null;
    quotes: number | null;
  };
  /** Daily "views" series for a sparkline (may be empty). */
  viewsSeries: { t: string | null; value: number }[];
  /** Count of recent threads on Threads (capped, approximate). */
  recentThreadsCount: number | null;
  /** Stats from our own DB (jobs managed by this app). */
  app: {
    published: number;
    pending: number;
    processing: number;
    failed: number;
    cancelled: number;
    actionsDone: number;
    repliesDone: number;
  };
  recentPosts: {
    id: string;
    text: string | null;
    mediaType: string;
    publishedId: string | null;
    updatedAt: Date;
  }[];
  /** Populated when insights couldn't be fetched (e.g. missing scope). */
  insightsError: string | null;
}

export async function getAccountStats(account: Account, days = 30): Promise<AccountStats> {
  const token = getAccessToken(account);
  const until = Math.floor(Date.now() / 1000);
  const since = until - days * 86_400;

  let followers: number | null = null;
  const engagement = { views: null, likes: null, replies: null, reposts: null, quotes: null } as AccountStats["engagement"];
  let viewsSeries: AccountStats["viewsSeries"] = [];
  let profilePictureUrl: string | null = null;
  let biography: string | null = null;
  let recentThreadsCount: number | null = null;
  let insightsError: string | null = null;

  // followers_count is a lifetime metric — request it on its own (no time range).
  try {
    const [fc] = await getUserInsights({
      userId: account.threadsUserId,
      accessToken: token,
      metrics: ["followers_count"],
    });
    if (fc) followers = metricTotal(fc);
  } catch (err) {
    insightsError = (err as Error).message;
  }

  // Engagement metrics over the selected period.
  try {
    const metrics = await getUserInsights({
      userId: account.threadsUserId,
      accessToken: token,
      metrics: ENGAGEMENT_METRICS,
      since,
      until,
    });
    for (const m of metrics) {
      if (m.name in engagement) {
        (engagement as Record<string, number>)[m.name] = metricTotal(m);
      }
      if (m.name === "views" && m.values?.length) {
        viewsSeries = m.values.map((v) => ({ t: v.end_time ?? null, value: v.value ?? 0 }));
      }
    }
  } catch (err) {
    insightsError = insightsError ?? (err as Error).message;
  }

  // Profile (avatar + bio).
  try {
    const profile = await getProfile(account.threadsUserId, token);
    profilePictureUrl = profile.threads_profile_picture_url ?? null;
    biography = profile.threads_biography ?? null;
  } catch (err) {
    logger.debug({ accountId: account.id, err: (err as Error).message }, "profile fetch failed");
  }

  // Approximate recent post count from a single page of the user's threads.
  try {
    const threads = await getUserThreads({
      userId: account.threadsUserId,
      accessToken: token,
      limit: 100,
      fields: "id",
    });
    recentThreadsCount = threads.data?.length ?? 0;
  } catch (err) {
    logger.debug({ accountId: account.id, err: (err as Error).message }, "threads list failed");
  }

  // DB-side stats (what THIS app manages).
  const [published, pending, processing, failed, cancelled, actionsDone, repliesDone, recentPosts] =
    await Promise.all([
      prisma.scheduledPost.count({ where: { accountId: account.id, status: "PUBLISHED" } }),
      prisma.scheduledPost.count({ where: { accountId: account.id, status: "PENDING" } }),
      prisma.scheduledPost.count({ where: { accountId: account.id, status: "PROCESSING" } }),
      prisma.scheduledPost.count({ where: { accountId: account.id, status: "FAILED" } }),
      prisma.scheduledPost.count({ where: { accountId: account.id, status: "CANCELLED" } }),
      prisma.action.count({ where: { accountId: account.id, status: "PUBLISHED" } }),
      prisma.action.count({ where: { accountId: account.id, type: "REPLY", status: "PUBLISHED" } }),
      prisma.scheduledPost.findMany({
        where: { accountId: account.id, status: "PUBLISHED" },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: { id: true, text: true, mediaType: true, publishedId: true, updatedAt: true },
      }),
    ]);

  return {
    accountId: account.id,
    username: account.username,
    name: account.name,
    profilePictureUrl,
    biography,
    tokenExpiresAt: account.expiresAt,
    disabled: account.disabled,
    periodDays: days,
    followers,
    engagement,
    viewsSeries,
    recentThreadsCount,
    app: { published, pending, processing, failed, cancelled, actionsDone, repliesDone },
    recentPosts,
    insightsError,
  };
}

/**
 * Lightweight overview (no external API calls). When `accountIds` is given
 * (a VA's assigned accounts), counts are restricted to those accounts.
 */
export async function getOverview(accountIds?: { in: string[] }) {
  const accountWhere = accountIds ? { id: accountIds } : {};
  const scoped = accountIds ? { accountId: accountIds } : {};
  const [accounts, activeAccounts, published, pending, failed, actions] = await Promise.all([
    prisma.account.count({ where: accountWhere }),
    prisma.account.count({ where: { ...accountWhere, disabled: false } }),
    prisma.scheduledPost.count({ where: { ...scoped, status: "PUBLISHED" } }),
    prisma.scheduledPost.count({ where: { ...scoped, status: "PENDING" } }),
    prisma.scheduledPost.count({ where: { ...scoped, status: "FAILED" } }),
    prisma.action.count({ where: { ...scoped, status: "PUBLISHED" } }),
  ]);
  return { accounts, activeAccounts, published, pending, failed, actions };
}
