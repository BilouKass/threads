import { existsSync } from "node:fs";
import { z } from "zod";

// Load a local .env automatically (Node >= 20.12). In Docker, vars are injected
// via env_file, so this is a best-effort convenience for local dev.
try {
  const loadEnvFile = (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile;
  if (typeof loadEnvFile === "function" && existsSync(".env")) {
    loadEnvFile(".env");
  }
} catch {
  /* ignore */
}

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string(),

  THREADS_APP_ID: z.string().min(1, "THREADS_APP_ID is required"),
  THREADS_APP_SECRET: z.string().min(1, "THREADS_APP_SECRET is required"),
  THREADS_REDIRECT_URI: z.string().url(),
  THREADS_SCOPES: z
    .string()
    .default(
      "threads_basic,threads_content_publish,threads_manage_replies,threads_read_replies,threads_manage_insights"
    ),

  TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes)"),

  SCHEDULER_POLL_SECONDS: z.coerce.number().default(15),
  TOKEN_REFRESH_THRESHOLD_DAYS: z.coerce.number().default(10),

  // ---- Users / sessions (web UI auth) ----
  // First-admin bootstrap: if no ADMIN exists and ADMIN_PASSWORD is set, an
  // admin user (ADMIN_USERNAME) is created on boot.
  ADMIN_USERNAME: z.string().default("admin"),
  ADMIN_PASSWORD: z.string().optional(),
  // Session lifetime (days) and cookie security.
  SESSION_TTL_DAYS: z.coerce.number().default(7),
  COOKIE_SECURE: z
    .preprocess((v) => v === undefined ? false : ["1", "true", "yes", "on"].includes(String(v).toLowerCase()), z.boolean()),

  // ---- Media / image hosting ----
  // How long a signed media URL stays valid. The file is also deleted right
  // after the post is published; this TTL bounds orphan uploads and how far in
  // the future a post that references the image may be scheduled.
  MEDIA_SIGNED_URL_TTL_MINUTES: z.coerce.number().default(1440),

  // Dedicated public media server. This is the ONLY port that must be reachable
  // from the Internet (port-forward / firewall) so Meta can download images.
  MEDIA_PORT: z.coerce.number().default(8080),
  MEDIA_HOST: z.string().default("0.0.0.0"),
  // Public IP or domain clients use to reach MEDIA_PORT. "auto" (or empty) tries
  // to auto-detect the public IP at boot.
  MEDIA_PUBLIC_HOST: z.string().optional(),
  // Full override of the media base URL (e.g. behind a reverse proxy / HTTPS).
  // When set, takes precedence over MEDIA_PUBLIC_HOST + MEDIA_PORT.
  MEDIA_PUBLIC_BASE_URL: z.string().url().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Print a readable error and exit. Worker and server both import this module.
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const config = parsed.data;

export const threadsScopes = config.THREADS_SCOPES.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
