import { Account } from "@prisma/client";
import { prisma } from "../db.js";
import { decrypt, encrypt } from "../crypto.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import {
  exchangeForLongLivedToken,
  refreshLongLivedToken,
} from "../threads/client.js";

/** Decrypt and return an account's usable access token. */
export function getAccessToken(account: Account): string {
  return decrypt(account.accessToken);
}

function expiryFromNow(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

/**
 * Store/replace an account's token. Token is encrypted at rest.
 */
export async function storeToken(params: {
  accountId: string;
  accessToken: string;
  expiresInSeconds: number;
  tokenType?: string;
}): Promise<void> {
  await prisma.account.update({
    where: { id: params.accountId },
    data: {
      accessToken: encrypt(params.accessToken),
      tokenType: params.tokenType ?? "long_lived",
      expiresAt: expiryFromNow(params.expiresInSeconds),
      lastRefreshAt: new Date(),
    },
  });
}

/**
 * Exchange a short-lived token for a long-lived one and persist it.
 * Used right after OAuth completes.
 */
export async function upgradeAndStore(params: {
  accountId: string;
  shortLivedToken: string;
}): Promise<void> {
  const long = await exchangeForLongLivedToken({
    clientSecret: config.THREADS_APP_SECRET,
    shortLivedToken: params.shortLivedToken,
  });
  await storeToken({
    accountId: params.accountId,
    accessToken: long.access_token,
    expiresInSeconds: long.expires_in,
    tokenType: long.token_type,
  });
}

/** Refresh a single account's long-lived token. */
export async function refreshAccount(account: Account): Promise<void> {
  const current = getAccessToken(account);
  const refreshed = await refreshLongLivedToken(current);
  await storeToken({
    accountId: account.id,
    accessToken: refreshed.access_token,
    expiresInSeconds: refreshed.expires_in,
    tokenType: refreshed.token_type,
  });
  logger.info({ accountId: account.id }, "Refreshed Threads token");
}

/**
 * Refresh all accounts whose token expires within the configured threshold.
 * Returns the number of accounts refreshed.
 */
export async function refreshExpiringTokens(): Promise<number> {
  const threshold = new Date(
    Date.now() + config.TOKEN_REFRESH_THRESHOLD_DAYS * 24 * 60 * 60 * 1000
  );
  const accounts = await prisma.account.findMany({
    where: {
      disabled: false,
      tokenType: "long_lived",
      expiresAt: { lte: threshold },
    },
  });

  let refreshed = 0;
  for (const account of accounts) {
    try {
      await refreshAccount(account);
      refreshed++;
    } catch (err) {
      logger.error(
        { accountId: account.id, err: (err as Error).message },
        "Failed to refresh token"
      );
    }
  }
  return refreshed;
}
