import { request } from "undici";
import { logger } from "../logger.js";

/**
 * Thin wrapper around the official Threads Graph API.
 * Docs: https://developers.facebook.com/docs/threads
 *
 * Base hosts:
 *   - https://graph.threads.net        -> Graph API (publish, replies, refresh)
 *   - https://threads.net/oauth/authorize -> user authorization page
 */
const GRAPH = "https://graph.threads.net";
const API_VERSION = "v1.0";

export class ThreadsApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ThreadsApiError";
    this.status = status;
    this.body = body;
  }
}

async function call<T>(
  method: "GET" | "POST",
  url: string,
  opts: { query?: Record<string, string | undefined>; form?: Record<string, string | undefined> } = {}
): Promise<T> {
  const u = new URL(url);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) u.searchParams.set(k, v);
    }
  }

  let body: string | undefined;
  const headers: Record<string, string> = {};
  if (opts.form) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.form)) {
      if (v !== undefined) params.set(k, v);
    }
    body = params.toString();
    headers["content-type"] = "application/x-www-form-urlencoded";
  }

  const res = await request(u, { method, headers, body });
  const text = await res.body.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (res.statusCode >= 400) {
    logger.warn({ status: res.statusCode, url: u.pathname, body: json }, "Threads API error");
    const errMsg =
      (json as any)?.error?.message ?? `Threads API request failed (${res.statusCode})`;
    throw new ThreadsApiError(errMsg, res.statusCode, json);
  }
  return json as T;
}

// ---------- OAuth ----------

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
}): string {
  const u = new URL("https://threads.net/oauth/authorize");
  u.searchParams.set("client_id", params.clientId);
  u.searchParams.set("redirect_uri", params.redirectUri);
  u.searchParams.set("scope", params.scopes.join(","));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", params.state);
  return u.toString();
}

export interface ShortLivedTokenResponse {
  access_token: string;
  user_id: string | number;
}

/** Exchange an authorization code for a short-lived token. */
export function exchangeCodeForToken(params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<ShortLivedTokenResponse> {
  return call<ShortLivedTokenResponse>("POST", `${GRAPH}/oauth/access_token`, {
    form: {
      client_id: params.clientId,
      client_secret: params.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: params.redirectUri,
      code: params.code,
    },
  });
}

export interface LongLivedTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number; // seconds (~ 5184000 = 60 days)
}

/** Exchange a short-lived token for a long-lived (60-day) token. */
export function exchangeForLongLivedToken(params: {
  clientSecret: string;
  shortLivedToken: string;
}): Promise<LongLivedTokenResponse> {
  return call<LongLivedTokenResponse>("GET", `${GRAPH}/access_token`, {
    query: {
      grant_type: "th_exchange_token",
      client_secret: params.clientSecret,
      access_token: params.shortLivedToken,
    },
  });
}

/** Refresh a long-lived token (must be >24h old and unexpired). */
export function refreshLongLivedToken(accessToken: string): Promise<LongLivedTokenResponse> {
  return call<LongLivedTokenResponse>("GET", `${GRAPH}/refresh_access_token`, {
    query: {
      grant_type: "th_refresh_token",
      access_token: accessToken,
    },
  });
}

// ---------- Profile ----------

export interface ThreadsProfile {
  id: string;
  username?: string;
  name?: string;
  threads_profile_picture_url?: string;
  threads_biography?: string;
}

export function getMe(accessToken: string): Promise<ThreadsProfile> {
  return call<ThreadsProfile>("GET", `${GRAPH}/${API_VERSION}/me`, {
    query: {
      fields: "id,username,name,threads_profile_picture_url,threads_biography",
      access_token: accessToken,
    },
  });
}

/** Fetch a profile by user id (for the stats panel). */
export function getProfile(userId: string, accessToken: string): Promise<ThreadsProfile> {
  return call<ThreadsProfile>("GET", `${GRAPH}/${API_VERSION}/${userId}`, {
    query: {
      fields: "id,username,name,threads_profile_picture_url,threads_biography",
      access_token: accessToken,
    },
  });
}

// ---------- Publishing ----------

export interface CreateContainerParams {
  userId: string;
  accessToken: string;
  mediaType: "TEXT" | "IMAGE" | "VIDEO" | "CAROUSEL";
  text?: string;
  imageUrl?: string;
  videoUrl?: string;
  /** For carousel: the child container ids. */
  children?: string[];
  /** Mark a child container (image/video inside a carousel). */
  isCarouselItem?: boolean;
  /** Publish as a reply to this Threads media id. */
  replyToId?: string;
  /** Optional link attachment for text posts. */
  linkAttachment?: string;
  /** Poll attachment (TEXT posts only): 2-4 options of 1-25 chars. */
  poll?: { optionA: string; optionB: string; optionC?: string; optionD?: string };
  /** Text spoilers: ranges of `text` to obscure (max 10). */
  textEntities?: { offset: number; length: number }[];
  /** Mark the media (IMAGE/VIDEO/CAROUSEL) as a blurred spoiler. */
  isSpoilerMedia?: boolean;
}

interface ContainerResponse {
  id: string;
}

