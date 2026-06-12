import { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, assertAccountAccess } from "../middleware/auth.js";
import { prisma } from "../db.js";
import { getAccountOrThrow } from "../services/accounts.js";
import { listSlots, addSlot, deleteSlot, addToQueue, nextQueueTime } from "../services/queue.js";

const mediaItem = z.object({ type: z.enum(["IMAGE", "VIDEO"]), url: z.string().url() });

export async function queueRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // ---- Recurring posting slots ----
  app.get("/api/accounts/:id/slots", async (req) => {
    const { id } = req.params as { id: string };
    assertAccountAccess(req, id);
    await getAccountOrThrow(id);
    return { slots: await listSlots(id) };
  });

  app.post("/api/accounts/:id/slots", async (req, reply) => {
    const { id } = req.params as { id: string };
    assertAccountAccess(req, id);
    const schema = z.object({
      dayOfWeek: z.number().int().min(0).max(6),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", issues: parsed.error.issues });
    await getAccountOrThrow(id);
    const slot = await addSlot({ accountId: id, ...parsed.data });
    return reply.code(201).send({ slot });
  });

  app.delete("/api/slots/:slotId", async (req, reply) => {
    const { slotId } = req.params as { slotId: string };
    const slot = await prisma.queueSlot.findUnique({ where: { id: slotId } });
    if (!slot) return reply.code(404).send({ error: "Slot not found" });
    assertAccountAccess(req, slot.accountId);
    await deleteSlot(slotId);
    return { ok: true };
  });

  // ---- Add a post to the queue (auto next free slot) ----
  app.post("/api/accounts/:id/queue", async (req, reply) => {
    const { id } = req.params as { id: string };
    assertAccountAccess(req, id);
    const schema = z.object({
      text: z.string().optional(),
      media: z.array(mediaItem).max(20).optional(),
      imageUrls: z.array(z.string().url()).max(20).optional(),
      videoUrls: z.array(z.string().url()).max(20).optional(),
      poll: z
        .object({
          optionA: z.string().min(1).max(25),
          optionB: z.string().min(1).max(25),
          optionC: z.string().min(1).max(25).optional(),
          optionD: z.string().min(1).max(25).optional(),
        })
        .optional(),
      spoilers: z
        .array(z.object({ offset: z.number().int().min(0), length: z.number().int().min(1) }))
        .max(10)
        .optional(),
      isSpoilerMedia: z.boolean().optional(),
      maxAttempts: z.number().int().min(1).max(10).optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", issues: parsed.error.issues });
    await getAccountOrThrow(id);
    const post = await addToQueue({ accountId: id, ...parsed.data });
    return reply.code(201).send({ post, scheduledAt: post.scheduledAt });
  });

  // Peek the next free slot without scheduling anything.
  app.get("/api/accounts/:id/queue/next", async (req) => {
    const { id } = req.params as { id: string };
    assertAccountAccess(req, id);
    await getAccountOrThrow(id);
    return { nextSlot: await nextQueueTime(id) };
  });
}
