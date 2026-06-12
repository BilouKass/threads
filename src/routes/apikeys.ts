import { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireAdmin } from "../middleware/auth.js";
import { createApiKey, listApiKeys, revokeApiKey } from "../services/apikeys.js";

export async function apiKeyRoutes(app: FastifyInstance): Promise<void> {
  // API keys are for machines and are managed by admins only.
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireAdmin);

  app.get("/api/keys", async () => {
    return { keys: await listApiKeys() };
  });

  app.post("/api/keys", async (req, reply) => {
    const body = z.object({ name: z.string().min(1) }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "name is required" });
    }
    const key = await createApiKey(body.data.name);
    // raw is returned exactly once.
    return reply.code(201).send({ id: key.id, prefix: key.prefix, key: key.raw });
  });

  app.delete("/api/keys/:id", async (req) => {
    const { id } = req.params as { id: string };
    await revokeApiKey(id);
    return { ok: true };
  });
}
