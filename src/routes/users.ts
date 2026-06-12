import { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireAdmin } from "../middleware/auth.js";
import { getAccountOrThrow } from "../services/accounts.js";
import {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  assignAccount,
  unassignAccount,
  getAssignedAccountIds,
} from "../services/users.js";

/** User & assignment management — ADMIN only. */
export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireAdmin);

  app.get("/api/users", async () => {
    return { users: await listUsers() };
  });

  app.post("/api/users", async (req, reply) => {
    const body = z
      .object({
        username: z.string().min(3),
        password: z.string().min(6),
        role: z.enum(["ADMIN", "VA"]).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid body", issues: body.error.issues });
    const user = await createUser(body.data);
    return reply.code(201).send({ user: { id: user.id, username: user.username, role: user.role } });
  });

  app.patch("/api/users/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        role: z.enum(["ADMIN", "VA"]).optional(),
        disabled: z.boolean().optional(),
        password: z.string().min(6).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid body", issues: body.error.issues });
    await updateUser(id, body.data);
    return { ok: true };
  });

  app.delete("/api/users/:id", async (req) => {
    const { id } = req.params as { id: string };
    await deleteUser(id);
    return { ok: true };
  });

  // ---- Account assignments (which Threads accounts a VA manages) ----
  app.get("/api/users/:id/accounts", async (req) => {
    const { id } = req.params as { id: string };
    return { accountIds: await getAssignedAccountIds(id) };
  });

  app.post("/api/users/:id/accounts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ accountId: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "accountId required" });
    await getAccountOrThrow(body.data.accountId);
    await assignAccount(id, body.data.accountId);
    return reply.code(201).send({ ok: true });
  });

  app.delete("/api/users/:id/accounts/:accountId", async (req) => {
    const { id, accountId } = req.params as { id: string; accountId: string };
    await unassignAccount(id, accountId);
    return { ok: true };
  });
}
