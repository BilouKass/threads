import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { prisma, disconnect } from "./db.js";
import { ensureMasterKey } from "./services/apikeys.js";
import { ensureAdmin } from "./services/users.js";
import { initPublicHost, getMediaBaseUrl } from "./publicUrl.js";
import { authRoutes } from "./routes/auth.js";
import { sessionRoutes } from "./routes/session.js";
import { userRoutes } from "./routes/users.js";
import { accountRoutes } from "./routes/accounts.js";
import { postRoutes } from "./routes/posts.js";
import { actionRoutes } from "./routes/actions.js";
import { apiKeyRoutes } from "./routes/apikeys.js";
import { uploadRoutes } from "./routes/uploads.js";
import { mediaRoutes } from "./routes/media.js";
import { statsRoutes } from "./routes/stats.js";
import { queueRoutes } from "./routes/queue.js";
import { analyticsRoutes } from "./routes/analytics.js";

async function main(): Promise<void> {
  // ---- Admin API + UI + OAuth (kept on PORT; can stay local) ----
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  // Allow large video uploads (up to 200 MB).
  await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });

  const publicDir = path.resolve(process.cwd(), "public");
  await app.register(fastifyStatic, { root: publicDir, prefix: "/" });

  app.get("/health", async () => ({ ok: true, ts: new Date().toISOString() }));

  await app.register(authRoutes); // OAuth flow (browser)
  await app.register(sessionRoutes); // login / logout / me
  // Signed media is also served here so a single tunnel/host (the API port) can
  // serve both OAuth and images. The dedicated media server below stays available
  // for the direct-public-IP exposure scenario.
  await app.register(mediaRoutes);

  // Protected resource routes (session cookie or API key).
  await app.register(userRoutes); // admin-only
  await app.register(accountRoutes);
  await app.register(postRoutes);
  await app.register(actionRoutes);
  await app.register(apiKeyRoutes);
  await app.register(uploadRoutes);
  await app.register(statsRoutes);
  await app.register(queueRoutes);
  await app.register(analyticsRoutes);

  // ---- Dedicated public media server (ONLY this port faces the Internet) ----
  // Serves images via signed, expiring URLs so Meta can download them.
  const media = Fastify({ logger: false });
  await media.register(mediaRoutes);
  media.get("/health", async () => ({ ok: true }));

  // Ensure DB reachable + bootstrap a master API key and the first admin.
  await prisma.$connect();
  await ensureMasterKey();
  await ensureAdmin();

  // Resolve the public host (explicit MEDIA_PUBLIC_HOST or auto-detected IP).
  await initPublicHost();

  await app.listen({ port: config.PORT, host: config.HOST });
  await media.listen({ port: config.MEDIA_PORT, host: config.MEDIA_HOST });

  logger.info(`Admin API + UI:  http://${config.HOST}:${config.PORT}`);
  logger.info(`Media server:    http://${config.MEDIA_HOST}:${config.MEDIA_PORT}  (expose this port)`);
  logger.info(`Public media URL base: ${getMediaBaseUrl()}`);

  const shutdown = async () => {
    logger.info("Shutting down...");
    await Promise.allSettled([app.close(), media.close()]);
    await disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error({ err }, "Fatal error starting API");
  process.exit(1);
});
