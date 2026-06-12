import { prisma } from "../db.js";
import { generateApiKey, sha256 } from "../crypto.js";
import { logger } from "../logger.js";

export async function createApiKey(name: string): Promise<{ id: string; raw: string; prefix: string }> {
  const { raw, hash, prefix } = generateApiKey();
  const created = await prisma.apiKey.create({ data: { name, hash, prefix } });
  return { id: created.id, raw, prefix };
}

/** Validate a raw key. Returns the key record or null. Updates lastUsedAt. */
export async function validateApiKey(raw: string) {
  const hash = sha256(raw);
  const key = await prisma.apiKey.findUnique({ where: { hash } });
  if (!key || key.revokedAt) return null;
  // Best-effort touch; don't block the request on it.
  prisma.apiKey
    .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
  return key;
}

export async function listApiKeys() {
  const keys = await prisma.apiKey.findMany({ orderBy: { createdAt: "desc" } });
  return keys.map((k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
    createdAt: k.createdAt,
  }));
}

export async function revokeApiKey(id: string) {
  return prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
}

/**
 * Ensure at least one API key exists. If none, create a master key and log it
 * once so the operator can grab it on first boot.
 */
export async function ensureMasterKey(): Promise<void> {
  const count = await prisma.apiKey.count({ where: { revokedAt: null } });
  if (count > 0) return;
  const { raw, prefix } = await createApiKey("master (auto-created)");
  logger.warn(
    `\n========================================================\n` +
      `  No API key found. Created a master API key:\n\n` +
      `    ${raw}\n\n` +
      `  Store it now (prefix ${prefix}) — it will not be shown again.\n` +
      `  Use header:  X-API-Key: <key>   (or Authorization: Bearer <key>)\n` +
      `========================================================\n`
  );
}
