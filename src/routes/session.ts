import { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { login, createSession, destroySession } from "../services/users.js";
import { authenticate, SESSION_COOKIE } from "../middleware/auth.js";

/**
 * Web-UI authentication: login (public), logout & me (authenticated).
 *   POST /auth/login   { username, password }  -> sets the session cookie
 *   POST /auth/logout
 *   GET  /auth/me      -> current user + role (or 401)
 */
export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/login", async (req, reply) => {
    const body = z.object({ username: z.string(), password: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "username and password required" });

    const user = await login(body.data.username, body.data.password);
    if (!user) return reply.code(401).send({ error: "Identifiants invalides" });

    const { token, expiresAt } = await createSession(user.id);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.COOKIE_SECURE,
      path: "/",
      expires: expiresAt,
    });
    return { user: { id: user.id, username: user.username, role: user.role } };
  });

  app.post("/auth/logout", { preHandler: authenticate }, async (req, reply) => {
    const token = (req as any).cookies?.[SESSION_COOKIE];
    if (token) await destroySession(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/auth/me", { preHandler: authenticate }, async (req) => {
    const auth = (req as any).auth;
    if (auth.type === "apikey") return { type: "apikey", role: "ADMIN" };
    return {
      type: "user",
      id: auth.userId,
      username: auth.username,
      role: auth.role,
      accountIds: [...auth.accountIds],
    };
  });
}
