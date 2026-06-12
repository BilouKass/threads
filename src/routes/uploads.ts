import path from "node:path";
import { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.js";
import { saveUpload, isAllowedExt, mediaTypeForExt } from "../services/media.js";

/**
 * Image upload endpoint. The file is stored privately and exposed only through a
 * signed, expiring /media URL (so it's unguessable + temporary). After the post
 * is published the file is deleted automatically (see scheduler).
 *
 * Returns: { url, expiresAt } — feed `url` into POST /api/posts imageUrls.
 */
export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  app.post("/api/uploads", async (req, reply) => {
    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: "No file provided (multipart field 'file')" });
    }
    const ext = path.extname(file.filename).toLowerCase();
    if (!isAllowedExt(ext)) {
      return reply.code(400).send({ error: `Unsupported file type ${ext}` });
    }

    const { url, expiresAt } = await saveUpload(file.file, ext);

    if (file.file.truncated) {
      return reply.code(413).send({ error: "File too large" });
    }

    // type tells the caller how to reference it in a post's media array.
    return reply.code(201).send({ url, type: mediaTypeForExt(ext), expiresAt });
  });
}
