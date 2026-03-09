import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";

import { BenchmarkRunStatus } from "../../core/src/index.js";
import { buildDemoRuntime } from "../../orchestrator/src/index.js";
import { ConsoleLogger } from "../../observability/src/index.js";
import { runBenchmarkSuite } from "../src/index.js";

test("benchmark runner auto-approves approval workflow cases and records a completed run", async () => {
  const workspaceRoot = path.join(
    process.cwd(),
    ".tmp-evals",
    `approval-${Date.now().toString(36)}`
  );

  await fs.mkdir(workspaceRoot, { recursive: true });
  const runtime = buildDemoRuntime(workspaceRoot, new ConsoleLogger(false));

  const run = await runBenchmarkSuite(runtime, {
    suite: "full",
    caseIds: ["approval_webhook_delivery"]
  });

  assert.equal(run.status, BenchmarkRunStatus.Completed);
  const runItems = await runtime.benchmarkRunItemRepository.listByRun(run.id);
  assert.equal(runItems.length, 1);
  assert.equal(runItems[0]?.completed, true);
});