/** Step 1: create a media container. Returns a creation_id. */
export async function createContainer(params: CreateContainerParams): Promise<string> {
  const form: Record<string, string | undefined> = {
    access_token: params.accessToken,
    text: params.text,
    reply_to_id: params.replyToId,
  };

  if (params.isCarouselItem) {
    form.is_carousel_item = "true";
  }

  // Text spoilers apply to the post's `text` regardless of media type.
  if (params.textEntities?.length) {
    form.text_entities = JSON.stringify(
      params.textEntities.map((e) => ({
        entity_type: "SPOILER",
        offset: e.offset,
        length: e.length,
      }))
    );
  }
  // Media spoiler flag (ignored by the API for TEXT/carousel-item containers).
  if (params.isSpoilerMedia) {
    form.is_spoiler_media = "true";
  }
  // Poll attachment — TEXT posts only.
  if (params.poll) {
    form.poll_attachment = JSON.stringify({
      option_a: params.poll.optionA,
      option_b: params.poll.optionB,
      ...(params.poll.optionC ? { option_c: params.poll.optionC } : {}),
      ...(params.poll.optionD ? { option_d: params.poll.optionD } : {}),
    });
  }

  if (params.mediaType === "CAROUSEL") {
    form.media_type = "CAROUSEL";
    form.children = params.children?.join(",");
  } else if (params.mediaType === "IMAGE") {
    form.media_type = "IMAGE";
    form.image_url = params.imageUrl;
  } else if (params.mediaType === "VIDEO") {
    form.media_type = "VIDEO";
    form.video_url = params.videoUrl;
  } else {
    form.media_type = "TEXT";
    if (params.linkAttachment) form.link_attachment = params.linkAttachment;
  }

  const res = await call<ContainerResponse>("POST", `${GRAPH}/${API_VERSION}/${params.userId}/threads`, {
    form,
  });
  return res.id;
}

/** Step 2: publish a previously created container. Returns the published media id. */
export async function publishContainer(params: {
  userId: string;
  accessToken: string;
  creationId: string;
}): Promise<string> {
  const res = await call<ContainerResponse>(
    "POST",
    `${GRAPH}/${API_VERSION}/${params.userId}/threads_publish`,
    {
      form: { access_token: params.accessToken, creation_id: params.creationId },
    }
  );
  return res.id;
}

/** Container processing status (relevant mostly for video/carousel). */
export interface ContainerStatus {
  status: "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";
  id: string;
  error_message?: string;
}

export function getContainerStatus(params: {
  containerId: string;
  accessToken: string;
}): Promise<ContainerStatus> {
  return call<ContainerStatus>("GET", `${GRAPH}/${API_VERSION}/${params.containerId}`, {
    query: { fields: "status,error_message", access_token: params.accessToken },
  });
}

// ---------- Insights & stats ----------

export interface InsightMetric {
  name: string;
  period?: string;
  title?: string;
  /** Time-series values (e.g. daily "views"). */
  values?: { value: number; end_time?: string }[];
  /** Single aggregate value (e.g. "followers_count"). */
  total_value?: { value: number };
}

/**
 * User-level insights. Requires the `threads_manage_insights` scope.
 * Common metrics: views, likes, replies, reposts, quotes, followers_count.
 * `since`/`until` are Unix seconds (omit for lifetime metrics like followers_count).
 */
export async function getUserInsights(params: {
  userId: string;
  accessToken: string;
  metrics: string[];
  since?: number;
  until?: number;
}): Promise<InsightMetric[]> {
  const res = await call<{ data: InsightMetric[] }>(
    "GET",
    `${GRAPH}/${API_VERSION}/${params.userId}/threads_insights`,
    {
      query: {
        metric: params.metrics.join(","),
        since: params.since !== undefined ? String(params.since) : undefined,
        until: params.until !== undefined ? String(params.until) : undefined,
        access_token: params.accessToken,
      },
    }
  );
  return res.data ?? [];
}

/** Per-post insights. Requires the `threads_manage_insights` scope. */
export function getMediaInsights(params: {
  mediaId: string;
  accessToken: string;
  metrics?: string[];
}): Promise<InsightMetric[]> {
  const metrics = params.metrics ?? ["views", "likes", "replies", "reposts", "quotes", "shares"];
  return call<{ data: InsightMetric[] }>(
    "GET",
    `${GRAPH}/${API_VERSION}/${params.mediaId}/insights`,
    { query: { metric: metrics.join(","), access_token: params.accessToken } }
  ).then((r) => r.data ?? []);
}

export interface ThreadItem {
  id: string;
  permalink?: string;
  timestamp?: string;
  media_type?: string;
  text?: string;
}

/** List the user's own threads (most recent first). Paginated by the API. */
export function getUserThreads(params: {
  userId: string;
  accessToken: string;
  limit?: number;
  fields?: string;
}): Promise<{ data: ThreadItem[]; paging?: { cursors?: { after?: string } } }> {
  return call("GET", `${GRAPH}/${API_VERSION}/${params.userId}/threads`, {
    query: {
      fields: params.fields ?? "id,permalink,timestamp,media_type,text",
      limit: String(params.limit ?? 25),
      access_token: params.accessToken,
    },
  });
}
