import { FastifyReply, FastifyRequest } from "fastify";
import { Role } from "@prisma/client";
import { validateApiKey } from "../services/apikeys.js";
import { validateSession } from "../services/users.js";

export const SESSION_COOKIE = "sid";

/** The authenticated principal attached to each request as `req.auth`. */
export type AuthContext =
  | { type: "user"; userId: string; username: string; role: Role; accountIds: Set<string> }
  | { type: "apikey"; role: "ADMIN" };

function getAuth(req: FastifyRequest): AuthContext | undefined {
  return (req as any).auth;
}

/**
 * Authenticate a request via session cookie (humans) OR API key (machines).
 * Session is tried first; API keys are treated as full-access (admin) machines.
 * Attaches `req.auth`. Replies 401 if neither credential is valid.
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // 1. Session cookie (web UI).
  const token = (req as any).cookies?.[SESSION_COOKIE];
  if (typeof token === "string" && token.length > 0) {
    const user = await validateSession(token);
    if (user) {
      (req as any).auth = {
        type: "user",
        userId: user.id,
        username: user.username,
        role: user.role,
        accountIds: new Set(user.accountIds),
      } satisfies AuthContext;
      return;
    }
  }

  // 2. API key (machines / n8n).
  const header = req.headers["x-api-key"];
  const authz = req.headers["authorization"];
  let raw: string | undefined;
  if (typeof header === "string" && header.length > 0) raw = header;
  else if (typeof authz === "string" && authz.toLowerCase().startsWith("bearer ")) {
    raw = authz.slice(7).trim();
  }
  if (raw) {
    const key = await validateApiKey(raw);
    if (key) {
      (req as any).apiKeyId = key.id;
      (req as any).auth = { type: "apikey", role: "ADMIN" } satisfies AuthContext;
      return;
    }
  }

  await reply.code(401).send({ error: "Authentication required" });
}

/** preHandler: require the authenticated principal to be an admin (or a machine). */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = getAuth(req);
  if (!auth || auth.role !== "ADMIN") {
    await reply.code(403).send({ error: "Admin access required" });
  }
}

/** True if the principal has full (admin/machine) access. */
export function isAdmin(req: FastifyRequest): boolean {
  return getAuth(req)?.role === "ADMIN";
}

/** True if the principal may act on the given account. */
export function canAccessAccount(req: FastifyRequest, accountId: string): boolean {
  const auth = getAuth(req);
  if (!auth) return false;
  if (auth.role === "ADMIN") return true;
  return auth.type === "user" && auth.accountIds.has(accountId);
}

/** Throw a 403 unless the principal may act on the given account. */
export function assertAccountAccess(req: FastifyRequest, accountId: string): void {
  if (!canAccessAccount(req, accountId)) {
    const err = new Error("You don't have access to this account");
    (err as any).statusCode = 403;
    throw err;
  }
}

/**
 * Prisma `where` fragment scoping a query to the accounts the principal may see.
 * Admin/machine → undefined (no restriction). VA → { in: assignedIds }.
 */
export function accountIdScope(req: FastifyRequest): { in: string[] } | undefined {
  const auth = getAuth(req);
  if (!auth || auth.role === "ADMIN") return undefined;
  return { in: auth.type === "user" ? [...auth.accountIds] : [] };
}

/** The current user id (for assignment), or null for a machine principal. */
export function currentUserId(req: FastifyRequest): string | null {
  const auth = getAuth(req);
  return auth?.type === "user" ? auth.userId : null;
}
