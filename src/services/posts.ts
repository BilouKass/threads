import { Account, ScheduledPost, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { getAccessToken } from "./tokens.js";
import { createContainer, publishContainer, getContainerStatus } from "../threads/client.js";

export type MediaItem = { type: "IMAGE" | "VIDEO"; url: string };
export type PollInput = { optionA: string; optionB: string; optionC?: string; optionD?: string };
export type SpoilerRange = { offset: number; length: number };

export interface SchedulePostInput {
  accountId: string;
  text?: string;
  /** Ordered media items (images and/or videos). Mixed forms a carousel. */
  media?: MediaItem[];
  /** Convenience: image URLs (mapped to IMAGE media items). */
  imageUrls?: string[];
  /** Convenience: video URLs (mapped to VIDEO media items). */
  videoUrls?: string[];
  /** Poll attachment — TEXT-only posts. */
  poll?: PollInput;
  /** Text spoiler ranges (max 10). */
  spoilers?: SpoilerRange[];
  /** Blur the media as a spoiler. */
  isSpoilerMedia?: boolean;
  /** ISO datetime; when omitted, the post is due immediately. */
  scheduledAt?: string;
  /** If set, publish as a reply to this Threads media id. */
  replyToId?: string;
  linkAttachment?: string;
  maxAttempts?: number;
  /** Internal: chain wiring. */
  chainId?: string;
  chainOrder?: number;
  dependsOnPostId?: string;
}

function normalizeMedia(input: SchedulePostInput): MediaItem[] {
  if (input.media?.length) return input.media;
  const items: MediaItem[] = [];
  for (const url of input.imageUrls ?? []) items.push({ type: "IMAGE", url });
  for (const url of input.videoUrls ?? []) items.push({ type: "VIDEO", url });
  return items;
}

function deriveMediaType(media: MediaItem[]): "TEXT" | "IMAGE" | "VIDEO" | "CAROUSEL" {
  if (media.length === 0) return "TEXT";
  if (media.length === 1) return media[0].type;
  return "CAROUSEL";
}

/** Extract the URLs backing a stored post's media (for cleanup). */
export function mediaUrls(post: { media: Prisma.JsonValue | null }): string[] {
  const media = (post.media as MediaItem[] | null) ?? [];
  return media.map((m) => m.url);
}

function bad(message: string): never {
  const err = new Error(message);
  (err as any).statusCode = 400;
  throw err;
}

function validatePoll(poll: PollInput) {
  const options = [poll.optionA, poll.optionB, poll.optionC, poll.optionD].filter(
    (o): o is string => o != null && o !== ""
  );
  if (options.length < 2 || options.length > 4) bad("A poll requires 2 to 4 options");
  for (const o of options) {
    if (o.length < 1 || o.length > 25) bad("Each poll option must be 1-25 characters");
  }
}

function validateSpoilers(spoilers: SpoilerRange[], text?: string) {
  if (spoilers.length > 10) bad("At most 10 text spoilers per post");
  const len = (text ?? "").length;
  for (const s of spoilers) {
    if (!Number.isInteger(s.offset) || !Number.isInteger(s.length) || s.offset < 0 || s.length < 1) {
      bad("Spoiler offset/length must be non-negative integers (length >= 1)");
    }
    if (s.offset + s.length > len) bad("Spoiler range exceeds the text length");
  }
}

function validate(input: { media: MediaItem[]; text?: string; poll?: PollInput; spoilers?: SpoilerRange[] }) {
  const { media, text, poll, spoilers } = input;
  const mediaType = deriveMediaType(media);
  if (mediaType === "TEXT" && !text?.trim() && !poll) {
    bad("A text-only post requires non-empty text (or a poll)");
  }
  if (media.length > 20) bad("A carousel supports at most 20 items");
  if (poll) {
    if (media.length > 0) bad("A poll can only be attached to a text-only post");
    validatePoll(poll);
  }
  if (spoilers?.length) validateSpoilers(spoilers, text);
  return mediaType;
}

/** Create a scheduled (or immediate) post row. The worker publishes it. */
export async function schedulePost(input: SchedulePostInput): Promise<ScheduledPost> {
  const media = normalizeMedia(input);
  const mediaType = validate({ media, text: input.text, poll: input.poll, spoilers: input.spoilers });

  return prisma.scheduledPost.create({
    data: {
      accountId: input.accountId,
      text: input.text,
      media: media as unknown as Prisma.InputJsonValue,
      mediaType,
      replyToId: input.replyToId,
      linkAttachment: input.linkAttachment,
      poll: input.poll ? (input.poll as unknown as Prisma.InputJsonValue) : undefined,
      spoilers: input.spoilers?.length
        ? (input.spoilers as unknown as Prisma.InputJsonValue)
        : undefined,
      isSpoilerMedia: input.isSpoilerMedia ?? false,
      scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : new Date(),
      maxAttempts: input.maxAttempts ?? 3,
      chainId: input.chainId,
      chainOrder: input.chainOrder,
      dependsOnPostId: input.dependsOnPostId,
    },
  });
}

/** Bulk-create posts in one call (each item is an independent post). */
export async function schedulePostsBulk(items: SchedulePostInput[]): Promise<ScheduledPost[]> {
  const created: ScheduledPost[] = [];
  for (const item of items) created.push(await schedulePost(item));
  return created;
}

/**
 * Create a chain (enchaînement): an ordered list of posts where each one is
 * published as a reply to the previously published post in the chain.
 * Only the first post carries scheduledAt; the rest wait on their predecessor.
 */
export async function scheduleChain(params: {
  accountId: string;
  scheduledAt?: string;
  maxAttempts?: number;
  posts: {
    text?: string;
    media?: MediaItem[];
    imageUrls?: string[];
    videoUrls?: string[];
    poll?: PollInput;
    spoilers?: SpoilerRange[];
    isSpoilerMedia?: boolean;
  }[];
}): Promise<ScheduledPost[]> {
  if (!params.posts.length) {
    const err = new Error("A chain requires at least one post");
    (err as any).statusCode = 400;
    throw err;
  }
  const chainId = `chain_${Math.random().toString(36).slice(2, 10)}${params.posts.length}`;
  const created: ScheduledPost[] = [];
  let previousId: string | undefined;

  for (let i = 0; i < params.posts.length; i++) {
    const post = await schedulePost({
      accountId: params.accountId,
      text: params.posts[i].text,
      media: params.posts[i].media,
      imageUrls: params.posts[i].imageUrls,
      videoUrls: params.posts[i].videoUrls,
      poll: params.posts[i].poll,
      spoilers: params.posts[i].spoilers,
      isSpoilerMedia: params.posts[i].isSpoilerMedia,
      // Only the head is time-scheduled; followers depend on their predecessor.
      scheduledAt: i === 0 ? params.scheduledAt : undefined,
      maxAttempts: params.maxAttempts,
      chainId,
      chainOrder: i,
      dependsOnPostId: previousId,
    });
    previousId = post.id;
    created.push(post);
  }
  return created;
}

/** Wait for a container to finish processing (videos/carousels need this). */
async function waitForContainer(containerId: string, accessToken: string): Promise<void> {
  const maxChecks = 40;
  for (let i = 0; i < maxChecks; i++) {
    const status = await getContainerStatus({ containerId, accessToken });
    if (status.status === "FINISHED" || status.status === "PUBLISHED") return;
    if (status.status === "ERROR" || status.status === "EXPIRED") {
      throw new Error(`Container ${containerId} failed: ${status.error_message ?? status.status}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Container ${containerId} not ready after ${maxChecks} checks`);
}

function containerArgsFor(item: MediaItem, isCarouselItem: boolean) {
  return item.type === "VIDEO"
    ? { mediaType: "VIDEO" as const, videoUrl: item.url, isCarouselItem }
    : { mediaType: "IMAGE" as const, imageUrl: item.url, isCarouselItem };
}

/**
 * Execute the full publish flow for a post. Returns the published media id.
 * Throws on failure (the worker handles retries / status).
 */
export async function publishPost(post: ScheduledPost, account: Account): Promise<string> {
  const accessToken = getAccessToken(account);
  const userId = account.threadsUserId;
  const media = (post.media as MediaItem[] | null) ?? [];
  const spoilers = (post.spoilers as { offset: number; length: number }[] | null) ?? undefined;
  const poll = (post.poll as { optionA: string; optionB: string; optionC?: string; optionD?: string } | null) ?? undefined;

  let creationId: string;

  if (post.mediaType === "CAROUSEL") {
    // 1. Create one child container per item (image or video); wait for videos.
    const childIds: string[] = [];
    for (const item of media) {
      const childId = await createContainer({
        userId,
        accessToken,
        ...containerArgsFor(item, true),
      });
      if (item.type === "VIDEO") await waitForContainer(childId, accessToken);
      childIds.push(childId);
    }
    // 2. Create the carousel container referencing the children.
    creationId = await createContainer({
      userId,
      accessToken,
      mediaType: "CAROUSEL",
      text: post.text ?? undefined,
      children: childIds,
      replyToId: post.replyToId ?? undefined,
      textEntities: spoilers,
      isSpoilerMedia: post.isSpoilerMedia,
    });
  } else if (post.mediaType === "IMAGE" || post.mediaType === "VIDEO") {
    creationId = await createContainer({
      userId,
      accessToken,
      ...containerArgsFor(media[0], false),
      text: post.text ?? undefined,
      replyToId: post.replyToId ?? undefined,
      textEntities: spoilers,
      isSpoilerMedia: post.isSpoilerMedia,
    });
  } else {
    creationId = await createContainer({
      userId,
      accessToken,
      mediaType: "TEXT",
      text: post.text ?? undefined,
      linkAttachment: post.linkAttachment ?? undefined,
      replyToId: post.replyToId ?? undefined,
      textEntities: spoilers,
      poll,
    });
  }

  // Media containers must finish processing before publish.
  if (post.mediaType !== "TEXT") {
    await waitForContainer(creationId, accessToken);
  }

  const publishedId = await publishContainer({ userId, accessToken, creationId });
  logger.info({ postId: post.id, publishedId }, "Published Threads post");
  return publishedId;
}

export async function listPosts(filter?: {
  accountId?: string;
  status?: string;
  accountIds?: { in: string[] };
}) {
  const where: Record<string, unknown> = {};
  if (filter?.status) where.status = filter.status;
  if (filter?.accountId) where.accountId = filter.accountId;
  else if (filter?.accountIds) where.accountId = filter.accountIds;
  return prisma.scheduledPost.findMany({ where, orderBy: { scheduledAt: "desc" }, take: 200 });
}

export async function cancelPost(id: string) {
  return prisma.scheduledPost.update({ where: { id }, data: { status: "CANCELLED" } });
}
