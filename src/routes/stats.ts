import { FastifyInstance } from "fastify";
import { authenticate, assertAccountAccess, accountIdScope } from "../middleware/auth.js";
import { getAccountOrThrow } from "../services/accounts.js";
import { getAccountStats, getOverview } from "../services/stats.js";

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // Overview counts. VAs see only their assigned accounts.
  app.get("/api/stats/overview", async (req) => {
    return getOverview(accountIdScope(req));
  });

  // Per-account stats panel (Threads insights + DB-managed jobs).
  app.get("/api/accounts/:id/stats", async (req) => {
    const { id } = req.params as { id: string };
    assertAccountAccess(req, id);
    const q = req.query as { days?: string };
    const days = Math.min(Math.max(Number(q.days) || 30, 1), 90);
    const account = await getAccountOrThrow(id);
    return getAccountStats(account, days);
  });
}
