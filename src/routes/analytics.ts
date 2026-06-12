import { FastifyInstance } from "fastify";
import { authenticate, assertAccountAccess } from "../middleware/auth.js";
import { getAccountOrThrow } from "../services/accounts.js";
import { getAnalytics, getPostAnalytics, captureSnapshot, capturePostInsights } from "../services/analytics.js";

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // Time-series analytics (followers growth + engagement) from stored snapshots.
  app.get("/api/accounts/:id/analytics", async (req) => {
    const { id } = req.params as { id: string };
    assertAccountAccess(req, id);
    const q = req.query as { days?: string };
    const days = Math.min(Math.max(Number(q.days) || 30, 1), 365);
    await getAccountOrThrow(id);
    return getAnalytics(id, days);
  });

  // Per-post insights, ranked by views.
  app.get("/api/accounts/:id/posts-insights", async (req) => {
    const { id } = req.params as { id: string };
    assertAccountAccess(req, id);
    await getAccountOrThrow(id);
    return { posts: await getPostAnalytics(id) };
  });

  // Trigger an immediate capture (otherwise runs every 12h in the worker).
  app.post("/api/accounts/:id/analytics/capture", async (req) => {
    const { id } = req.params as { id: string };
    assertAccountAccess(req, id);
    const account = await getAccountOrThrow(id);
    await captureSnapshot(account);
    await capturePostInsights(account);
    return { ok: true };
  });
}
