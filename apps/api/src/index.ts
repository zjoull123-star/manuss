import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  ApprovalStatus,
  Artifact,
  ArtifactType,
  BenchmarkRunStatus,
  createTaskEvent,
  createTaskJob,
  TaskEventKind,
  TaskOrigin,
  TaskJobKind,
  TaskStatus
} from "../../../packages/core/src";
import { DEFAULT_OPENAI_MODELS } from "../../../packages/llm/src";
import { buildDemoRuntime } from "../../../packages/orchestrator/src";
import { ConsoleLogger } from "../../../packages/observability/src";
import { createId, JsonObject } from "../../../packages/shared/src";
import { getRecipeById, listRecipes, matchRecipeForGoal } from "../../../packages/recipes/src";
import { listBenchmarkCases, runBenchmarkSuite } from "../../../packages/evals/src";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const workspaceRoot =
  process.env.OPENCLAW_WORKSPACE_ROOT ??
  path.resolve(process.cwd(), ".data", "tasks-api");
const consoleRoot = path.resolve(process.cwd(), "apps", "console", "public");
const runtime = buildDemoRuntime(workspaceRoot, new ConsoleLogger(false));
const rejectOriginTasksInMock =
  (process.env.OPENCLAW_REJECT_ORIGIN_TASKS_IN_MOCK ?? "1") !== "0";

const isLiveRuntime =
  runtime.agentMode === "live" &&
  runtime.toolMode === "live" &&
  process.env.OPENCLAW_BROWSER_MODE === "live";

const readJsonBody = async (request: http.IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
};

const readBufferBody = async (request: http.IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const sendJson = (
  response: http.ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>
): void => {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload, null, 2));
};

const sendText = (
  response: http.ServerResponse,
  statusCode: number,
  body: string,
  contentType: string
): void => {
  response.writeHead(statusCode, { "content-type": contentType });
  response.end(body);
};

const sendBuffer = (
  response: http.ServerResponse,
  statusCode: number,
  body: Buffer,
  contentType: string
): void => {
  response.writeHead(statusCode, { "content-type": contentType });
  response.end(body);
};

const redirect = (
  response: http.ServerResponse,
  location: string,
  statusCode = 302
): void => {
  response.writeHead(statusCode, { location });
  response.end();
};

const getContentType = (filePath: string): string => {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".txt":
    case ".log":
    case ".py":
    case ".csv":
      return "text/plain; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
};

const isPathInside = (rootDir: string, candidatePath: string): boolean => {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const taskWorkspaceRoot = (taskId: string): string =>
  path.resolve(runtime.workspaceRoot, taskId);

const summarizeTask = (task: {
  id: string;
  userId?: string;
  goal?: string;
  recipeId?: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  finalArtifactUri?: string;
  finalArtifactValidation?: unknown;
  origin?: TaskOrigin;
  retryOfTaskId?: string;
  cancelRequestedAt?: string;
}): Record<string, unknown> => ({
  id: task.id,
  ...(task.userId ? { userId: task.userId } : {}),
  ...(task.goal ? { goal: task.goal } : {}),
  ...(task.recipeId ? { recipeId: task.recipeId } : {}),
  status: task.status,
  ...(task.createdAt ? { createdAt: task.createdAt } : {}),
  ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}),
  finalArtifactUri: task.finalArtifactUri ?? null,
  finalArtifactValidation: task.finalArtifactValidation ?? null,
  origin: task.origin ?? null,
  retryOfTaskId: task.retryOfTaskId ?? null,
  cancelRequestedAt: task.cancelRequestedAt ?? null
});

const isPendingApproval = (status: string): boolean => status === ApprovalStatus.Pending;

const asPositiveInt = (value: string | null, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
};

