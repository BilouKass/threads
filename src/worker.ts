import { logger } from "./logger.js";
import { prisma, disconnect } from "./db.js";
import { startScheduler, stopScheduler } from "./scheduler/scheduler.js";

async function main(): Promise<void> {
  await prisma.$connect();
  logger.info("Worker connected to DB");
  startScheduler();

  const shutdown = async () => {
    logger.info("Shutting down worker...");
    stopScheduler();
    await disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error({ err }, "Fatal error starting worker");
  process.exit(1);
});
