import path from "node:path";
import { promises as fs } from "node:fs";
import {
  ArtifactType,
  BenchmarkRun,
  BenchmarkRunItem,
  BenchmarkRunStatus,
  createDraftTask,
  Task,
  TaskStatus
} from "../../core/src";
import { createId, JsonObject, nowIso } from "../../shared/src";
import { TaskOrchestrator } from "../../orchestrator/src";

export interface BenchmarkCaseDefinition {
  id: string;
  name: string;
  suite: string;
  goal: string;
  recipeId?: string;
  userId?: string;
  fixtureUploads?: Array<{
    filename: string;
    relativePath: string;
    contentType?: string;
  }>;
}

export interface BenchmarkRuntime {
  orchestrator: TaskOrchestrator;
  taskRepository: {
    create(task: Task): Promise<Task>;
    getById(taskId: string): Promise<Task | undefined>;
  };
  artifactRepository: {
    save(artifact: {
      id: string;
      taskId: string;
      stepId?: string;
      type: ArtifactType;
      uri: string;
      title?: string;
      summary?: string;
      keywords?: string[];
      validated?: boolean;
      metadata: JsonObject;
      createdAt: string;
    }): Promise<unknown>;
  };
  benchmarkRunRepository: {
    create(run: BenchmarkRun): Promise<BenchmarkRun>;
    update(run: BenchmarkRun): Promise<BenchmarkRun>;
    getById(runId: string): Promise<BenchmarkRun | undefined>;
  };
  benchmarkRunItemRepository: {
    create(item: BenchmarkRunItem): Promise<BenchmarkRunItem>;
  };
  workspaceRoot: string;
}

interface BenchmarkCaseReport {
  caseId: string;
  name: string;
  suite: string;
  taskId: string;
  completed: boolean;
  qualityScore?: number;
  fallbackUsed: boolean;
  artifactValidated: boolean;
  latencyMs: number;
  failureCategory?: string;
  recipeId?: string;
}

interface BenchmarkReport {
  id: string;
  name: string;
  suite: string;
  status: BenchmarkRunStatus;
  startedAt?: string;
  completedAt?: string;
  generatedAt: string;
  summary: {
    totalCases: number;
    completedCount: number;
    failedCount: number;
    completedRate: number;
  };
  cases: BenchmarkCaseReport[];
}

const fixturesRoot = path.resolve(__dirname, "..", "fixtures");
type FixtureUpload = NonNullable<BenchmarkCaseDefinition["fixtureUploads"]>[number];

const BENCHMARK_CASES: BenchmarkCaseDefinition[] = [
  {
    id: "feasibility_perfume_uae",
    name: "阿联酋香水制造可行性报告",
    suite: "full",
    goal:
      "调研在阿联酋开设香水制造公司的可行性与落地路径，输出可执行报告。要求包含监管、设立路径、成本模型、供应链、渠道、时间线、风险与来源。",
    recipeId: "feasibility_report"
  },
  {
    id: "timeline_conflict_pdf",
    name: "战情时间线 PDF",
    suite: "full",
    goal: "做一个关于伊朗战争的最新简报带时间轴，输出 pdf",
    recipeId: "timeline_brief"
  },
  {
    id: "numbers_markdown",
    name: "数字分析 Markdown",
    suite: "smoke",
    goal: "用 Python 分析 12, 18, 25, 40 这四个数字，输出 JSON 和 markdown 摘要",
    recipeId: "dataset_analysis"
  },
  {
    id: "csv_to_pdf",
    name: "CSV 上传分析 PDF",
    suite: "smoke",
    goal: "读取上传的 CSV，输出关键发现、markdown 摘要并导出 PDF",
    recipeId: "dataset_analysis",
    fixtureUploads: [
      {
        filename: "sample-sales.csv",
        relativePath: "sample-sales.csv",
        contentType: "text/csv"
      }
    ]
  }
];

const cloneJsonObject = (value: JsonObject): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;

const computeTaskQualityScore = (task: Task): number | undefined => {
  const qualityScores = task.steps
    .map((step) => step.qualityScore)
    .filter((value): value is number => typeof value === "number");
  if (qualityScores.length === 0) {
    return undefined;
  }
  return Math.round(
    qualityScores.reduce((sum, value) => sum + value, 0) / qualityScores.length
  );
};

const buildBenchmarkStoragePaths = (
  runtime: BenchmarkRuntime,
  run: Pick<BenchmarkRun, "id" | "suite">
): { reportPath: string; baselinePath: string } => {
  const dataRoot = path.dirname(runtime.workspaceRoot);
  const evalRoot = path.join(dataRoot, "evals");
  const reportPath = path.join(evalRoot, run.id, "report.json");
  const baselinePath = path.join(evalRoot, "baselines", `${run.suite}.json`);

  return {
    reportPath,
    baselinePath
  };
};