const summarizeStepError = (step: Record<string, unknown>): Record<string, unknown> | null => {
  const rawError =
    step["error"] && typeof step["error"] === "object" && !Array.isArray(step["error"])
      ? (step["error"] as Record<string, unknown>)
      : undefined;
  const structuredData =
    step["structuredData"] && typeof step["structuredData"] === "object" && !Array.isArray(step["structuredData"])
      ? (step["structuredData"] as Record<string, unknown>)
      : {};

  if (!rawError) {
    return null;
  }

  return {
    ...rawError,
    stage:
      typeof rawError["stage"] === "string"
        ? rawError["stage"]
        : typeof structuredData["stage"] === "string"
          ? structuredData["stage"]
          : null,
    category:
      typeof rawError["category"] === "string"
        ? rawError["category"]
        : typeof structuredData["category"] === "string"
          ? structuredData["category"]
          : null,
    upstreamErrorMessage:
      typeof rawError["upstreamErrorMessage"] === "string"
        ? rawError["upstreamErrorMessage"]
        : typeof structuredData["upstreamErrorMessage"] === "string"
          ? structuredData["upstreamErrorMessage"]
          : null,
    fallbackUsed:
      typeof rawError["fallbackUsed"] === "boolean"
        ? rawError["fallbackUsed"]
        : typeof structuredData["llmFallbackUsed"] === "boolean"
          ? structuredData["llmFallbackUsed"]
          : typeof structuredData["synthesisFallbackUsed"] === "boolean"
            ? structuredData["synthesisFallbackUsed"]
            : false,
    fallbackKind:
      typeof rawError["fallbackKind"] === "string"
        ? rawError["fallbackKind"]
        : typeof structuredData["fallbackKind"] === "string"
          ? structuredData["fallbackKind"]
          : typeof structuredData["llmFallbackCategory"] === "string"
            ? structuredData["llmFallbackCategory"]
            : null
  };
};

const summarizeTaskForApi = (task: Record<string, unknown>): Record<string, unknown> => ({
  ...task,
  steps: Array.isArray(task["steps"])
    ? task["steps"].map((candidate) => {
        const step =
          candidate && typeof candidate === "object" && !Array.isArray(candidate)
            ? { ...(candidate as Record<string, unknown>) }
            : {};
        return {
          ...step,
          error: summarizeStepError(step)
        };
      })
    : []
});

const parseTaskOrigin = (value: unknown): TaskOrigin | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const channelId =
    typeof candidate["channelId"] === "string" && candidate["channelId"].length > 0
      ? candidate["channelId"]
      : undefined;
  const replyMode =
    candidate["replyMode"] === "manual_status" || candidate["replyMode"] === "auto_callback"
      ? candidate["replyMode"]
      : undefined;

  if (!channelId || !replyMode) {
    throw new Error("origin.channelId and origin.replyMode are required when origin is provided");
  }

  const threadId = candidate["threadId"];
  if (
    threadId !== undefined &&
    typeof threadId !== "string" &&
    typeof threadId !== "number"
  ) {
    throw new Error("origin.threadId must be a string or number");
  }

  return {
    channelId,
    replyMode,
    ...(typeof candidate["accountId"] === "string" && candidate["accountId"].length > 0
      ? { accountId: candidate["accountId"] }
      : {}),
    ...(typeof candidate["conversationId"] === "string" &&
    candidate["conversationId"].length > 0
      ? { conversationId: candidate["conversationId"] }
      : {}),
    ...(typeof candidate["senderId"] === "string" && candidate["senderId"].length > 0
      ? { senderId: candidate["senderId"] }
      : {}),
    ...(typeof candidate["sessionKey"] === "string" && candidate["sessionKey"].length > 0
      ? { sessionKey: candidate["sessionKey"] }
      : {}),
    ...(threadId !== undefined ? { threadId } : {})
  };
};

const sanitizeUploadFilename = (value: string): string => {
  const normalized = path.basename(value).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.replace(/^-+|-+$/g, "").slice(0, 120) || "upload.bin";
};

const inferArtifactTypeFromFile = (filePath: string): ArtifactType => {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".pdf") {
    return ArtifactType.Pdf;
  }
  if (extension === ".docx") {
    return ArtifactType.Document;
  }
  if (extension === ".pptx") {
    return ArtifactType.Presentation;
  }
  if (extension === ".md") {
    return ArtifactType.Markdown;
  }
  if (extension === ".json") {
    return ArtifactType.Json;
  }
  if (extension === ".csv" || extension === ".tsv" || extension === ".xlsx" || extension === ".xls") {
    return ArtifactType.Spreadsheet;
  }
  if (extension === ".txt" || extension === ".log" || extension === ".py") {
    return ArtifactType.Text;
  }
  return ArtifactType.Generic;
};

