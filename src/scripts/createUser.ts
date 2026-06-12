import { prisma, disconnect } from "../db.js";
import { createUser } from "../services/users.js";

/**
 * CLI: create a user.
 *   npm run seed:user -- <username> <password> [admin|va]
 */
async function main(): Promise<void> {
  const [username, password, roleArg] = process.argv.slice(2);
  if (!username || !password) {
    // eslint-disable-next-line no-console
    console.error('Usage: npm run seed:user -- <username> <password> [admin|va]');
    process.exit(1);
  }
  const role = (roleArg ?? "admin").toLowerCase() === "va" ? "VA" : "ADMIN";
  await prisma.$connect();
  const user = await createUser({ username, password, role });
  // eslint-disable-next-line no-console
  console.log(`Created ${user.role} user "${user.username}" (id ${user.id}).`);
  await disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err.message ?? err);
  process.exit(1);
});
