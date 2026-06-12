import { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, assertAccountAccess, accountIdScope } from "../middleware/auth.js";
import { prisma } from "../db.js";
import { getAccountOrThrow } from "../services/accounts.js";
import {
  schedulePost,
  schedulePostsBulk,
  scheduleChain,
  listPosts,
  cancelPost,
} from "../services/posts.js";

const mediaItem = z.object({ type: z.enum(["IMAGE", "VIDEO"]), url: z.string().url() });
const pollSchema = z.object({
  optionA: z.string().min(1).max(25),
  optionB: z.string().min(1).max(25),
  optionC: z.string().min(1).max(25).optional(),
  optionD: z.string().min(1).max(25).optional(),
});
const spoilersSchema = z
  .array(z.object({ offset: z.number().int().min(0), length: z.number().int().min(1) }))
  .max(10);

const postBody = z.object({
  accountId: z.string(),
  text: z.string().optional(),
  media: z.array(mediaItem).max(20).optional(),
  imageUrls: z.array(z.string().url()).max(20).optional(),
  videoUrls: z.array(z.string().url()).max(20).optional(),
  poll: pollSchema.optional(),
  spoilers: spoilersSchema.optional(),
  isSpoilerMedia: z.boolean().optional(),
  scheduledAt: z.string().datetime().optional(),
  replyToId: z.string().optional(),
  linkAttachment: z.string().url().optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
});

export async function postRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // Schedule (or immediately queue) a single post — text, image, video, or carousel.
  app.post("/api/posts", async (req, reply) => {
    const parsed = postBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid body", issues: parsed.error.issues });
    }
    assertAccountAccess(req, parsed.data.accountId);
    await getAccountOrThrow(parsed.data.accountId);
    const post = await schedulePost(parsed.data);
    return reply.code(201).send({ post });
  });

  // Bulk-create posts in one call.
  app.post("/api/posts/bulk", async (req, reply) => {
    const schema = z.object({ posts: z.array(postBody).min(1).max(200) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid body", issues: parsed.error.issues });
    }
    // Validate access + existence for every distinct account (dedup).
    const ids = [...new Set(parsed.data.posts.map((p) => p.accountId))];
    ids.forEach((id) => assertAccountAccess(req, id));
    await Promise.all(ids.map((id) => getAccountOrThrow(id)));
    const posts = await schedulePostsBulk(parsed.data.posts);
    return reply.code(201).send({ count: posts.length, posts });
  });

  // Create a chain (enchaînement): ordered posts, each a reply to the previous.
  app.post("/api/posts/chain", async (req, reply) => {
    const schema = z.object({
      accountId: z.string(),
      scheduledAt: z.string().datetime().optional(),
      maxAttempts: z.number().int().min(1).max(10).optional(),
      posts: z
        .array(
          z.object({
            text: z.string().optional(),
            media: z.array(mediaItem).max(20).optional(),
            imageUrls: z.array(z.string().url()).max(20).optional(),
            videoUrls: z.array(z.string().url()).max(20).optional(),
            poll: pollSchema.optional(),
            spoilers: spoilersSchema.optional(),
            isSpoilerMedia: z.boolean().optional(),
          })
        )
        .min(1)
        .max(50),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid body", issues: parsed.error.issues });
    }
    assertAccountAccess(req, parsed.data.accountId);
    await getAccountOrThrow(parsed.data.accountId);
    const posts = await scheduleChain(parsed.data);
    return reply.code(201).send({ chainId: posts[0].chainId, count: posts.length, posts });
  });

  app.get("/api/posts", async (req) => {
    const q = req.query as { accountId?: string; status?: string };
    if (q.accountId) assertAccountAccess(req, q.accountId);
    return {
      posts: await listPosts({ accountId: q.accountId, status: q.status, accountIds: accountIdScope(req) }),
    };
  });

  app.post("/api/posts/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.scheduledPost.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Post not found" });
    assertAccountAccess(req, existing.accountId);
    const post = await cancelPost(id);
    return { ok: true, post };
  });
}
