import { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, assertAccountAccess, accountIdScope } from "../middleware/auth.js";
import { getAccountOrThrow } from "../services/accounts.js";
import { createAction, listActions } from "../services/actions.js";

const actionSchema = z.object({
  accountId: z.string(),
  type: z.enum(["REPLY"]).default("REPLY"),
  targetId: z.string(),
  text: z.string().optional(),
  scheduledAt: z.string().datetime().optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
});

export async function actionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // Queue an action (currently: reply to a post/comment).
  app.post("/api/actions", async (req, reply) => {
    const parsed = actionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid body", issues: parsed.error.issues });
    }
    assertAccountAccess(req, parsed.data.accountId);
    await getAccountOrThrow(parsed.data.accountId);
    const action = await createAction(parsed.data);
    return reply.code(201).send({ action });
  });

  // Convenience shortcut for replies (the common case).
  app.post("/api/replies", async (req, reply) => {
    const body = req.body as { accountId?: string; targetId?: string; text?: string; scheduledAt?: string };
    const parsed = actionSchema.safeParse({ ...body, type: "REPLY" });
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid body", issues: parsed.error.issues });
    }
    assertAccountAccess(req, parsed.data.accountId);
    await getAccountOrThrow(parsed.data.accountId);
    const action = await createAction(parsed.data);
    return reply.code(201).send({ action });
  });

  app.get("/api/actions", async (req) => {
    const q = req.query as { accountId?: string; status?: string };
    if (q.accountId) assertAccountAccess(req, q.accountId);
    return {
      actions: await listActions({ accountId: q.accountId, status: q.status, accountIds: accountIdScope(req) }),
    };
  });
}
