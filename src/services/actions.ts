import { Account, Action } from "@prisma/client";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { getAccessToken } from "./tokens.js";
import { createContainer, publishContainer } from "../threads/client.js";

export interface CreateActionInput {
  accountId: string;
  type: "REPLY";
  targetId: string;
  text?: string;
  scheduledAt?: string;
  maxAttempts?: number;
}

/** Queue an action (currently: reply to a post/comment) for the worker. */
export async function createAction(input: CreateActionInput): Promise<Action> {
  if (input.type === "REPLY" && !input.text?.trim()) {
    const err = new Error("REPLY actions require non-empty text");
    (err as any).statusCode = 400;
    throw err;
  }
  return prisma.action.create({
    data: {
      accountId: input.accountId,
      type: input.type,
      targetId: input.targetId,
      text: input.text,
      scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : new Date(),
      maxAttempts: input.maxAttempts ?? 3,
    },
  });
}

/**
 * Execute an action. Returns the resulting media id (REPLY).
 * Throws on failure; the worker handles retries/status.
 */
export async function runAction(action: Action, account: Account): Promise<string | null> {
  const accessToken = getAccessToken(account);
  const userId = account.threadsUserId;

  switch (action.type) {
    case "REPLY": {
      // A reply is a normal post with reply_to_id set to the target.
      const creationId = await createContainer({
        userId,
        accessToken,
        mediaType: "TEXT",
        text: action.text ?? undefined,
        replyToId: action.targetId,
      });
      const id = await publishContainer({ userId, accessToken, creationId });
      logger.info({ actionId: action.id, resultId: id }, "Published reply");
      return id;
    }

    default: {
      const err = new Error(`Unknown action type "${action.type}"`);
      (err as any).statusCode = 400;
      throw err;
    }
  }
}

export async function listActions(filter?: {
  accountId?: string;
  status?: string;
  accountIds?: { in: string[] };
}) {
  const where: Record<string, unknown> = {};
  if (filter?.status) where.status = filter.status;
  if (filter?.accountId) where.accountId = filter.accountId;
  else if (filter?.accountIds) where.accountId = filter.accountIds;
  return prisma.action.findMany({ where, orderBy: { scheduledAt: "desc" }, take: 200 });
}
