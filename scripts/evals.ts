import path from "node:path";
import { buildDemoRuntime } from "../packages/orchestrator/src";
import { listBenchmarkCases, runBenchmarkSuite } from "../packages/evals/src";

const parseArgs = () => {
  const args = process.argv.slice(2);
  let suite = "smoke";
  let caseIds: string[] | undefined;
  let writeBaseline = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--suite") {
      suite = args[index + 1] ?? suite;
      index += 1;
      continue;
    }
    if (arg === "--case") {
      const caseId = args[index + 1];
      if (caseId) {
        caseIds = [caseId];
      }
      index += 1;
      continue;
    }
    if (arg === "--list") {
      return { listOnly: true, suite, caseIds, writeBaseline };
    }
    if (arg === "--write-baseline") {
      writeBaseline = true;
      continue;
    }
  }

  return { listOnly: false, suite, caseIds, writeBaseline };
};

const main = async (): Promise<void> => {
  const parsed = parseArgs();
  if (parsed.listOnly) {
    for (const benchmarkCase of listBenchmarkCases()) {
      process.stdout.write(`${benchmarkCase.id}\t${benchmarkCase.suite}\t${benchmarkCase.name}\n`);
    }
    return;
  }

  const runtime = buildDemoRuntime(path.resolve(process.cwd(), ".data", "tasks-evals"));
  const run = await runBenchmarkSuite(runtime, {
    ...(parsed.caseIds ? { caseIds: parsed.caseIds } : { suite: parsed.suite }),
    ...(parsed.writeBaseline ? { writeBaseline: true } : {}),
    name: parsed.caseIds?.length
      ? `benchmark case ${parsed.caseIds[0]}`
      : `benchmark suite ${parsed.suite}`
  });

  process.stdout.write(JSON.stringify(run, null, 2));
  process.stdout.write("\n");
};

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