const writeBenchmarkReport = async (
  runtime: BenchmarkRuntime,
  run: Pick<BenchmarkRun, "id" | "name" | "suite" | "status" | "startedAt" | "completedAt">,
  cases: BenchmarkCaseReport[],
  options: { writeBaseline?: boolean } = {}
): Promise<{ reportPath: string; baselinePath?: string }> => {
  const { reportPath, baselinePath } = buildBenchmarkStoragePaths(runtime, run);
  const completedCount = cases.filter((item) => item.completed).length;
  const report: BenchmarkReport = {
    id: run.id,
    name: run.name,
    suite: run.suite,
    status: run.status,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    generatedAt: nowIso(),
    summary: {
      totalCases: cases.length,
      completedCount,
      failedCount: cases.length - completedCount,
      completedRate: cases.length === 0 ? 0 : Number((completedCount / cases.length).toFixed(4))
    },
    cases
  };

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

  if (!options.writeBaseline) {
    return { reportPath };
  }

  await fs.mkdir(path.dirname(baselinePath), { recursive: true });
  await fs.writeFile(baselinePath, JSON.stringify(report, null, 2), "utf8");
  return { reportPath, baselinePath };
};

const getFailureCategory = (task: Task): string | undefined => {
  const failedStep = [...task.steps]
    .reverse()
    .find((step) => step.status === "FAILED" || step.status === "RETRYING");
  return failedStep?.error?.category ?? failedStep?.error?.code;
};

const createUploadedArtifact = async (
  runtime: BenchmarkRuntime,
  task: Task,
  fixture: FixtureUpload
): Promise<void> => {
  const sourcePath = path.join(fixturesRoot, fixture.relativePath);
  const uploadDir = path.join(runtime.workspaceRoot, task.id, "uploads");
  await fs.mkdir(uploadDir, { recursive: true });
  const destinationPath = path.join(uploadDir, fixture.filename);
  await fs.copyFile(sourcePath, destinationPath);

  await runtime.artifactRepository.save({
    id: createId("artifact"),
      taskId: task.id,
    type: ArtifactType.Spreadsheet,
    uri: destinationPath,
    title: fixture.filename,
    summary: `Benchmark fixture upload ${fixture.filename}`,
    keywords: ["benchmark", "upload", "fixture"],
    validated: true,
    metadata: cloneJsonObject({
      uploaded: true,
      originalFilename: fixture.filename,
      contentType: fixture.contentType ?? "application/octet-stream",
      benchmarkFixture: true
    }),
    createdAt: nowIso()
  });
};

const prepareBenchmarkTask = async (
  runtime: BenchmarkRuntime,
  benchmarkCase: BenchmarkCaseDefinition
): Promise<Task> => {
  const task = createDraftTask(
    benchmarkCase.userId ?? "eval_runner",
    benchmarkCase.goal,
    undefined,
    benchmarkCase.recipeId ? { recipeId: benchmarkCase.recipeId } : {}
  );
  const created = await runtime.taskRepository.create(task);
  if (benchmarkCase.fixtureUploads?.length) {
    for (const fixture of benchmarkCase.fixtureUploads) {
      await createUploadedArtifact(runtime, created, fixture);
    }
  }
  await runtime.orchestrator.prepareTaskById(created.id);
  return created;
};

export const listBenchmarkCases = (): BenchmarkCaseDefinition[] => [...BENCHMARK_CASES];

export const getBenchmarkCaseById = (
  caseId: string
): BenchmarkCaseDefinition | undefined => BENCHMARK_CASES.find((item) => item.id === caseId);

export const selectBenchmarkCases = (options: {
  suite?: string;
  caseIds?: string[];
}): BenchmarkCaseDefinition[] => {
  if (Array.isArray(options.caseIds) && options.caseIds.length > 0) {
    return options.caseIds
      .map((caseId) => getBenchmarkCaseById(caseId))
      .filter((item): item is BenchmarkCaseDefinition => Boolean(item));
  }
  if (options.suite) {
    return BENCHMARK_CASES.filter((item) => item.suite === options.suite || options.suite === "all");
  }
  return BENCHMARK_CASES.filter((item) => item.suite === "smoke");
};

