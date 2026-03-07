import { execSync } from "node:child_process";
import { createPrismaRepositories } from "../packages/db/src";

async function main(): Promise<void> {
  execSync("npx prisma db push --skip-generate", {
    stdio: "inherit",
    cwd: process.cwd()
  });

  const repositories = createPrismaRepositories(process.env.DATABASE_URL);

  try {
    await repositories.userProfileRepository.getByUserId("__bootstrap__");
    console.log("Prisma SQLite schema initialized.");
  } finally {
    await repositories.prisma?.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("Failed to initialize database", error);
  process.exitCode = 1;
});
