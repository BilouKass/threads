import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { config } from "./config.js";

const KEY = Buffer.from(config.TOKEN_ENCRYPTION_KEY, "hex"); // 32 bytes
const ALGO = "aes-256-gcm";

/**
 * Encrypt a secret (e.g. an access token) for storage at rest.
 * Output format: base64( iv(12) | authTag(16) | ciphertext ).
 */
/**
 * @param plaintext — the secret string to encrypt (e.g. an access token).
 * @returns base64 string `iv(12) | authTag(16) | ciphertext`.
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/**
 * Reverse of {@link encrypt}: decrypt a secret stored at rest.
 * @param payload — base64 string `iv(12) | authTag(16) | ciphertext`.
 * @returns the original UTF-8 plaintext (throws if the auth tag is invalid).
 */
export function decrypt(payload: string): string {
  const raw = Buffer.from(payload, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

/** Generate a new raw API key and its sha256 hash + display prefix. */
export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = "tk_" + randomBytes(24).toString("base64url");
  const hash = sha256(raw);
  return { raw, hash, prefix: raw.slice(0, 10) };
}

/**
 * Compute the hex-encoded SHA-256 digest of a string.
 * @param value — the input to hash (e.g. a raw API key).
 * @returns the 64-char lowercase hex digest.
 */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
