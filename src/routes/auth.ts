import { randomBytes } from "node:crypto";
import { FastifyInstance } from "fastify";
import { config, threadsScopes } from "../config.js";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { buildAuthorizeUrl, exchangeCodeForToken } from "../threads/client.js";
import { connectAccountFromShortLivedToken } from "../services/accounts.js";
import { authenticate, currentUserId } from "../middleware/auth.js";
import { assignAccount } from "../services/users.js";

/**
 * OAuth routes. `/auth/threads` requires a logged-in user (to auto-assign the
 * new account); `/auth/threads/callback` is hit by the browser redirect.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get("/auth/threads", { preHandler: authenticate }, async (req, reply) => {
    const state = randomBytes(16).toString("hex");
    await prisma.oAuthState.create({ data: { state, userId: currentUserId(req) } });

    const url = buildAuthorizeUrl({
      clientId: config.THREADS_APP_ID,
      redirectUri: config.THREADS_REDIRECT_URI,
      scopes: threadsScopes,
      state,
    });
    return reply.redirect(url);
  });

  app.get("/auth/threads/callback", async (req, reply) => {
    const query = req.query as { code?: string; state?: string; error?: string; error_description?: string };

    if (query.error) {
      return reply.code(400).send({ error: query.error, description: query.error_description });
    }
    if (!query.code || !query.state) {
      return reply.code(400).send({ error: "Missing code or state" });
    }

    // Validate + consume state (CSRF protection).
    const stateRow = await prisma.oAuthState.findUnique({ where: { state: query.state } });
    if (!stateRow) {
      return reply.code(400).send({ error: "Invalid or expired state" });
    }
    await prisma.oAuthState.delete({ where: { state: query.state } }).catch(() => undefined);

    try {
      const short = await exchangeCodeForToken({
        clientId: config.THREADS_APP_ID,
        clientSecret: config.THREADS_APP_SECRET,
        redirectUri: config.THREADS_REDIRECT_URI,
        code: query.code,
      });

      const account = await connectAccountFromShortLivedToken({
        shortLivedToken: short.access_token,
        scope: threadsScopes.join(","),
      });

      // Assign the new account to the user who initiated the flow (so a VA who
      // connects an account immediately manages it).
      if (stateRow.userId) {
        await assignAccount(stateRow.userId, account.id).catch(() => undefined);
      }

      logger.info({ accountId: account.id, username: account.username }, "Account connected");

      // Friendly HTML so the browser flow ends nicely.
      return reply
        .type("text/html")
        .send(
          `<html><body style="font-family:sans-serif;padding:2rem">` +
            `<h2>✅ Compte connecté</h2>` +
            `<p><b>@${account.username ?? account.threadsUserId}</b> est maintenant relié.</p>` +
            `<p>Account id: <code>${account.id}</code></p>` +
            `<p><a href="/">Retour au tableau de bord</a></p>` +
            `</body></html>`
        );
    } catch (err) {
      logger.error({ err: (err as Error).message }, "OAuth callback failed");
      return reply.code(500).send({ error: "OAuth exchange failed", detail: (err as Error).message });
    }
  });
}