const decorateArtifactForApi = (taskId: string, artifact: Artifact) => {
  const metadata =
    artifact.metadata && typeof artifact.metadata === "object" && !Array.isArray(artifact.metadata)
      ? (artifact.metadata as Record<string, unknown>)
      : {};
  const uri = artifact.uri;
  const originalFilename =
    typeof metadata["originalFilename"] === "string" && metadata["originalFilename"].length > 0
      ? metadata["originalFilename"]
      : null;

  return {
    ...artifact,
    title: artifact.title ?? null,
    summary: artifact.summary ?? null,
    keywords: artifact.keywords ?? [],
    validated: typeof artifact.validated === "boolean" ? artifact.validated : null,
    deliveryKind: artifact.deliveryKind ?? null,
    name: originalFilename ?? path.basename(uri) ?? null,
    originalFilename,
    uploaded: metadata["uploaded"] === true,
    contentUrl: `/tasks/${taskId}/artifacts/${artifact.id}/content`
  };
};

const enqueuePrepareTask = async (taskId: string) => {
  const existingJobs = await runtime.taskJobRepository.listByTask(taskId);
  const activePrepareJob = existingJobs.find(
    (job) =>
      job.kind === TaskJobKind.PrepareTask &&
      (job.status === "PENDING" || job.status === "RUNNING")
  );
  if (activePrepareJob) {
    return activePrepareJob;
  }

  const job = await runtime.taskJobRepository.enqueue(
    createTaskJob(taskId, TaskJobKind.PrepareTask)
  );
  await runtime.taskEventRepository.create(
    createTaskEvent(
      taskId,
      TaskEventKind.Job,
      `${job.kind} enqueued`,
      {
        kind: job.kind,
        status: job.status
      },
      {
        jobId: job.id
      }
    )
  );
  return job;
};

const serveConsoleAsset = async (
  requestPath: string,
  response: http.ServerResponse
): Promise<void> => {
  const relativeAssetPath =
    requestPath === "/ui" || requestPath === "/ui/"
      ? "index.html"
      : requestPath.replace(/^\/ui\/?/, "");
  const resolvedPath = path.resolve(consoleRoot, relativeAssetPath);

  if (!resolvedPath.startsWith(consoleRoot)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const fileContents = await fs.readFile(resolvedPath);
    sendBuffer(response, 200, fileContents, getContentType(resolvedPath));
  } catch {
    sendJson(response, 404, { error: "UI asset not found" });
  }
};

const buildTaskBundle = async (taskId: string): Promise<Record<string, unknown> | undefined> => {
  const task = await runtime.taskRepository.getById(taskId);
  if (!task) {
    return undefined;
  }

  const [artifacts, approvals, jobs, toolCalls, checkpoint, events] = await Promise.all([
    runtime.artifactRepository.listByTask(taskId),
    runtime.approvalRequestRepository.listByTask(taskId),
    runtime.taskJobRepository.listByTask(taskId),
    runtime.toolCallRepository.listByTask(taskId),
    runtime.checkpointRepository.getLatest(taskId),
    runtime.taskEventRepository.listByTask(taskId, 500)
  ]);
  const [references, indexedArtifacts] = await Promise.all([
    runtime.taskReferenceRepository.listByTask(taskId),
    runtime.artifactIndexRepository.listByTask(taskId)
  ]);

  return {
    task: summarizeTaskForApi({
      ...task,
      isTerminal: [TaskStatus.Completed, TaskStatus.Failed, TaskStatus.Cancelled].includes(
        task.status
      )
    }),
    artifacts: artifacts.map((artifact) => decorateArtifactForApi(taskId, artifact)),
    approvals,
    jobs,
    toolCalls,
    events,
    references,
    finalArtifactValidation: task.finalArtifactValidation ?? null,
    indexedArtifacts,
    checkpoint: checkpoint ?? null
  };
};