export const runBenchmarkSuite = async (
  runtime: BenchmarkRuntime,
  options: {
    run?: BenchmarkRun;
    name?: string;
    suite?: string;
    caseIds?: string[];
    userId?: string;
    writeBaseline?: boolean;
  } = {}
): Promise<BenchmarkRun> => {
  const cases = selectBenchmarkCases({
    ...(options.suite ? { suite: options.suite } : {}),
    ...(options.caseIds ? { caseIds: options.caseIds } : {})
  });
  if (cases.length === 0) {
    throw new Error("No benchmark cases selected");
  }

  let run =
    options.run ??
    (await runtime.benchmarkRunRepository.create({
      id: createId("bench"),
      name: options.name ?? `benchmark ${options.suite ?? "smoke"}`,
      suite: options.suite ?? "smoke",
      status: BenchmarkRunStatus.Pending,
      startedAt: nowIso(),
      createdAt: nowIso(),
      metadata: {
        caseIds: cases.map((item) => item.id)
      }
    }));

  run = await runtime.benchmarkRunRepository.update({
    ...run,
    status: BenchmarkRunStatus.Running,
    startedAt: nowIso(),
    metadata: {
      ...run.metadata,
      caseIds: cases.map((item) => item.id)
    }
  });

  let completedCount = 0;
  const caseReports: BenchmarkCaseReport[] = [];
  try {
    for (const benchmarkCase of cases) {
      const startedAt = Date.now();
      const preparedTask = await prepareBenchmarkTask(runtime, {
        ...benchmarkCase,
        ...(options.userId ? { userId: options.userId } : {})
      });
      const finalTask = await runtime.orchestrator.runTaskById(preparedTask.id);
      const completed = finalTask.status === TaskStatus.Completed;
      if (completed) {
        completedCount += 1;
      }
      const fallbackUsed = finalTask.steps.some(
        (step) => step.structuredData["llmFallbackUsed"] === true
      );
      const artifactValidated = finalTask.finalArtifactValidation?.validated ?? false;
      const qualityScore = computeTaskQualityScore(finalTask);
      const failureCategory = getFailureCategory(finalTask);
      caseReports.push({
        caseId: benchmarkCase.id,
        name: benchmarkCase.name,
        suite: benchmarkCase.suite,
        taskId: finalTask.id,
        completed,
        ...(typeof qualityScore === "number" ? { qualityScore } : {}),
        fallbackUsed,
        artifactValidated,
        latencyMs: Date.now() - startedAt,
        ...(failureCategory ? { failureCategory } : {}),
        ...(benchmarkCase.recipeId ? { recipeId: benchmarkCase.recipeId } : {})
      });
      await runtime.benchmarkRunItemRepository.create({
        id: createId("benchitem"),
        benchmarkRunId: run.id,
        caseId: benchmarkCase.id,
        taskId: finalTask.id,
        completed,
        ...(typeof qualityScore === "number" ? { qualityScore } : {}),
        fallbackUsed,
        artifactValidated,
        latencyMs: Date.now() - startedAt,
        ...(failureCategory ? { failureCategory } : {}),
        createdAt: nowIso(),
        metadata: {
          suite: benchmarkCase.suite,
          recipeId: benchmarkCase.recipeId ?? null
        }
      });
    }

    const finalizedRun = await runtime.benchmarkRunRepository.update({
      ...run,
      status:
        completedCount === cases.length
          ? BenchmarkRunStatus.Completed
          : BenchmarkRunStatus.Failed,
      completedAt: nowIso(),
      metadata: {
        ...run.metadata,
        completedCount,
        totalCases: cases.length
      }
    });
    const reportWrite = await writeBenchmarkReport(runtime, finalizedRun, caseReports, {
      ...(options.writeBaseline ? { writeBaseline: true } : {})
    });
    return runtime.benchmarkRunRepository.update({
      ...finalizedRun,
      metadata: {
        ...finalizedRun.metadata,
        reportPath: reportWrite.reportPath,
        ...(reportWrite.baselinePath ? { baselinePath: reportWrite.baselinePath } : {})
      }
    });
  } catch (error: unknown) {
    const failedRun = await runtime.benchmarkRunRepository.update({
      ...run,
      status: BenchmarkRunStatus.Failed,
      completedAt: nowIso(),
      metadata: {
        ...run.metadata,
        completedCount,
        totalCases: cases.length,
        error: error instanceof Error ? error.message : String(error)
      }
    });
    const reportWrite = await writeBenchmarkReport(runtime, failedRun, caseReports, {
      ...(options.writeBaseline ? { writeBaseline: true } : {})
    });
    return runtime.benchmarkRunRepository.update({
      ...failedRun,
      metadata: {
        ...failedRun.metadata,
        reportPath: reportWrite.reportPath,
        ...(reportWrite.baselinePath ? { baselinePath: reportWrite.baselinePath } : {})
      }
    });
  }
};
