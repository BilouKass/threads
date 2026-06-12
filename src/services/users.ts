import { scryptSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { Role, User } from "@prisma/client";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

// ---- Password hashing (scrypt, no external dependency) ----

/** Hash a password with a random salt. Returns "saltHex:hashHex". */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** Constant-time verify a password against a stored "saltHex:hashHex". */
export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const test = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === test.length && timingSafeEqual(expected, test);
}

function badRequest(message: string, code = 400): never {
  const err = new Error(message);
  (err as any).statusCode = code;
  throw err;
}

// ---- Users ----

export async function createUser(params: {
  username: string;
  password: string;
  role?: Role;
}): Promise<User> {
  const username = params.username.trim();
  if (username.length < 3) badRequest("username must be at least 3 characters");
  if (params.password.length < 6) badRequest("password must be at least 6 characters");
  const exists = await prisma.user.findUnique({ where: { username } });
  if (exists) badRequest("username already taken", 409);
  return prisma.user.create({
    data: { username, passwordHash: hashPassword(params.password), role: params.role ?? "VA" },
  });
}

export async function listUsers() {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    include: { accounts: { select: { accountId: true } } },
  });
  return users.map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    disabled: u.disabled,
    accountIds: u.accounts.map((a) => a.accountId),
    createdAt: u.createdAt,
  }));
}

export async function updateUser(
  id: string,
  data: { role?: Role; disabled?: boolean; password?: string }
) {
  const patch: Record<string, unknown> = {};
  if (data.role) patch.role = data.role;
  if (typeof data.disabled === "boolean") patch.disabled = data.disabled;
  if (data.password) {
    if (data.password.length < 6) badRequest("password must be at least 6 characters");
    patch.passwordHash = hashPassword(data.password);
  }
  return prisma.user.update({ where: { id }, data: patch });
}

export async function deleteUser(id: string) {
  return prisma.user.delete({ where: { id } });
}

/** Verify credentials. Returns the user on success, or null. */
export async function login(username: string, password: string): Promise<User | null> {
  const user = await prisma.user.findUnique({ where: { username: username.trim() } });
  if (!user || user.disabled) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return user;
}

// ---- Sessions ----

function sessionId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Create a session for a user. Returns the raw cookie token + expiry. */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_DAYS * 86_400_000);
  await prisma.session.create({ data: { id: sessionId(token), userId, expiresAt } });
  return { token, expiresAt };
}

export interface AuthedUser {
  id: string;
  username: string;
  role: Role;
  /** Assigned account ids (VA only; empty for admin who sees all). */
  accountIds: string[];
}

/** Validate a session token. Returns the user + assigned accounts, or null. */
export async function validateSession(token: string): Promise<AuthedUser | null> {
  const s = await prisma.session.findUnique({
    where: { id: sessionId(token) },
    include: { user: true },
  });
  if (!s || s.expiresAt < new Date() || s.user.disabled) return null;
  let accountIds: string[] = [];
  if (s.user.role === "VA") {
    const assigns = await prisma.userAccount.findMany({ where: { userId: s.userId } });
    accountIds = assigns.map((a) => a.accountId);
  }
  return { id: s.user.id, username: s.user.username, role: s.user.role, accountIds };
}

export async function destroySession(token: string): Promise<void> {
  await prisma.session.delete({ where: { id: sessionId(token) } }).catch(() => undefined);
}

// ---- Account assignments ----

export async function assignAccount(userId: string, accountId: string) {
  return prisma.userAccount.upsert({
    where: { userId_accountId: { userId, accountId } },
    create: { userId, accountId },
    update: {},
  });
}

export async function unassignAccount(userId: string, accountId: string) {
  return prisma.userAccount
    .delete({ where: { userId_accountId: { userId, accountId } } })
    .catch(() => undefined);
}

export async function getAssignedAccountIds(userId: string): Promise<string[]> {
  const rows = await prisma.userAccount.findMany({ where: { userId } });
  return rows.map((r) => r.accountId);
}

// ---- Bootstrap ----

/**
 * Create the first admin from ADMIN_USERNAME/ADMIN_PASSWORD if no admin exists.
 * Logs a warning if there is no admin and no bootstrap password configured.
 */
export async function ensureAdmin(): Promise<void> {
  const adminCount = await prisma.user.count({ where: { role: "ADMIN", disabled: false } });
  if (adminCount > 0) return;

  if (!config.ADMIN_PASSWORD) {
    logger.warn(
      "No admin user exists and ADMIN_PASSWORD is not set. " +
        "Set ADMIN_USERNAME/ADMIN_PASSWORD in .env (or run: npm run seed:user) to create one."
    );
    return;
  }
  const existing = await prisma.user.findUnique({ where: { username: config.ADMIN_USERNAME } });
  if (existing) {
    // Promote/enable the existing user to admin.
    await prisma.user.update({
      where: { id: existing.id },
      data: { role: "ADMIN", disabled: false },
    });
    return;
  }
  await createUser({
    username: config.ADMIN_USERNAME,
    password: config.ADMIN_PASSWORD,
    role: "ADMIN",
  });
  logger.warn(`Created admin user "${config.ADMIN_USERNAME}" from ADMIN_PASSWORD.`);
}