const buildQualityMetrics = async (): Promise<Record<string, unknown>> => {
  const tasks = await runtime.taskRepository.listRecent(200);
  const grouped = new Map<string, { total: number; completed: number; failed: number; fallbackUsed: number }>();
  for (const task of tasks) {
    for (const step of task.steps) {
      const taskClass = step.taskClass ?? "unknown";
      const entry = grouped.get(taskClass) ?? { total: 0, completed: 0, failed: 0, fallbackUsed: 0 };
      entry.total += 1;
      if (step.status === "COMPLETED") {
        entry.completed += 1;
      }
      if (step.status === "FAILED") {
        entry.failed += 1;
      }
      if (step.error?.fallbackUsed === true || step.structuredData?.llmFallbackUsed === true || step.structuredData?.synthesisFallbackUsed === true) {
        entry.fallbackUsed += 1;
      }
      grouped.set(taskClass, entry);
    }
  }

  return {
    taskClasses: [...grouped.entries()].map(([taskClass, metrics]) => ({
      taskClass,
      ...metrics,
      completionRate: metrics.total > 0 ? metrics.completed / metrics.total : 0
    }))
  };
};

const handleDecision = async (
  approvalId: string,
  nextStatus: ApprovalStatus.Approved | ApprovalStatus.Rejected,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> => {
  const approval = await runtime.approvalRequestRepository.getById(approvalId);
  if (!approval) {
    sendJson(response, 404, { error: `Approval ${approvalId} not found` });
    return;
  }

  if (!isPendingApproval(approval.status)) {
    sendJson(response, 409, {
      error: `Approval ${approvalId} is already ${approval.status}`
    });
    return;
  }

  const body = await readJsonBody(request);
  approval.status = nextStatus;
  approval.decidedAt = new Date().toISOString();
  approval.decidedBy =
    typeof body["decidedBy"] === "string" ? body["decidedBy"] : "api_user";
  if (typeof body["decisionNote"] === "string") {
    approval.decisionNote = body["decisionNote"];
  }
  const updatedApproval = await runtime.approvalRequestRepository.update(approval);
  const job = await runtime.taskJobRepository.enqueue(
    createTaskJob(updatedApproval.taskId, TaskJobKind.ResumeTask, {
      approvalId: updatedApproval.id
    })
  );
  await runtime.taskEventRepository.create(
    createTaskEvent(
      updatedApproval.taskId,
      TaskEventKind.Approval,
      `Approval ${nextStatus.toLowerCase()} via API`,
      {
        approvalId: updatedApproval.id,
        status: updatedApproval.status,
        decidedBy: updatedApproval.decidedBy ?? "api_user"
      },
      {
        stepId: updatedApproval.stepId,
        level: nextStatus === ApprovalStatus.Approved ? "info" : "warn"
      }
    )
  );
  await runtime.taskEventRepository.create(
    createTaskEvent(
      updatedApproval.taskId,
      TaskEventKind.Job,
      `${job.kind} enqueued`,
      {
        kind: job.kind,
        status: job.status
      },
      {
        jobId: job.id
      }
    )
  );
  const task = await runtime.taskRepository.getById(updatedApproval.taskId);

  sendJson(response, 200, {
    approval: updatedApproval,
    task: task ? summarizeTask(task) : null,
    job
  });
};

const openEventStream = async (
  response: http.ServerResponse,
  taskId: string,
  initialLimit = 200
): Promise<void> => {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });

  const seenIds = new Set<string>();
  const writeEvents = async () => {
    const events = await runtime.taskEventRepository.listByTask(taskId, initialLimit);
    for (const event of events) {
      if (seenIds.has(event.id)) {
        continue;
      }
      seenIds.add(event.id);
      response.write(`event: task_event\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };

  await writeEvents();
  const timer = setInterval(() => {
    void writeEvents();
  }, 1000);
  response.on("close", () => {
    clearInterval(timer);
  });
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://localhost:${port}`);
    const { pathname } = url;

    if (request.method === "GET" && pathname === "/") {
      redirect(response, "/ui/");
      return;
    }

    if (request.method === "GET" && pathname.startsWith("/ui")) {
      await serveConsoleAsset(pathname, response);
      return;
    }

    if (request.method === "GET" && pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        runtime: {
          dbMode: runtime.dbMode,
          agentMode: runtime.agentMode,
          toolMode: runtime.toolMode,
          browserMode: process.env.OPENCLAW_BROWSER_MODE ?? runtime.toolMode,
          rejectOriginTasksInMock
        }
      });
      return;
    }

    if (request.method === "GET" && pathname === "/runtime") {
      sendJson(response, 200, {
        dbMode: runtime.dbMode,
        agentMode: runtime.agentMode,
        toolMode: runtime.toolMode,
        browserMode: process.env.OPENCLAW_BROWSER_MODE ?? runtime.toolMode,
        isLiveRuntime,
        rejectOriginTasksInMock
      });
      return;
    }

    if (request.method === "GET" && pathname === "/models") {
      sendJson(response, 200, DEFAULT_OPENAI_MODELS);
      return;
    }

    if (request.method === "GET" && pathname === "/recipes") {
      sendJson(response, 200, {
        recipes: listRecipes()
      });
      return;
    }

    if (request.method === "GET" && pathname === "/metrics/quality") {
      sendJson(response, 200, await buildQualityMetrics());
      return;
    }

    if (request.method === "GET" && pathname === "/artifacts/search") {
      const q = url.searchParams.get("q") ?? undefined;
      const taskClass = url.searchParams.get("taskClass") ?? undefined;
      const artifactType = url.searchParams.get("artifactType") ?? undefined;
      const limit = asPositiveInt(url.searchParams.get("limit"), 20);
      const results = await runtime.artifactIndexRepository.search({
        ...(q ? { q } : {}),
        ...(taskClass ? { taskClass } : {}),
        ...(artifactType ? { artifactType } : {}),
        validatedOnly: url.searchParams.get("validatedOnly") !== "0",
        limit
      });
      sendJson(response, 200, { artifacts: results });
      return;
    }

    if (request.method === "GET" && pathname === "/tasks") {
      const limit = asPositiveInt(url.searchParams.get("limit"), 30);
      const tasks = await runtime.taskRepository.listRecent(limit);
      sendJson(response, 200, {
        tasks: tasks.map((task) => summarizeTask(task))
      });
      return;
    }

    if (request.method === "POST" && pathname === "/tasks") {
      const body = await readJsonBody(request);
      const userId =
        typeof body["userId"] === "string" && body["userId"].length > 0
          ? body["userId"]
          : "api_user";
      const goal =
        typeof body["goal"] === "string" && body["goal"].length > 0
          ? body["goal"]
          : undefined;
      const deferStart = body["deferStart"] === true;
      const recipeId =
        typeof body["recipeId"] === "string" && body["recipeId"].length > 0
          ? body["recipeId"]
          : matchRecipeForGoal(goal ?? "")?.id;
      if (recipeId && !getRecipeById(recipeId)) {
        sendJson(response, 400, { error: `Unknown recipeId: ${recipeId}` });
        return;
      }
      let origin: TaskOrigin | undefined;
      try {
        origin = parseTaskOrigin(body["origin"]);
      } catch (error: unknown) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error)
        });
        return;
      }

      if (!goal) {
        sendJson(response, 400, { error: "goal is required" });
        return;
      }

      if (origin && rejectOriginTasksInMock && !isLiveRuntime) {
        sendJson(response, 503, {
          error: "manus runtime is in mock mode; refusing OpenClaw-origin task",
          runtime: {
            dbMode: runtime.dbMode,
            agentMode: runtime.agentMode,
            toolMode: runtime.toolMode,
            browserMode: process.env.OPENCLAW_BROWSER_MODE ?? runtime.toolMode
          }
        });
        return;
      }

      const task = await runtime.orchestrator.createDraftTask({
        userId,
        goal,
        ...(recipeId ? { recipeId } : {}),
        ...(origin ? { origin } : {})
      });
      if (deferStart) {
        sendJson(response, 201, {
          task: summarizeTask(task),
          deferred: true
        });
        return;
      }

      const job = await enqueuePrepareTask(task.id);
      sendJson(response, 202, {
        task: summarizeTask(task),
        job
      });
      return;
    }

    if (request.method === "GET" && pathname === "/approvals") {
      const taskId = url.searchParams.get("taskId");
      const approvals = taskId
        ? await runtime.approvalRequestRepository.listByTask(taskId)
        : await runtime.approvalRequestRepository.listPending();
      sendJson(response, 200, { approvals });
      return;
    }

    if (request.method === "GET" && pathname === "/jobs") {
      const taskId = url.searchParams.get("taskId");
      if (!taskId) {
        const pendingJobs = await runtime.taskJobRepository.listPending();
        sendJson(response, 200, { jobs: pendingJobs });
        return;
      }

      const jobs = await runtime.taskJobRepository.listByTask(taskId);
      sendJson(response, 200, { jobs });
      return;
    }

    const approvalMatch = pathname.match(/^\/approvals\/([^/]+)$/);
    const approvalId = approvalMatch?.[1];
    if (request.method === "GET" && approvalId) {
      const approval = await runtime.approvalRequestRepository.getById(approvalId);
      if (!approval) {
        sendJson(response, 404, { error: "Approval not found" });
        return;
      }
      sendJson(response, 200, { approval });
      return;
    }

    const approveMatch = pathname.match(/^\/approvals\/([^/]+)\/approve$/);
    const approveId = approveMatch?.[1];
    if (request.method === "POST" && approveId) {
      await handleDecision(approveId, ApprovalStatus.Approved, request, response);
      return;
    }

    const rejectMatch = pathname.match(/^\/approvals\/([^/]+)\/reject$/);
    const rejectId = rejectMatch?.[1];
    if (request.method === "POST" && rejectId) {
      await handleDecision(rejectId, ApprovalStatus.Rejected, request, response);
      return;
    }

    const taskBundleMatch = pathname.match(/^\/tasks\/([^/]+)\/detail$/);
    const bundledTaskId = taskBundleMatch?.[1];
    if (request.method === "GET" && bundledTaskId) {
      const bundle = await buildTaskBundle(bundledTaskId);
      if (!bundle) {
        sendJson(response, 404, { error: "Task not found" });
        return;
      }

      sendJson(response, 200, bundle);
      return;
    }

    const taskReferencesMatch = pathname.match(/^\/tasks\/([^/]+)\/references$/);
    const referenceTaskId = taskReferencesMatch?.[1];
    if (request.method === "GET" && referenceTaskId) {
      const task = await runtime.taskRepository.getById(referenceTaskId);
      if (!task) {
        sendJson(response, 404, { error: "Task not found" });
        return;
      }
      const references = await runtime.taskReferenceRepository.listByTask(referenceTaskId);
      sendJson(response, 200, { references });
      return;
    }

    const taskLogsMatch = pathname.match(/^\/tasks\/([^/]+)\/logs$/);
    const logTaskId = taskLogsMatch?.[1];
    if (request.method === "GET" && logTaskId) {
      const task = await runtime.taskRepository.getById(logTaskId);
      if (!task) {
        sendJson(response, 404, { error: "Task not found" });
        return;
      }
      const limit = asPositiveInt(url.searchParams.get("limit"), 200);
      const events = await runtime.taskEventRepository.listByTask(logTaskId, limit);
      sendJson(response, 200, { events });
      return;
    }

    const taskLogStreamMatch = pathname.match(/^\/tasks\/([^/]+)\/logs\/stream$/);
    const logStreamTaskId = taskLogStreamMatch?.[1];
    if (request.method === "GET" && logStreamTaskId) {
      const task = await runtime.taskRepository.getById(logStreamTaskId);
      if (!task) {
        sendJson(response, 404, { error: "Task not found" });
        return;
      }
      await openEventStream(response, logStreamTaskId, asPositiveInt(url.searchParams.get("limit"), 200));
      return;
    }

    const uploadMatch = pathname.match(/^\/tasks\/([^/]+)\/uploads$/);
    const uploadTaskId = uploadMatch?.[1];
    if (request.method === "POST" && uploadTaskId) {
      const task = await runtime.taskRepository.getById(uploadTaskId);
      if (!task) {
        sendJson(response, 404, { error: "Task not found" });
        return;
      }

      const rawFilename =
        url.searchParams.get("filename") ??
        request.headers["x-file-name"]?.toString() ??
        "upload.bin";
      const filename = sanitizeUploadFilename(rawFilename);
      const extension = path.extname(filename).toLowerCase();
      if (![".csv", ".xlsx", ".xls", ".json", ".txt", ".md"].includes(extension)) {
        sendJson(response, 400, {
          error: `Unsupported upload type for ${filename}`
        });
        return;
      }

      const body = await readBufferBody(request);
      const targetPath = path.join(runtime.workspaceRoot, uploadTaskId, "uploads", filename);
      if (!isPathInside(taskWorkspaceRoot(uploadTaskId), targetPath)) {
        sendJson(response, 403, { error: "Upload path resolved outside task workspace" });
        return;
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, body);

      const artifact = await runtime.artifactRepository.save({
        id: createId("artifact"),
        taskId: uploadTaskId,
        type: inferArtifactTypeFromFile(targetPath),
        uri: targetPath,
        metadata: {
          createdBy: "upload",
          uploaded: true,
          originalFilename: rawFilename,
          contentType: request.headers["content-type"]?.toString() ?? "application/octet-stream",
          sizeBytes: body.byteLength
        },
        createdAt: new Date().toISOString()
      });
      await runtime.taskEventRepository.create(
        createTaskEvent(
          uploadTaskId,
          TaskEventKind.Tool,
          `upload.received ${filename}`,
          {
            filename,
            uri: targetPath,
            sizeBytes: body.byteLength
          }
        )
      );

      sendJson(response, 201, {
        artifact: decorateArtifactForApi(uploadTaskId, artifact)
      });
      return;
    }

    const taskArtifactsMatch = pathname.match(/^\/tasks\/([^/]+)\/artifacts$/);
    const artifactTaskId = taskArtifactsMatch?.[1];
    if (request.method === "GET" && artifactTaskId) {
      const task = await runtime.taskRepository.getById(artifactTaskId);
      if (!task) {
        sendJson(response, 404, { error: "Task not found" });
        return;
      }

      const artifacts = await runtime.artifactRepository.listByTask(artifactTaskId);
      sendJson(response, 200, {
        artifacts: artifacts.map((artifact) => decorateArtifactForApi(artifactTaskId, artifact))
      });
      return;
    }

    const artifactContentMatch = pathname.match(/^\/tasks\/([^/]+)\/artifacts\/([^/]+)\/content$/);
    const artifactContentTaskId = artifactContentMatch?.[1];
    const artifactId = artifactContentMatch?.[2];
    if (request.method === "GET" && artifactContentTaskId && artifactId) {
      const artifacts = await runtime.artifactRepository.listByTask(artifactContentTaskId);
      const artifact = artifacts.find((candidate) => candidate.id === artifactId);
      if (!artifact) {
        sendJson(response, 404, { error: "Artifact not found" });
        return;
      }
      if (!isPathInside(taskWorkspaceRoot(artifactContentTaskId), artifact.uri)) {
        sendJson(response, 403, { error: "Artifact path is outside task workspace" });
        return;
      }

      try {
        const fileContents = await fs.readFile(artifact.uri);
        sendBuffer(response, 200, fileContents, getContentType(artifact.uri));
      } catch {
        sendJson(response, 404, { error: "Artifact file not found on disk" });
      }
      return;
    }

    const taskMatch = pathname.match(/^\/tasks\/([^/]+)$/);
    const taskId = taskMatch?.[1];
    if (request.method === "GET" && taskId) {
      const task = await runtime.taskRepository.getById(taskId);
      if (!task) {
        sendJson(response, 404, { error: "Task not found" });
        return;
      }

      sendJson(response, 200, {
        task: summarizeTaskForApi({
          ...task,
          isTerminal: [TaskStatus.Completed, TaskStatus.Failed, TaskStatus.Cancelled].includes(
            task.status
          )
        })
      });
      return;
    }

    const jobMatch = pathname.match(/^\/jobs\/([^/]+)$/);
    const jobId = jobMatch?.[1];
    if (request.method === "GET" && jobId) {
      const job = await runtime.taskJobRepository.getById(jobId);
      if (!job) {
        sendJson(response, 404, { error: "Job not found" });
        return;
      }
      sendJson(response, 200, { job });
      return;
    }

    if (request.method === "GET" && pathname === "/benchmarks/runs") {
      const runs = await runtime.benchmarkRunRepository.listRecent(asPositiveInt(url.searchParams.get("limit"), 20));
      const items = await Promise.all(
        runs.map(async (run) => ({
          ...run,
          items: await runtime.benchmarkRunItemRepository.listByRun(run.id)
        }))
      );
      sendJson(response, 200, { runs: items });
      return;
    }

    if (request.method === "GET" && pathname === "/benchmarks/cases") {
      sendJson(response, 200, { cases: listBenchmarkCases() });
      return;
    }

    if (request.method === "POST" && pathname === "/benchmarks/runs") {
      const body = await readJsonBody(request);
      const name =
        typeof body["name"] === "string" && body["name"].length > 0
          ? body["name"]
          : "manual benchmark";
      const suite =
        typeof body["suite"] === "string" && body["suite"].length > 0
          ? body["suite"]
          : "manual";
      const caseIds = Array.isArray(body["caseIds"])
        ? body["caseIds"].filter((item): item is string => typeof item === "string" && item.length > 0)
        : undefined;
      const run = await runtime.benchmarkRunRepository.create({
        id: createId("bench"),
        name,
        suite,
        status: BenchmarkRunStatus.Pending,
        startedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        metadata: JSON.parse(JSON.stringify(body)) as JsonObject
      });
      void runBenchmarkSuite(runtime, {
        run,
        name,
        suite,
        ...(caseIds ? { caseIds } : {})
      }).catch(async (error: unknown) => {
        const currentRun = await runtime.benchmarkRunRepository.getById(run.id);
        if (!currentRun) {
          return;
        }
        await runtime.benchmarkRunRepository.update({
          ...currentRun,
          status: BenchmarkRunStatus.Failed,
          completedAt: new Date().toISOString(),
          metadata: {
            ...currentRun.metadata,
            error: error instanceof Error ? error.message : String(error)
          }
        });
      });
      sendJson(response, 201, { run });
      return;
    }

    const resumeMatch = pathname.match(/^\/tasks\/([^/]+)\/resume$/);
    const resumeTaskId = resumeMatch?.[1];
    if (request.method === "POST" && resumeTaskId) {
      const task = await runtime.taskRepository.getById(resumeTaskId);
      if (!task) {
        sendJson(response, 404, { error: "Task not found" });
        return;
      }
      if (task.status !== TaskStatus.WaitingApproval) {
        sendJson(response, 409, {
          error: `Task ${resumeTaskId} cannot resume from status ${task.status}`
        });
        return;
      }
      const job = await runtime.taskJobRepository.enqueue(
        createTaskJob(resumeTaskId, TaskJobKind.ResumeTask)
      );
      await runtime.taskEventRepository.create(
        createTaskEvent(
          resumeTaskId,
          TaskEventKind.Job,
          `${job.kind} enqueued`,
          {
            kind: job.kind,
            status: job.status
          },
          {
            jobId: job.id
          }
        )
      );
      sendJson(response, 200, {
        task: summarizeTask(task),
        job
      });
      return;
    }

    const retryMatch = pathname.match(/^\/tasks\/([^/]+)\/retry$/);
    const retryTaskId = retryMatch?.[1];
    if (request.method === "POST" && retryTaskId) {
      const result = await runtime.orchestrator.createRetryTask(retryTaskId);
      sendJson(response, 202, {
        sourceTask: summarizeTask(result.sourceTask),
        task: summarizeTask(result.retryTask),
        job: result.job
      });
      return;
    }

    const startMatch = pathname.match(/^\/tasks\/([^/]+)\/start$/);
    const startTaskId = startMatch?.[1];
    if (request.method === "POST" && startTaskId) {
      const task = await runtime.taskRepository.getById(startTaskId);
      if (!task) {
        sendJson(response, 404, { error: "Task not found" });
        return;
      }
      if (task.status !== TaskStatus.Created) {
        sendJson(response, 409, {
          error: `Task ${startTaskId} cannot start from status ${task.status}`
        });
        return;
      }

      const job = await enqueuePrepareTask(startTaskId);
      sendJson(response, 202, {
        task: summarizeTask(task),
        job
      });
      return;
    }

    const cancelMatch = pathname.match(/^\/tasks\/([^/]+)\/cancel$/);
    const cancelTaskId = cancelMatch?.[1];
    if (request.method === "POST" && cancelTaskId) {
      const task = await runtime.orchestrator.requestCancel(cancelTaskId);
      sendJson(response, 200, {
        task: summarizeTask(task)
      });
      return;
    }

    if (request.method === "GET" && pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error: unknown) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(port, host, () => {
  console.log(`API listening on http://${host}:${port}`);
});
