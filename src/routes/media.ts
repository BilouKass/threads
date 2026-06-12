import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { FastifyInstance } from "fastify";
import {
  UPLOAD_DIR,
  FILENAME_RE,
  verifySignedRequest,
  mimeForFilename,
} from "../services/media.js";

/**
 * Public, signed media route. NO API key: Meta's servers fetch these URLs to
 * download images during publishing. Access requires a valid, unexpired HMAC
 * signature, so the links are unguessable and temporary.
 *   GET /media/:filename?exp=<ms>&sig=<hmac>
 */
export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  app.get("/media/:filename", async (req, reply) => {
    const { filename } = req.params as { filename: string };
    const { exp, sig } = req.query as { exp?: string; sig?: string };

    // Guard against path traversal / unexpected names.
    if (!FILENAME_RE.test(filename)) {
      return reply.code(404).send({ error: "Not found" });
    }

    const check = verifySignedRequest(filename, exp, sig);
    if (check === "invalid") return reply.code(403).send({ error: "Invalid signature" });
    if (check === "expired") return reply.code(410).send({ error: "Link expired" });

    const full = path.join(UPLOAD_DIR, filename);
    const s = await stat(full).catch(() => null);
    if (!s || !s.isFile()) return reply.code(404).send({ error: "Not found" });

    reply.header("Content-Type", mimeForFilename(filename));
    reply.header("Content-Length", String(s.size));
    reply.header("Cache-Control", "no-store");
    return reply.send(createReadStream(full));
  });
}
