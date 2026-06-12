import { FastifyInstance } from "fastify";
import { authenticate, accountIdScope, assertAccountAccess } from "../middleware/auth.js";
import {
  listAccounts,
  getAccountOrThrow,
  setDisabled,
  deleteAccount,
} from "../services/accounts.js";
import { refreshAccount } from "../services/tokens.js";

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // VAs only see their assigned accounts; admins see all.
  app.get("/api/accounts", async (req) => {
    return { accounts: await listAccounts(accountIdScope(req)) };
  });

  app.post("/api/accounts/:id/refresh", async (req, reply) => {
    const { id } = req.params as { id: string };
    assertAccountAccess(req, id);
    const account = await getAccountOrThrow(id);
    await refreshAccount(account);
    reply.send({ ok: true });
  });

  app.patch("/api/accounts/:id", async (req) => {
    const { id } = req.params as { id: string };
    assertAccountAccess(req, id);
    const body = req.body as { disabled?: boolean };
    await getAccountOrThrow(id);
    const updated = await setDisabled(id, Boolean(body.disabled));
    return { ok: true, disabled: updated.disabled };
  });

  app.delete("/api/accounts/:id", async (req) => {
    const { id } = req.params as { id: string };
    assertAccountAccess(req, id);
    await getAccountOrThrow(id);
    await deleteAccount(id);
    return { ok: true };
  });
}
