import path from "node:path";
import { buildDemoRuntime, TaskQueueWorker } from "../../../packages/orchestrator/src";
import { ConsoleLogger } from "../../../packages/observability/src";

const logger = new ConsoleLogger(true);
const workspaceRoot =
  process.env.OPENCLAW_WORKSPACE_ROOT ??
  path.resolve(process.cwd(), ".data", "tasks");
const pollIntervalMs = Number(process.env.OPENCLAW_WORKER_POLL_MS ?? 1_000);
const leaseTimeoutMs = Number(process.env.OPENCLAW_WORKER_LEASE_MS ?? 30_000);
const heartbeatIntervalMs = Number(
  process.env.OPENCLAW_WORKER_HEARTBEAT_MS ?? Math.max(1_000, Math.floor(leaseTimeoutMs / 3))
);
const runOnce = process.env.OPENCLAW_WORKER_ONCE === "1";

const sleep = async (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

async function main(): Promise<void> {
  const runtime = buildDemoRuntime(workspaceRoot, logger);
  const worker = new TaskQueueWorker(
    runtime.orchestrator,
    runtime.taskJobRepository,
    runtime.taskEventRepository,
    logger,
    undefined,
    leaseTimeoutMs,
    heartbeatIntervalMs
  );

  logger.info("Worker started", {
    pollIntervalMs,
    leaseTimeoutMs,
    heartbeatIntervalMs,
    dbMode: runtime.dbMode,
    agentMode: runtime.agentMode,
    toolMode: runtime.toolMode
  });

  do {
    const processed = await worker.runNextJob();
    if (runOnce) {
      break;
    }

    if (!processed) {
      await sleep(pollIntervalMs);
    }
  } while (true);

  await runtime.prisma?.$disconnect();
}

main().catch((error: unknown) => {
  console.error("Worker failed", error);
  process.exitCode = 1;
});
