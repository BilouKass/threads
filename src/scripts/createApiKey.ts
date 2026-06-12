import { prisma, disconnect } from "../db.js";
import { createApiKey } from "../services/apikeys.js";

async function main(): Promise<void> {
  const name = process.argv.slice(2).join(" ") || "unnamed key";
  await prisma.$connect();
  const key = await createApiKey(name);
  // eslint-disable-next-line no-console
  console.log(`Created API key "${name}":\n\n  ${key.raw}\n\n(prefix ${key.prefix}) — store it now, it won't be shown again.`);
  await disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
