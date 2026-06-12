import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, unlink, readdir, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getMediaBaseUrl } from "../publicUrl.js";

// Stored OUTSIDE public/ so files are never served unsigned by static hosting.
export const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm"]);
export const FILENAME_RE = /^[A-Za-z0-9_-]+\.(jpe?g|png|gif|webp|mp4|mov|webm)$/i;

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

export function mimeForFilename(filename: string): string {
  return MIME[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

export function isAllowedExt(ext: string): boolean {
  const e = ext.toLowerCase();
  return IMAGE_EXT.has(e) || VIDEO_EXT.has(e);
}

/** Classify an upload by extension into the Threads media item type. */
export function mediaTypeForExt(ext: string): "IMAGE" | "VIDEO" {
  return VIDEO_EXT.has(ext.toLowerCase()) ? "VIDEO" : "IMAGE";
}

/** HMAC over "<filename>.<exp>" using a key derived from TOKEN_ENCRYPTION_KEY. */
function sign(filename: string, expMs: number): string {
  return createHmac("sha256", Buffer.from(config.TOKEN_ENCRYPTION_KEY, "hex"))
    .update(`${filename}.${expMs}`)
    .digest("base64url");
}

export function buildSignedUrl(filename: string, expMs: number): string {
  const sig = sign(filename, expMs);
  return `${getMediaBaseUrl()}/media/${filename}?exp=${expMs}&sig=${sig}`;
}

export type SignatureCheck = "ok" | "expired" | "invalid";

export function verifySignedRequest(
  filename: string,
  exp: unknown,
  sig: unknown
): SignatureCheck {
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || typeof sig !== "string") return "invalid";

  const expected = sign(filename, expMs);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "invalid";

  if (Date.now() > expMs) return "expired";
  return "ok";
}

/**
 * Persist an uploaded image to disk under a random name and return a signed,
 * expiring URL Meta can fetch. The file is deleted after the post publishes
 * (see scheduler) or by the orphan-cleanup sweep.
 */
export async function saveUpload(
  source: Readable,
  ext: string
): Promise<{ url: string; filename: string; expiresAt: Date }> {
  await mkdir(UPLOAD_DIR, { recursive: true });
  const filename = `${randomBytes(20).toString("hex")}${ext.toLowerCase()}`;
  const dest = path.join(UPLOAD_DIR, filename);
  await pipeline(source, createWriteStream(dest));

  const expMs = Date.now() + config.MEDIA_SIGNED_URL_TTL_MINUTES * 60_000;
  return { url: buildSignedUrl(filename, expMs), filename, expiresAt: new Date(expMs) };
}

/** Extract a stored filename from a previously-built media URL, or null. */
export function filenameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/media\/([^/]+)$/);
    const name = m?.[1];
    return name && FILENAME_RE.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** Delete the local files backing the given media URLs (best-effort). */
export async function deleteByUrls(urls: string[]): Promise<void> {
  for (const url of urls) {
    const filename = filenameFromUrl(url);
    if (!filename) continue;
    await unlink(path.join(UPLOAD_DIR, filename)).catch(() => undefined);
  }
}

/** Remove orphan uploads older than the signed-URL TTL. Returns count removed. */
export async function cleanupExpiredUploads(): Promise<number> {
  const ttlMs = config.MEDIA_SIGNED_URL_TTL_MINUTES * 60_000;
  let removed = 0;
  const files = await readdir(UPLOAD_DIR).catch(() => [] as string[]);
  for (const f of files) {
    if (f === ".gitkeep") continue;
    const p = path.join(UPLOAD_DIR, f);
    const s = await stat(p).catch(() => null);
    if (!s || !s.isFile()) continue;
    if (Date.now() - s.mtimeMs > ttlMs) {
      await unlink(p).catch(() => undefined);
      removed++;
    }
  }
  if (removed > 0) logger.info({ removed }, "Cleaned up expired uploads");
  return removed;
}
