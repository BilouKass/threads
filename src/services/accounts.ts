import { prisma } from "../db.js";
import { encrypt } from "../crypto.js";
import { getMe } from "../threads/client.js";
import { upgradeAndStore } from "./tokens.js";

/**
 * Create or update an account from a freshly obtained short-lived token,
 * then upgrade it to a long-lived token and persist.
 */
export async function connectAccountFromShortLivedToken(params: {
  shortLivedToken: string;
  scope: string;
}): Promise<{ id: string; threadsUserId: string; username?: string | null }> {
  // Fetch profile so we know who this is.
  const profile = await getMe(params.shortLivedToken);

  // Upsert the account. Store the short-lived token first (encrypted),
  // then upgrade to long-lived.
  const account = await prisma.account.upsert({
    where: { threadsUserId: String(profile.id) },
    create: {
      threadsUserId: String(profile.id),
      username: profile.username,
      name: profile.name,
      accessToken: encrypt(params.shortLivedToken),
      tokenType: "short_lived",
      scope: params.scope,
    },
    update: {
      username: profile.username,
      name: profile.name,
      scope: params.scope,
      disabled: false,
    },
  });

  await upgradeAndStore({ accountId: account.id, shortLivedToken: params.shortLivedToken });

  return { id: account.id, threadsUserId: account.threadsUserId, username: account.username };
}

export async function listAccounts(accountIds?: { in: string[] }) {
  const accounts = await prisma.account.findMany({
    where: accountIds ? { id: accountIds } : undefined,
    orderBy: { createdAt: "desc" },
  });
  // Never leak the token.
  return accounts.map((a) => ({
    id: a.id,
    threadsUserId: a.threadsUserId,
    username: a.username,
    name: a.name,
    tokenType: a.tokenType,
    scope: a.scope,
    expiresAt: a.expiresAt,
    lastRefreshAt: a.lastRefreshAt,
    disabled: a.disabled,
    createdAt: a.createdAt,
  }));
}

export async function getAccountOrThrow(id: string) {
  const account = await prisma.account.findUnique({ where: { id } });
  if (!account) {
    const err = new Error("Account not found");
    (err as any).statusCode = 404;
    throw err;
  }
  return account;
}

export async function setDisabled(id: string, disabled: boolean) {
  return prisma.account.update({ where: { id }, data: { disabled } });
}

export async function deleteAccount(id: string) {
  return prisma.account.delete({ where: { id } });
}
