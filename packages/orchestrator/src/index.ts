import path from "node:path";
import { promises as fs } from "node:fs";
import {
  AgentRequest,
  AgentResponse,
  AgentKind,
  ApprovalRequest,
  ApprovalRequestRepository,
  ApprovalStatus,
  ArtifactType,
  ArtifactRepository,
  ArtifactIndexEntry,
  ArtifactIndexRepository,
  BrowserSessionRepository,
  Checkpoint,
  CheckpointRepository,
  createTaskEvent,
  createTaskJob,
  createDraftTask,
  createTaskFromPlan,
  ErrorCode,
  DeliveryKind,
  isRunnableStep,
  RouteDecision,
  StepStatus,
  Task,
  TaskClass,
  TaskEventKind,
  TaskEventRepository,
  TaskJob,
  TaskOrigin,
  TaskJobKind,
  TaskJobRepository,
  TaskRepository,
  TaskReferenceRepository,
  TaskSummaryRepository,
  TaskStatus,
  ToolName,
  UserProfile,
  UserProfileRepository,
  WideResearchItemRepository,
  WideResearchRunRepository
} from "../../core/src";
import { ContextBuilder, MemoryWriter } from "../../memory/src";
import { Logger } from "../../observability/src";
import {
  ActionAgent,
  AgentExecutionMode,
  AgentRegistry,
  BrowserAgent,
  buildPrefixedTaskRoute,
  CodingAgent,
  hasTaskPrefix,
  PlannerAgent,
  ReplannerAgent,
  ResearchAgent,
  RouterAgent,
  VerifierAgent
} from "../../agents/src";
import { createId, JsonObject, nowIso } from "../../shared/src";
import { WorkspaceManager, ArtifactRegistry } from "../../artifacts/src";
import {
  ActionTool,
  BrowserTool,
  DocumentTool,
  FilesystemTool,
  PythonTool,
  SearchTool,
  ToolExecutionMode,
  ToolRuntime
} from "../../tools/src";
import { ModelRouter, OpenAIResponsesClient, WebSearchLocation } from "../../llm/src";
import {
  createInMemoryRepositories,
  createPrismaRepositories
} from "../../db/src";
import { ToolPolicyService } from "../../policy/src";
import { ConsoleLogger, StructuredLogger } from "../../observability/src";
import { DocumentAgent } from "../../agents/src";
import { InMemoryMemoryStore, PersistentMemoryStore } from "../../memory/src";
import { buildRecipePlanningContext, matchRecipeForGoal } from "../../recipes/src";

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asJsonObject = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : ({} as JsonObject);

const coerceToolName = (value: unknown): ToolName => {
  if (Object.values(ToolName).includes(value as ToolName)) {
    return value as ToolName;
  }

  return ToolName.Action;
};

const isExecutableRoute = (route: RouteDecision["route"]): boolean =>
  route === "single_step" || route === "multi_step" || route === "approval_required";

const ensureTaskPrefixedGoal = (goal: string): string => {
  const trimmedGoal = goal.trim();
  if (hasTaskPrefix(trimmedGoal)) {
    return trimmedGoal;
  }

  return trimmedGoal.length > 0 ? `TASK: ${trimmedGoal}` : "TASK:";
};

class StepTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepTimeoutError";
  }
}

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRetryableJobError = (error: unknown): boolean => {
  if (error && typeof error === "object") {
    const candidate = error as {
      retryable?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    if (candidate.retryable === true) {
      return true;
    }
    if (
      candidate.code === ErrorCode.Timeout ||
      candidate.code === ErrorCode.NetworkError ||
      candidate.code === ErrorCode.RateLimit ||
      candidate.code === ErrorCode.ToolUnavailable
    ) {
      return true;
    }
    if (candidate.cause) {
      return isRetryableJobError(candidate.cause);
    }
  }

  const message = getErrorMessage(error).toLowerCase();
  if (message.includes("insufficient_quota") || message.includes("permission denied")) {
    return false;
  }
  return (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("rate limit") ||
    message.includes("temporar") ||
    message.includes("fetch failed") ||
    message.includes("playwright") ||
    message.includes("econn") ||
    message.includes("enotfound")
  );
};

const pickPreferredFinalArtifact = (artifactUris: string[]): string | undefined => {
  if (artifactUris.length === 0) {
    return undefined;
  }

  const priorityPatterns = [/\.pdf$/i, /\.pptx$/i, /\.docx$/i, /\/report\.md$/i, /\.md$/i];
  for (const pattern of priorityPatterns) {
    const match = [...artifactUris].reverse().find((uri) => pattern.test(uri));
    if (match) {
      return match;
    }
  }

  return artifactUris.at(-1);
};

const getMaxRetriesForAgent = (agent: AgentKind): number => {
  if (agent === AgentKind.Research || agent === AgentKind.Browser) {
    return 3;
  }
  if (agent === AgentKind.Action) {
    return 1;
  }
  return 2;
};

const getStepTimeoutForAgent = (agent: AgentKind, fallbackMs: number): number => {
  if (agent === AgentKind.Research || agent === AgentKind.Browser) {
    return 600_000;
  }
  return fallbackMs;
};

const buildRuntimeAttemptStrategy = (
  step: Task["steps"][number],
  attempt: number,
  timeoutMs: number
): JsonObject => ({
  ...(step.attemptStrategy ?? {}),
  attempt,
  timeoutMs,
  maxRetries: getMaxRetriesForAgent(step.agent),
  strategy:
    attempt <= 0
      ? "default_execution"
      : attempt === 1
        ? "repair_context_and_retry"
        : attempt === 2
          ? "escalate_model_or_tool"
      : "fallback_or_replan",
  escalatedModel:
    attempt >= 1 &&
    [AgentKind.Research, AgentKind.Browser, AgentKind.Document, AgentKind.Verifier].includes(
      step.agent
    )
});

const uniqueStrings = (values: string[]): string[] => [...new Set(values.filter(Boolean))];

const tokenizeKeywords = (value: string): string[] =>
  uniqueStrings(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  );

export class Scheduler {
  pickNextRunnableStep(task: Task) {
    return task.steps.find((step) => isRunnableStep(task, step));
  }
}

export class CheckpointManager {
  constructor(private readonly checkpointRepository: CheckpointRepository) {}

  async save(task: Task, currentStepId?: string): Promise<Checkpoint> {
    const checkpoint: Checkpoint = {
      id: createId("checkpoint"),
      taskId: task.id,
      planVersion: task.currentPlanVersion,
      completedSteps: task.steps
        .filter((step) => step.status === StepStatus.Completed)
        .map((step) => step.id),
      artifactUris: task.steps.flatMap((step) => step.outputArtifacts),
      createdAt: nowIso(),
      ...(currentStepId ? { currentStepId } : {})
    };
    return this.checkpointRepository.save(checkpoint);
  }
}

export interface HandleGoalInput {
  userId: string;
  goal: string;
  origin?: TaskOrigin;
  recipeId?: string;
}

export class TaskOrchestrator {
  private readonly scheduler = new Scheduler();

  constructor(
    private readonly routerAgent: RouterAgent,
    private readonly plannerAgent: PlannerAgent,
    private readonly replannerAgent: ReplannerAgent,
    private readonly verifierAgent: VerifierAgent,
    private readonly agentRegistry: AgentRegistry,
    private readonly taskRepository: TaskRepository,
    private readonly taskEventRepository: TaskEventRepository,
    private readonly taskJobRepository: TaskJobRepository,
    private readonly artifactRepository: ArtifactRepository,
    private readonly taskSummaryRepository: TaskSummaryRepository,
    private readonly artifactIndexRepository: ArtifactIndexRepository,
    private readonly taskReferenceRepository: TaskReferenceRepository,
    private readonly wideResearchRunRepository: WideResearchRunRepository,
    private readonly wideResearchItemRepository: WideResearchItemRepository,
    private readonly approvalRequestRepository: ApprovalRequestRepository,
    private readonly checkpointManager: CheckpointManager,
    private readonly userProfileRepository: UserProfileRepository,
    private readonly contextBuilder: ContextBuilder,
    private readonly memoryWriter: MemoryWriter,
    private readonly workspaceManager: WorkspaceManager,
    private readonly logger: Logger,
    private readonly maxRetries = 2,
    private readonly stepTimeoutMs = 300_000,
    private readonly browserSessionRepository?: BrowserSessionRepository
  ) {}

  private async recordEvent(
    taskId: string,
    kind: TaskEventKind,
    message: string,
    payload: JsonObject = {},
    options: { level?: "info" | "warn" | "error"; stepId?: string; jobId?: string } = {}
  ): Promise<void> {
    await this.taskEventRepository.create(
      createTaskEvent(taskId, kind, message, payload, options)
    );
  }

  private async recordTaskStatus(task: Task, message: string): Promise<void> {
    await this.recordEvent(
      task.id,
      TaskEventKind.TaskStatusChanged,
      message,
      {
        status: task.status,
        ...(task.cancelRequestedAt ? { cancelRequestedAt: task.cancelRequestedAt } : {}),
        ...(task.retryOfTaskId ? { retryOfTaskId: task.retryOfTaskId } : {})
      },
      {
        level:
          task.status === TaskStatus.Failed || task.status === TaskStatus.Cancelled
            ? "warn"
            : "info"
      }
    );
  }

  private async recordStepStatus(
    taskId: string,
    step: Task["steps"][number],
    message: string,
    level: "info" | "warn" | "error" = "info"
  ): Promise<void> {
    await this.recordEvent(
      taskId,
      TaskEventKind.StepStatusChanged,
      message,
      {
        status: step.status,
        agent: step.agent,
        retryCount: step.retryCount,
        ...(step.taskClass ? { taskClass: step.taskClass } : {}),
        ...(typeof step.qualityScore === "number" ? { qualityScore: step.qualityScore } : {}),
        ...(Array.isArray(step.qualityDefects) ? { qualityDefects: step.qualityDefects } : {}),
        ...(Array.isArray(step.missingEvidence) ? { missingEvidence: step.missingEvidence } : {}),
        ...(step.attemptStrategy ? { attemptStrategy: step.attemptStrategy } : {}),
        ...(step.error
          ? {
              error: {
                code: step.error.code,
                message: step.error.message,
                retryable: step.error.retryable,
                ...(step.error.stage ? { stage: step.error.stage } : {}),
                ...(step.error.category ? { category: step.error.category } : {}),
                ...(step.error.upstreamErrorMessage
                  ? { upstreamErrorMessage: step.error.upstreamErrorMessage }
                  : {}),
                ...(typeof step.error.fallbackUsed === "boolean"
                  ? { fallbackUsed: step.error.fallbackUsed }
                  : {}),
                ...(step.error.fallbackKind ? { fallbackKind: step.error.fallbackKind } : {})
              }
            }
          : {})
      },
      {
        stepId: step.id,
        level
      }
    );
  }

  private async saveCheckpointAndEvent(task: Task, currentStepId?: string): Promise<Checkpoint> {
    const checkpoint = await this.checkpointManager.save(task, currentStepId);
    await this.recordEvent(
      task.id,
      TaskEventKind.Checkpoint,
      `Checkpoint saved${currentStepId ? ` for ${currentStepId}` : ""}`,
      {
        checkpointId: checkpoint.id,
        planVersion: checkpoint.planVersion,
        completedSteps: checkpoint.completedSteps,
        artifactUris: checkpoint.artifactUris
      },
      {
        ...(currentStepId ? { stepId: currentStepId } : {})
      }
    );
    return checkpoint;
  }

  private async maybeCancelTask(taskId: string, reason: string, stepId?: string): Promise<Task | undefined> {
    const latestTask = await this.taskRepository.getById(taskId);
    if (!latestTask?.cancelRequestedAt) {
      return undefined;
    }
    if (latestTask.status === TaskStatus.Cancelled) {
      return latestTask;
    }

    latestTask.status = TaskStatus.Cancelled;
    latestTask.updatedAt = nowIso();
    await this.taskRepository.update(latestTask);
    await this.recordTaskStatus(latestTask, reason);
    await this.saveCheckpointAndEvent(latestTask, stepId);
    return latestTask;
  }

  async createRetryTask(taskId: string): Promise<{ sourceTask: Task; retryTask: Task; job: TaskJob }> {
    const sourceTask = await this.taskRepository.getById(taskId);
    if (!sourceTask) {
      throw new Error(`Task ${taskId} not found`);
    }
    if (![TaskStatus.Failed, TaskStatus.Cancelled].includes(sourceTask.status)) {
      throw new Error(`Task ${taskId} cannot be retried from status ${sourceTask.status}`);
    }

    const retryTask = createDraftTask(sourceTask.userId, sourceTask.goal, sourceTask.origin, {
      ...(sourceTask.recipeId ? { recipeId: sourceTask.recipeId } : {}),
      retryOfTaskId: sourceTask.id
    });
    await this.taskRepository.create(retryTask);
    await this.cloneUploadedArtifactsForRetry(sourceTask, retryTask);
    await this.recordTaskStatus(retryTask, `Retry task created from ${sourceTask.id}`);
    await this.saveCheckpointAndEvent(retryTask);
    const job = await this.taskJobRepository.enqueue(
      createTaskJob(retryTask.id, TaskJobKind.PrepareTask, {
        retryOfTaskId: sourceTask.id
      })
    );
    await this.recordEvent(
      retryTask.id,
      TaskEventKind.Job,
      `${job.kind} enqueued`,
      {
        kind: job.kind,
        status: job.status
      },
      {
        jobId: job.id
      }
    );
    return { sourceTask, retryTask, job };
  }

  async prepareTaskForRetry(taskId: string, jobKind: TaskJobKind, reason: string): Promise<void> {
    const task = await this.taskRepository.getById(taskId);
    if (!task || [TaskStatus.Completed, TaskStatus.Cancelled].includes(task.status)) {
      return;
    }

    let changed = false;
    if (jobKind === TaskJobKind.PrepareTask) {
      if (task.currentPlanVersion === 0 && task.status === TaskStatus.Failed) {
        task.status = TaskStatus.Created;
        changed = true;
      }
    } else {
      for (const step of task.steps) {
        if (step.status === StepStatus.Running || step.status === StepStatus.Verifying) {
          step.status = StepStatus.Pending;
          delete step.error;
          changed = true;
        }
      }
      if (
        changed &&
        [TaskStatus.Running, TaskStatus.Retrying, TaskStatus.Verifying, TaskStatus.Failed].includes(
          task.status
        )
      ) {
        task.status = task.currentPlanVersion > 0 ? TaskStatus.Planned : TaskStatus.Created;
      }
    }

    if (!changed) {
      return;
    }

    task.updatedAt = nowIso();
    await this.taskRepository.update(task);
    await this.recordTaskStatus(task, `Task reset for queue retry after: ${reason}`);
    await this.saveCheckpointAndEvent(task);
  }

  async requestCancel(taskId: string): Promise<Task> {
    const task = await this.taskRepository.getById(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    if ([TaskStatus.Completed, TaskStatus.Failed, TaskStatus.Cancelled].includes(task.status)) {
      return task;
    }

    task.cancelRequestedAt = nowIso();
    task.updatedAt = nowIso();
    if ([TaskStatus.Created, TaskStatus.Planned, TaskStatus.WaitingApproval].includes(task.status)) {
      task.status = TaskStatus.Cancelled;
    }
    await this.taskRepository.update(task);
    await this.recordTaskStatus(
      task,
      task.status === TaskStatus.Cancelled ? "Task cancelled" : "Cancellation requested"
    );
    await this.saveCheckpointAndEvent(task);
    return task;
  }

  async prepareTask(input: HandleGoalInput): Promise<Task> {
    const draftTask = await this.createDraftTask(input);
    return this.prepareTaskById(draftTask.id);
  }

  async createDraftTask(input: HandleGoalInput): Promise<Task> {
    const task = createDraftTask(input.userId, input.goal, input.origin, {
      ...(input.recipeId ? { recipeId: input.recipeId } : {})
    });
    await this.taskRepository.create(task);
    await this.recordTaskStatus(task, "Task created");
    await this.saveCheckpointAndEvent(task);
    return task;
  }

  async prepareTaskById(taskId: string): Promise<Task> {
    const existingTask = await this.taskRepository.getById(taskId);
    if (!existingTask) {
      throw new Error(`Task ${taskId} not found`);
    }

    const cancelledTask = await this.maybeCancelTask(taskId, "Task cancelled before planning");
    if (cancelledTask) {
      return cancelledTask;
    }

    if (existingTask.status !== TaskStatus.Created) {
      return existingTask;
    }

    const originalGoal = existingTask.goal;
    const originalGoalHasTaskPrefix = hasTaskPrefix(originalGoal);
    const normalizedGoal = ensureTaskPrefixedGoal(originalGoal);
    if (normalizedGoal !== existingTask.goal) {
      existingTask.goal = normalizedGoal;
    }

    const userProfile = await this.ensureUserProfile(existingTask.userId);
    let routeDecision:
      | {
          original: RouteDecision;
          effective: RouteDecision;
          overrideApplied: boolean;
        }
      | undefined;
    let failureStage: "route" | "planner" = "route";
    try {
      this.logger.info("PREPARE_TASK routing", {
        taskId: existingTask.id,
        userId: existingTask.userId,
        goal: normalizedGoal,
        hasTaskPrefix: hasTaskPrefix(normalizedGoal),
        originalGoal,
        originalGoalHasTaskPrefix
      });
      const originalRoute = await this.routerAgent.route(normalizedGoal, userProfile);
      routeDecision = this.normalizePrepareTaskRoute(normalizedGoal, originalRoute);
      this.logger.info("PREPARE_TASK route decision", {
        taskId: existingTask.id,
        userId: existingTask.userId,
        goal: normalizedGoal,
        hasTaskPrefix: hasTaskPrefix(normalizedGoal),
        routeResult: routeDecision.effective.route,
        routeDecision: routeDecision.effective,
        originalRouteResult: routeDecision.original.route,
        originalRouteDecision: routeDecision.original,
        routeOverrideApplied: routeDecision.overrideApplied
      });
      this.assertTaskRoute(routeDecision.effective);

      failureStage = "planner";
      const matchedRecipe = existingTask.recipeId
        ? existingTask.recipeId
        : matchRecipeForGoal(normalizedGoal)?.id;
      const historicalContext = await this.contextBuilder.buildHistoricalContext(
        {
          id: existingTask.id,
          userId: existingTask.userId,
          goal: normalizedGoal,
          ...(matchedRecipe ? { recipeId: matchedRecipe } : {})
        },
        undefined
      );
      const plan = await this.plannerAgent.createPlan(
        normalizedGoal,
        {
          ...this.contextBuilder.buildPlanningContext(normalizedGoal, userProfile),
          ...historicalContext.planningContext,
          ...(matchedRecipe ? { recipeId: matchedRecipe } : {}),
          ...buildRecipePlanningContext(matchedRecipe)
        }
      );
      const task = createTaskFromPlan(
        existingTask.userId,
        normalizedGoal,
        plan,
        existingTask.origin,
        {
          ...(matchedRecipe ? { recipeId: matchedRecipe } : {}),
          ...(existingTask.retryOfTaskId ? { retryOfTaskId: existingTask.retryOfTaskId } : {}),
          ...(existingTask.cancelRequestedAt
            ? { cancelRequestedAt: existingTask.cancelRequestedAt }
            : {})
        }
      );
      task.id = existingTask.id;
      task.createdAt = existingTask.createdAt;
      task.updatedAt = nowIso();
      await this.taskRepository.update(task);
      for (const reference of historicalContext.references) {
        await this.recordEvent(
          task.id,
          TaskEventKind.TaskReferenced,
          `Historical reference attached: ${reference.reason}`,
          {
            referenceId: reference.id,
            reason: reference.reason,
            sourceTaskId: reference.sourceTaskId ?? null,
            sourceArtifactId: reference.sourceArtifactId ?? null
          }
        );
      }
      await this.recordTaskStatus(task, "Task planned");
      await this.saveCheckpointAndEvent(task);

      return task;
    } catch (error) {
      this.logger.error("PREPARE_TASK failed", {
        taskId: existingTask.id,
        userId: existingTask.userId,
        failureStage,
        goal: normalizedGoal,
        goalHasTaskPrefix: hasTaskPrefix(normalizedGoal),
        originalGoal,
        originalGoalHasTaskPrefix,
        routeOverrideApplied: routeDecision?.overrideApplied ?? false,
        routeDecision: routeDecision?.effective,
        originalRouteDecision: routeDecision?.original,
        failureReason: getErrorMessage(error)
      });
      existingTask.status = TaskStatus.Failed;
      existingTask.updatedAt = nowIso();
      await this.taskRepository.update(existingTask);
      await this.recordTaskStatus(existingTask, "Task planning failed");
      await this.recordEvent(
        existingTask.id,
        TaskEventKind.Error,
        "Planning failed",
        {
          failureStage,
          message: getErrorMessage(error)
        },
        {
          level: "error"
        }
      );
      await this.saveCheckpointAndEvent(existingTask);
      throw error;
    }
  }

  async handleGoal(input: HandleGoalInput): Promise<Task> {
    const task = await this.prepareTask(input);
    return this.runTaskById(task.id);
  }

  async runTaskById(taskId: string): Promise<Task> {
    const task = await this.taskRepository.getById(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const cancelledTask = await this.maybeCancelTask(taskId, "Task cancelled before execution");
    if (cancelledTask) {
      return cancelledTask;
    }

    if (task.status === TaskStatus.Created) {
      const preparedTask = await this.prepareTaskById(taskId);
      if (
        preparedTask.status === TaskStatus.Failed ||
        preparedTask.status === TaskStatus.Cancelled
      ) {
        return preparedTask;
      }
      return this.runTaskById(taskId);
    }

    const userProfile = await this.ensureUserProfile(task.userId);
    const syncedTask = await this.syncApprovalState(task);
    if (
      syncedTask.status === TaskStatus.Completed ||
      syncedTask.status === TaskStatus.Failed ||
      syncedTask.status === TaskStatus.Cancelled
    ) {
      return syncedTask;
    }

    return this.runTask(syncedTask, userProfile);
  }

  async resumeTask(taskId: string): Promise<Task> {
    return this.runTaskById(taskId);
  }

  private async runTask(task: Task, userProfile: UserProfile): Promise<Task> {
    let currentTask = await this.syncApprovalState(task);
    const cancelledBeforeRun = await this.maybeCancelTask(
      currentTask.id,
      "Task cancelled before runnable step execution"
    );
    if (cancelledBeforeRun) {
      return cancelledBeforeRun;
    }
    let nextStep = this.scheduler.pickNextRunnableStep(currentTask);

    while (nextStep) {
      currentTask = await this.executeStep(currentTask, nextStep.id, userProfile);
      currentTask = await this.syncApprovalState(currentTask);
      const cancelledTask = await this.maybeCancelTask(
        currentTask.id,
        `Task cancelled after ${nextStep.id}`,
        nextStep.id
      );
      if (cancelledTask) {
        return cancelledTask;
      }
      if (currentTask.status === TaskStatus.WaitingApproval) {
        break;
      }
      nextStep = this.scheduler.pickNextRunnableStep(currentTask);
    }

    if (currentTask.steps.every((step) => step.status === StepStatus.Completed)) {
      currentTask.status = TaskStatus.Completed;
      const finalArtifact = pickPreferredFinalArtifact(
        currentTask.steps.flatMap((step) => step.outputArtifacts)
      );
      if (finalArtifact) {
        currentTask.finalArtifactUri = finalArtifact;
      }
      const finalArtifactValidation = this.buildFinalArtifactValidation(currentTask);
      if (finalArtifactValidation) {
        currentTask.finalArtifactValidation = finalArtifactValidation;
      }
    } else if (currentTask.steps.some((step) => step.status === StepStatus.WaitingApproval)) {
      currentTask.status = TaskStatus.WaitingApproval;
    } else if (currentTask.steps.some((step) => step.status === StepStatus.Failed)) {
      currentTask.status = TaskStatus.Failed;
    } else if (currentTask.status !== TaskStatus.WaitingApproval) {
      currentTask.status = TaskStatus.Failed;
    }

    currentTask.updatedAt = nowIso();
    await this.taskRepository.update(currentTask);
    if (currentTask.status === TaskStatus.Completed) {
      await this.taskSummaryRepository.save({
        id: `${currentTask.id}:final`,
        taskId: currentTask.id,
        userId: currentTask.userId,
        summary:
          currentTask.steps
            .map((step) => step.summary)
            .filter((summary): summary is string => typeof summary === "string" && summary.length > 0)
            .slice(-3)
            .join(" | ") || currentTask.goal,
        keywords: tokenizeKeywords(currentTask.goal),
        validated: Boolean(currentTask.finalArtifactUri),
        createdAt: nowIso(),
        ...(currentTask.recipeId ? { recipeId: currentTask.recipeId } : {})
      });
    }
    await this.recordTaskStatus(currentTask, `Task ${currentTask.status.toLowerCase()}`);
    await this.saveCheckpointAndEvent(currentTask);
    return currentTask;
  }

  private async executeStep(
    task: Task,
    stepId: string,
    userProfile: UserProfile
  ): Promise<Task> {
    const working = structuredClone(task);
    const step = working.steps.find((candidate) => candidate.id === stepId);
    if (!step) {
      throw new Error(`Step ${stepId} not found`);
    }

    const stepLogger = this.logger.child({ taskId: working.id, stepId });
    const maxRetries = getMaxRetriesForAgent(step.agent);
    const stepTimeoutMs = getStepTimeoutForAgent(step.agent, this.stepTimeoutMs);
    let attempt = step.retryCount;
    while (attempt <= maxRetries) {
      const cancelledBeforeAttempt = await this.maybeCancelTask(
        working.id,
        `Task cancelled before starting ${step.id}`,
        step.id
      );
      if (cancelledBeforeAttempt) {
        return cancelledBeforeAttempt;
      }

      step.status = StepStatus.Running;
      step.attemptStrategy = buildRuntimeAttemptStrategy(step, attempt, stepTimeoutMs);
      step.attemptHistory = [...(step.attemptHistory ?? []), step.attemptStrategy];
      working.status = attempt === 0 ? TaskStatus.Running : TaskStatus.Retrying;
      working.updatedAt = nowIso();
      await this.taskRepository.update(working);
      await this.recordStepStatus(
        working.id,
        step,
        `Step ${step.id} running`,
        attempt === 0 ? "info" : "warn"
      );
      await this.recordTaskStatus(working, `Task ${working.status.toLowerCase()} on ${step.id}`);

      const artifacts = await this.artifactRepository.listByTask(working.id);
      const latestApproval = await this.approvalRequestRepository.findLatestByTaskStep(
        working.id,
        step.id
      );
      const historicalContext = await this.contextBuilder.buildHistoricalContext(
        {
          id: working.id,
          userId: working.userId,
          goal: working.goal,
          ...(working.recipeId ? { recipeId: working.recipeId } : {})
        },
        step.taskClass
      );
      for (const reference of historicalContext.references) {
        await this.recordEvent(
          working.id,
          TaskEventKind.TaskReferenced,
          `Reference attached during ${step.id}: ${reference.reason}`,
          {
            referenceId: reference.id,
            sourceTaskId: reference.sourceTaskId ?? null,
            sourceArtifactId: reference.sourceArtifactId ?? null,
            reason: reference.reason
          },
          { stepId: step.id }
        );
      }
      const context = this.contextBuilder.buildStepContext(
        working,
        step,
        userProfile,
        artifacts,
        historicalContext.planningContext
      );
      const approvalPayload = asJsonObject(latestApproval?.payload);
      if (latestApproval) {
        context["approvalStatus"] = latestApproval.status;
        const actionUrl = asString(approvalPayload["url"]);
        if (actionUrl) {
          context["actionUrl"] = actionUrl;
        }
      }
      const request: AgentRequest = {
        taskId: working.id,
        stepId: step.id,
        goal: working.goal,
        context,
        successCriteria: step.successCriteria,
        artifacts: artifacts.map((artifact) => artifact.uri)
      };

      let response: AgentResponse;
      try {
        response = await this.executeAgentWithTimeout(step.agent, request, stepTimeoutMs);
      } catch (timeoutError) {
        if (timeoutError instanceof StepTimeoutError) {
          step.status = StepStatus.Failed;
          step.error = {
            code: ErrorCode.StepTimeout,
            message: timeoutError.message,
            retryable: false
          };
          working.status = TaskStatus.Failed;
          working.updatedAt = nowIso();
          await this.taskRepository.update(working);
          stepLogger.error("Step execution timeout", { timeoutMs: stepTimeoutMs });
          await this.recordStepStatus(working.id, step, `Step ${step.id} timed out`, "error");
          await this.recordTaskStatus(working, `Task failed: step ${step.id} timed out`);
          await this.recordEvent(
            working.id,
            TaskEventKind.Error,
            `Step ${step.id} execution timed out after ${stepTimeoutMs}ms`,
            { timeoutMs: stepTimeoutMs },
            { stepId: step.id, level: "error" }
          );
          await this.saveCheckpointAndEvent(working, step.id);
          return working;
        }
        throw timeoutError;
      }
      this.applyStepResponse(step, response);
      step.evidencePackage = this.buildEvidencePackage(step);
      if (
        response.structuredData &&
        ((response.structuredData["llmFallbackUsed"] as boolean | undefined) === true ||
          (response.structuredData["synthesisFallbackUsed"] as boolean | undefined) === true)
      ) {
        await this.recordEvent(
          working.id,
          TaskEventKind.RecoveryFallbackUsed,
          `Fallback used during ${step.id}`,
          {
            agent: step.agent,
            fallbackKind:
              String(
                response.structuredData["fallbackKind"] ??
                  response.structuredData["llmFallbackCategory"] ??
                  response.structuredData["synthesisFallbackReason"] ??
                  "unknown"
              ),
            attempt
          },
          { stepId: step.id, level: "warn" }
        );
      }
      const cancelledAfterAgent = await this.maybeCancelTask(
        working.id,
        `Task cancelled during ${step.id}`,
        step.id
      );
      if (cancelledAfterAgent) {
        return cancelledAfterAgent;
      }

      if (response.status === "need_approval") {
        await this.createPendingApproval(working, step, response);
        step.status = StepStatus.WaitingApproval;
        step.error = {
          code: ErrorCode.ApprovalRequired,
          message: response.summary,
          retryable: false
        };
        working.status = TaskStatus.WaitingApproval;
        working.updatedAt = nowIso();
        await this.taskRepository.update(working);
        await this.recordStepStatus(working.id, step, `Step ${step.id} waiting approval`, "warn");
        await this.recordTaskStatus(working, "Task waiting approval");
        await this.saveCheckpointAndEvent(working, step.id);
        return working;
      }

      step.status = StepStatus.Verifying;
      working.status = TaskStatus.Verifying;
      working.updatedAt = nowIso();
      await this.taskRepository.update(working);
      await this.recordStepStatus(working.id, step, `Step ${step.id} verifying`);
      await this.recordTaskStatus(working, `Task verifying ${step.id}`);

      const decision = await this.verifierAgent.verifyStep(working, step, response);
      if (typeof decision.qualityScore === "number") {
        step.qualityScore = decision.qualityScore;
      }
      if (Array.isArray(decision.qualityDefects)) {
        step.qualityDefects = decision.qualityDefects;
      }
      if (Array.isArray(decision.missingEvidence)) {
        step.missingEvidence = decision.missingEvidence;
      }
      if (typeof decision.sourceCoverageScore === "number") {
        step.sourceCoverageScore = decision.sourceCoverageScore;
      }
      if (typeof decision.formatCompliance === "string") {
        step.formatCompliance = decision.formatCompliance;
      }

      if (
        decision.verdict !== "pass" &&
        ((Array.isArray(decision.qualityDefects) && decision.qualityDefects.length > 0) ||
          (Array.isArray(decision.missingEvidence) && decision.missingEvidence.length > 0))
      ) {
        await this.recordEvent(
          working.id,
          TaskEventKind.QualityGateFailed,
          `Quality gate failed for ${step.id}`,
          {
            qualityScore: decision.qualityScore ?? null,
            qualityDefects: decision.qualityDefects ?? [],
            missingEvidence: decision.missingEvidence ?? [],
            sourceCoverageScore: decision.sourceCoverageScore ?? null,
            formatCompliance: decision.formatCompliance ?? null
          },
          { stepId: step.id, level: "warn" }
        );
      }
      if (decision.verdict === "pass") {
        step.status = StepStatus.Completed;
        delete step.error;
        working.status = TaskStatus.Running;
        await this.markApprovalExecutedIfNeeded(working.id, step.id);
        this.memoryWriter.recordStepResult(working, step);
        await this.taskRepository.update(working);
        await this.persistKnowledgeForStep(working, step);
        if (
          response.structuredData &&
          typeof response.structuredData["artifactValidation"] === "object" &&
          response.structuredData["artifactValidation"] !== null
        ) {
          await this.recordEvent(
            working.id,
            TaskEventKind.ArtifactValidated,
            `Artifact validation captured for ${step.id}`,
            response.structuredData["artifactValidation"] as JsonObject,
            { stepId: step.id }
          );
        }
        await this.recordStepStatus(working.id, step, `Step ${step.id} completed`);
        await this.recordTaskStatus(working, `Task running after ${step.id}`);
        await this.saveCheckpointAndEvent(working, step.id);
        return working;
      }

      if (decision.verdict === "retry_step" && attempt < maxRetries) {
        attempt += 1;
        step.retryCount = attempt;
        step.status = StepStatus.Pending;
        step.attemptStrategy = buildRuntimeAttemptStrategy(step, attempt, stepTimeoutMs);
        working.status = TaskStatus.Retrying;
        stepLogger.warn("Retrying step", {
          attempt,
          reason: decision.reason
        });
        step.error = {
          code: ErrorCode.Unknown,
          message: decision.reason,
          retryable: true,
          stage: "verification",
          category: "retry_step"
        };
        await this.recordEvent(
          working.id,
          TaskEventKind.AttemptEscalated,
          `Escalating retry strategy for ${step.id}`,
          {
            attempt,
            agent: step.agent,
            strategy: step.attemptStrategy
          },
          { stepId: step.id, level: "warn" }
        );
        await this.recordStepStatus(working.id, step, `Step ${step.id} retry requested`, "warn");
        await this.recordTaskStatus(working, `Task retrying ${step.id}`);
        continue;
      }

      if (decision.verdict === "replan_task") {
        return this.partialReplanTask(
          working,
          step,
          userProfile,
          decision.reason || "verifier requested replan"
        );
      }

      step.status =
        decision.verdict === "ask_user" ? StepStatus.WaitingApproval : StepStatus.Failed;
      working.status =
        decision.verdict === "ask_user" ? TaskStatus.WaitingApproval : TaskStatus.Replanning;
      step.error = {
        code:
          decision.verdict === "ask_user"
            ? ErrorCode.ClarificationRequired
            : ErrorCode.Unknown,
        message: decision.reason,
        retryable: false
      };
      working.updatedAt = nowIso();
      await this.taskRepository.update(working);
      await this.recordStepStatus(
        working.id,
        step,
        `Step ${step.id} ${decision.verdict === "ask_user" ? "waiting user input" : "failed"}`,
        decision.verdict === "ask_user" ? "warn" : "error"
      );
      await this.recordTaskStatus(
        working,
        decision.verdict === "ask_user" ? "Task waiting user input" : "Task replanning required"
      );
      await this.recordEvent(
        working.id,
        TaskEventKind.Error,
        `Verifier returned ${decision.verdict} for ${step.id}`,
        {
          verdict: decision.verdict,
          reason: decision.reason,
          missingCriteria: decision.missingCriteria,
          suggestedFix: decision.suggestedFix,
          qualityScore: decision.qualityScore ?? null,
          qualityDefects: decision.qualityDefects ?? [],
          missingEvidence: decision.missingEvidence ?? []
        },
        {
          stepId: step.id,
          level: decision.verdict === "ask_user" ? "warn" : "error"
        }
      );
      await this.saveCheckpointAndEvent(working, step.id);
      return working;
    }

    if ([AgentKind.Research, AgentKind.Browser].includes(step.agent)) {
      return this.partialReplanTask(
        working,
        step,
        userProfile,
        "retry budget exhausted"
      );
    }

    step.status = StepStatus.Failed;
    working.status = TaskStatus.Failed;
    working.updatedAt = nowIso();
    await this.taskRepository.update(working);
    await this.recordStepStatus(working.id, step, `Step ${step.id} failed`, "error");
    await this.recordTaskStatus(working, `Task failed on ${step.id}`);
    await this.saveCheckpointAndEvent(working, step.id);
    return working;
  }

  private async executeAgentWithTimeout(
    agentKind: Task["steps"][number]["agent"],
    request: AgentRequest,
    timeoutMs: number
  ): Promise<AgentResponse> {
    const agent = this.agentRegistry.get(agentKind);
    return new Promise<AgentResponse>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new StepTimeoutError(`Step execution timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      agent.execute(request).then(
        (result) => { clearTimeout(timer); resolve(result); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
  }

  private async syncApprovalState(task: Task): Promise<Task> {
    const working = structuredClone(task);
    let changed = false;
    let hasPendingApproval = false;

    for (const step of working.steps.filter((candidate) => candidate.status === StepStatus.WaitingApproval)) {
      const approval = await this.approvalRequestRepository.findLatestByTaskStep(working.id, step.id);
      if (!approval || approval.status === ApprovalStatus.Pending) {
        hasPendingApproval = true;
        continue;
      }

      if (approval.status === ApprovalStatus.Rejected) {
        step.status = StepStatus.Failed;
        step.error = {
          code: ErrorCode.PermissionDenied,
          message: approval.decisionNote ?? approval.reason,
          retryable: false,
          stage: "approval",
          category: "approval_rejected",
          upstreamErrorMessage: approval.reason
        };
        changed = true;
        continue;
      }

      if (approval.status === ApprovalStatus.Approved) {
        step.status = StepStatus.Pending;
        delete step.error;
        changed = true;
      }
    }

    if (working.steps.some((step) => step.status === StepStatus.Failed)) {
      working.status = TaskStatus.Failed;
      changed = true;
    } else if (hasPendingApproval) {
      working.status = TaskStatus.WaitingApproval;
    } else if (changed && working.status === TaskStatus.WaitingApproval) {
      working.status = TaskStatus.Running;
    }

    if (changed) {
      working.updatedAt = nowIso();
      await this.taskRepository.update(working);
      await this.recordTaskStatus(working, `Task ${working.status.toLowerCase()} after approval sync`);
      await this.saveCheckpointAndEvent(working);
    }

    return working;
  }

  private async createPendingApproval(
    task: Task,
    step: Task["steps"][number],
    response: AgentResponse
  ): Promise<ApprovalRequest> {
    const latest = await this.approvalRequestRepository.findLatestByTaskStep(task.id, step.id);
    if (latest && latest.status === ApprovalStatus.Pending) {
      return latest;
    }

    const structured = asJsonObject(response.structuredData);
    const approvalPayload = asJsonObject(structured["approvalPayload"]);
    const approvalRequest: ApprovalRequest = {
      id: createId("approval"),
      taskId: task.id,
      stepId: step.id,
      toolName: coerceToolName(structured["toolName"]),
      action: asString(structured["action"]) ?? "post_webhook",
      status: ApprovalStatus.Pending,
      reason: asString(structured["approvalReason"]) ?? response.summary,
      payload: approvalPayload,
      requestedAt: nowIso()
    };

    const created = await this.approvalRequestRepository.create(approvalRequest);
    await this.recordEvent(
      task.id,
      TaskEventKind.Approval,
      `Approval created for ${step.id}`,
      {
        approvalId: created.id,
        toolName: created.toolName,
        action: created.action,
        status: created.status
      },
      {
        stepId: step.id,
        level: "warn"
      }
    );
    return created;
  }

  private async markApprovalExecutedIfNeeded(taskId: string, stepId: string): Promise<void> {
    const approval = await this.approvalRequestRepository.findLatestByTaskStep(taskId, stepId);
    if (!approval || approval.status !== ApprovalStatus.Approved) {
      return;
    }

    approval.status = ApprovalStatus.Executed;
    if (!approval.decidedAt) {
      approval.decidedAt = nowIso();
    }
    await this.approvalRequestRepository.update(approval);
    await this.recordEvent(
      taskId,
      TaskEventKind.Approval,
      `Approval executed for ${stepId}`,
      {
        approvalId: approval.id,
        status: approval.status
      },
      {
        stepId,
        level: "info"
      }
    );
  }

  private applyStepResponse(step: Task["steps"][number], response: AgentResponse): void {
    step.summary = response.summary;
    step.outputArtifacts = response.artifacts ?? [];
    step.structuredData = response.structuredData ?? {};
    if (response.error) {
      const structured = asJsonObject(response.structuredData);
      step.error = {
        ...response.error,
        ...(typeof structured["stage"] === "string" ? { stage: structured["stage"] } : {}),
        ...(typeof structured["category"] === "string"
          ? { category: structured["category"] }
          : {}),
        ...(typeof structured["upstreamErrorMessage"] === "string"
          ? { upstreamErrorMessage: structured["upstreamErrorMessage"] }
          : {}),
        ...(typeof structured["llmFallbackUsed"] === "boolean"
          ? { fallbackUsed: Boolean(structured["llmFallbackUsed"]) }
          : typeof structured["synthesisFallbackUsed"] === "boolean"
            ? { fallbackUsed: Boolean(structured["synthesisFallbackUsed"]) }
            : {}),
        ...(typeof structured["fallbackKind"] === "string"
          ? { fallbackKind: structured["fallbackKind"] }
          : typeof structured["llmFallbackCategory"] === "string"
            ? { fallbackKind: structured["llmFallbackCategory"] }
            : {})
      };
    }
  }

  private normalizePrepareTaskRoute(
    goal: string,
    route: RouteDecision
  ): {
    original: RouteDecision;
    effective: RouteDecision;
    overrideApplied: boolean;
  } {
    if (!hasTaskPrefix(goal) || isExecutableRoute(route.route)) {
      return {
        original: route,
        effective: route,
        overrideApplied: false
      };
    }

    return {
      original: route,
      effective: buildPrefixedTaskRoute(goal, "prepare_task", route),
      overrideApplied: true
    };
  }

  private assertTaskRoute(route: RouteDecision): void {
    if (route.route === "chat" || route.route === "ask_clarification") {
      throw new Error(`Goal was routed as ${route.route}, not as an executable task.`);
    }
  }

  private async ensureUserProfile(userId: string): Promise<UserProfile> {
    const existing = await this.userProfileRepository.getByUserId(userId);
    if (existing) {
      return existing;
    }

    const profile: UserProfile = {
      userId,
      language: "zh-CN",
      outputStyle: "concise",
      riskPolicy: "balanced",
      preferences: {},
      updatedAt: nowIso()
    };
    await this.userProfileRepository.save(profile);
    return profile;
  }

  private async cloneUploadedArtifactsForRetry(sourceTask: Task, retryTask: Task): Promise<void> {
    const sourceArtifacts = await this.artifactRepository.listByTask(sourceTask.id);
    const uploadedArtifacts = sourceArtifacts.filter(
      (artifact) => artifact.metadata["uploaded"] === true
    );

    if (uploadedArtifacts.length === 0) {
      return;
    }

    const clonedArtifacts = await Promise.all(
      uploadedArtifacts.map(async (artifact) => {
        const resolvedSource = path.resolve(artifact.uri);
        const originalFilename =
          typeof artifact.metadata["originalFilename"] === "string"
            ? String(artifact.metadata["originalFilename"])
            : path.basename(resolvedSource);
        const relativeTarget = path.join("uploads", `${artifact.id}-${path.basename(originalFilename)}`);
        await fs.access(resolvedSource);
        const clonedUri = await this.workspaceManager.copyFileIntoTaskWorkspace(
          retryTask.id,
          resolvedSource,
          relativeTarget
        );

        return this.artifactRepository.save({
          ...artifact,
          id: createId("artifact"),
          taskId: retryTask.id,
          uri: clonedUri,
          createdAt: nowIso(),
          metadata: {
            ...artifact.metadata,
            clonedFromTaskId: sourceTask.id,
            clonedFromArtifactId: artifact.id
          }
        });
      })
    );

    await this.recordEvent(
      retryTask.id,
      TaskEventKind.Tool,
      `Cloned ${clonedArtifacts.length} uploaded artifact(s) from retry source`,
      {
        sourceTaskId: sourceTask.id,
        artifactIds: clonedArtifacts.map((artifact) => artifact.id)
      }
    );
  }

  private getQualityThreshold(taskClass?: TaskClass): number {
    if (taskClass === TaskClass.ResearchBrowser) {
      return 75;
    }
    if (taskClass === TaskClass.WideResearch) {
      return 80;
    }
    if (taskClass === TaskClass.ActionExecution) {
      return 80;
    }
    return 80;
  }

  private buildEvidencePackage(step: Task["steps"][number]): JsonObject {
    const structured = asJsonObject(step.structuredData);
    return {
      ...(Array.isArray(structured["sources"]) ? { sources: structured["sources"] } : {}),
      ...(Array.isArray(structured["sourceTiers"]) ? { sourceTiers: structured["sourceTiers"] } : {}),
      ...(Array.isArray(structured["findings"]) ? { findings: structured["findings"] } : {}),
      ...(Array.isArray(structured["subqueryResults"])
        ? { subqueryResults: structured["subqueryResults"] }
        : {}),
      ...(Array.isArray(structured["timelineEvents"])
        ? { timelineEvents: structured["timelineEvents"] }
        : {}),
      ...(Array.isArray(structured["extractedFacts"])
        ? { extractedFacts: structured["extractedFacts"] }
        : {}),
      ...(Array.isArray(structured["evidencePoints"])
        ? { evidencePoints: structured["evidencePoints"] }
        : {}),
      ...(Array.isArray(structured["attemptSummaries"])
        ? { attemptSummaries: structured["attemptSummaries"] }
        : {}),
      ...(Array.isArray(structured["captures"]) ? { captures: structured["captures"] } : {}),
      ...(Array.isArray(structured["pageQualitySignals"])
        ? { pageQualitySignals: structured["pageQualitySignals"] }
        : {}),
      ...(Array.isArray(structured["generatedFiles"])
        ? { generatedFiles: structured["generatedFiles"] }
        : {}),
      ...(typeof structured["reportPreview"] === "string"
        ? { reportPreview: structured["reportPreview"] }
        : {}),
      ...(Array.isArray(structured["keySections"])
        ? { keySections: structured["keySections"] }
        : {}),
      ...(typeof structured["artifactValidation"] === "object" &&
      structured["artifactValidation"] !== null
        ? { artifactValidation: structured["artifactValidation"] }
        : {})
    };
  }

  private async persistWideResearchForStep(
    task: Task,
    step: Task["steps"][number]
  ): Promise<void> {
    const structured = asJsonObject(step.structuredData);
    const searchQueries = Array.isArray(structured["searchQueries"])
      ? structured["searchQueries"].map((item) => String(item)).filter(Boolean)
      : [];
    const subqueryResults = Array.isArray(structured["subqueryResults"])
      ? structured["subqueryResults"].map((item) => asJsonObject(item))
      : [];
    const sources = Array.isArray(structured["sources"]) ? structured["sources"] : [];
    if (
      searchQueries.length === 0 &&
      subqueryResults.length === 0 &&
      step.taskClass !== TaskClass.WideResearch
    ) {
      return;
    }

    const existing = await this.wideResearchRunRepository.getByStep(task.id, step.id);
    const runId = existing?.id ?? createId("widerun");
    const items = searchQueries.map((query, index): {
      id: string;
      wideResearchRunId: string;
      taskId: string;
      stepId: string;
      orderIndex: number;
      query: string;
      title?: string;
      status: "COMPLETED" | "FAILED";
      sourceCount?: number;
      summary?: string;
      errorMessage?: string;
      metadata: JsonObject;
      createdAt: string;
      updatedAt: string;
    } => {
      const result = subqueryResults[index] ?? {};
      const sourceCount =
        typeof result["sourceCount"] === "number"
          ? Number(result["sourceCount"])
          : Array.isArray(result["sources"])
            ? result["sources"].length
            : 0;
      const failed = sourceCount <= 0 && step.status !== StepStatus.Completed;
      return {
        id: `${runId}:item:${index + 1}`,
        wideResearchRunId: runId,
        taskId: task.id,
        stepId: step.id,
        orderIndex: index,
        query,
        ...(typeof result["title"] === "string" ? { title: String(result["title"]) } : {}),
        status: failed ? "FAILED" : "COMPLETED",
        ...(sourceCount > 0 ? { sourceCount } : {}),
        ...(typeof result["summary"] === "string"
          ? { summary: String(result["summary"]) }
          : typeof result["snippet"] === "string"
            ? { summary: String(result["snippet"]).slice(0, 280) }
            : {}),
        ...(failed ? { errorMessage: "No source evidence returned for subquery" } : {}),
        metadata: {
          ...result,
          query
        },
        createdAt: existing?.createdAt ?? nowIso(),
        updatedAt: nowIso()
      };
    });

    const completedItems = items.filter((item) => item.status === "COMPLETED").length;
    const failedItems = items.length - completedItems;

    await this.wideResearchRunRepository.save({
      id: runId,
      taskId: task.id,
      stepId: step.id,
      planVersion: task.currentPlanVersion,
      goal: task.goal,
      status: failedItems > 0 && completedItems === 0 ? "FAILED" : "COMPLETED",
      totalItems: items.length || subqueryResults.length || 1,
      completedItems,
      failedItems,
      ...(sources.length > 0 ? { aggregatedSourceCount: sources.length } : {}),
      metadata: {
        taskClass: step.taskClass ?? TaskClass.WideResearch,
        searchQueries,
        ...(structured["wideResearch"] === true ? { wideResearch: true } : {})
      },
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso()
    });
    if (items.length > 0) {
      await this.wideResearchItemRepository.replaceForRun(runId, items);
    }
    await this.recordEvent(
      task.id,
      TaskEventKind.WideResearchUpdated,
      `Wide research run updated for ${step.id}`,
      {
        stepId: step.id,
        runId,
        totalItems: items.length || subqueryResults.length || 1,
        completedItems,
        failedItems,
        aggregatedSourceCount: sources.length
      },
      {
        stepId: step.id
      }
    );
  }

  private async persistKnowledgeForStep(task: Task, step: Task["steps"][number]): Promise<void> {
    if (step.status !== StepStatus.Completed) {
      return;
    }

    await this.persistWideResearchForStep(task, step);

    const taskClass = step.taskClass;
    const qualityThreshold = this.getQualityThreshold(taskClass);
    const validated =
      typeof step.qualityScore === "number"
        ? step.qualityScore >= qualityThreshold
        : !step.error;
    const summaryKeywords = tokenizeKeywords(
      [task.goal, step.title, step.summary ?? "", step.objective].join(" ")
    );

    await this.taskSummaryRepository.save({
      id: `${task.id}:${step.id}`,
      taskId: task.id,
      userId: task.userId,
      ...(taskClass ? { taskClass } : {}),
      ...(task.recipeId ? { recipeId: task.recipeId } : {}),
      summary: step.summary ?? step.title,
      keywords: summaryKeywords,
      validated,
      createdAt: nowIso()
    });

    const artifacts = await this.artifactRepository.listByTask(task.id);
    const outputArtifactSet = new Set(step.outputArtifacts);
    const candidateArtifacts = artifacts.filter((artifact) => outputArtifactSet.has(artifact.uri));
    for (const artifact of candidateArtifacts) {
      const structured = asJsonObject(step.structuredData);
      const artifactValidation = asJsonObject(structured["artifactValidation"]);
      const artifactValidated =
        typeof artifact.validated === "boolean"
          ? artifact.validated
          : artifactValidation["validated"] === false
            ? false
            : validated;
      await this.artifactIndexRepository.save({
        id: `artidx:${artifact.id}`,
        taskId: task.id,
        ...(artifact.stepId ? { stepId: artifact.stepId } : {}),
        artifactId: artifact.id,
        artifactType: artifact.type,
        uri: artifact.uri,
        ...(artifact.title ? { title: artifact.title } : step.summary ? { title: step.title } : {}),
        ...(artifact.summary
          ? { summary: artifact.summary }
          : step.summary
            ? { summary: step.summary }
            : {}),
        keywords: uniqueStrings([
          ...tokenizeKeywords([task.goal, step.title, step.summary ?? ""].join(" ")),
          ...(artifact.keywords ?? [])
        ]),
        validated: artifactValidated,
        ...(taskClass ? { taskClass } : {}),
        ...(task.recipeId ? { recipeId: task.recipeId } : {}),
        createdAt: artifact.createdAt
      });
    }
  }

  private buildFinalArtifactValidation(task: Task): Task["finalArtifactValidation"] | undefined {
    const finalStep = [...task.steps].reverse().find((step) => step.outputArtifacts.length > 0);
    if (!finalStep) {
      return undefined;
    }
    const structured = asJsonObject(finalStep.structuredData);
    const artifactValidation = asJsonObject(structured["artifactValidation"]);
    if (Object.keys(artifactValidation).length === 0) {
      return undefined;
    }
    const validation: NonNullable<Task["finalArtifactValidation"]> = {
      validated: artifactValidation["validated"] !== false,
      issues: Array.isArray(artifactValidation["issues"])
        ? artifactValidation["issues"].map((item) => String(item))
        : []
    };
    if (typeof artifactValidation["artifactType"] === "string") {
      validation.artifactType = artifactValidation["artifactType"] as ArtifactType;
    }
    if (typeof artifactValidation["deliveryKind"] === "string") {
      validation.deliveryKind = artifactValidation["deliveryKind"] as DeliveryKind;
    }
    if (typeof artifactValidation["pageCount"] === "number") {
      validation.pageCount = artifactValidation["pageCount"];
    }
    return validation;
  }

  private async partialReplanTask(
    task: Task,
    failedStep: Task["steps"][number],
    userProfile: UserProfile,
    reason: string
  ): Promise<Task> {
    const working = structuredClone(task);
    const completedStepIds = new Set(
      working.steps.filter((step) => step.status === StepStatus.Completed).map((step) => step.id)
    );
    const historicalContext = await this.contextBuilder.buildHistoricalContext(
      {
        id: working.id,
        userId: working.userId,
        goal: working.goal,
        ...(working.recipeId ? { recipeId: working.recipeId } : {})
      },
      failedStep.taskClass
    );
    const repairedPlan = await this.replannerAgent.repairPlan(working, failedStep, {
      ...this.contextBuilder.buildPlanningContext(working.goal, userProfile),
      ...historicalContext.planningContext,
      failedStepId: failedStep.id,
      failedStepSummary: failedStep.summary ?? "",
      failedStepError: failedStep.error
        ? JSON.parse(JSON.stringify(failedStep.error)) as JsonObject
        : null
    });
    const preservedPlanSteps = working.plan.steps.filter((step) => completedStepIds.has(step.id));
    const rebuiltSteps = repairedPlan.steps.map((step) => ({
      id: step.id,
      title: step.title,
      agent: step.agent,
      ...(step.taskClass ? { taskClass: step.taskClass } : {}),
      ...(step.qualityProfile ? { qualityProfile: step.qualityProfile } : {}),
      ...(step.attemptStrategy ? { attemptStrategy: step.attemptStrategy } : {}),
      objective: step.objective,
      dependsOn: step.dependsOn,
      status: StepStatus.Pending,
      retryCount: 0,
      successCriteria: step.successCriteria,
      inputArtifacts: [],
      outputArtifacts: [],
      structuredData: {},
      evidencePackage: {},
      attemptHistory: [],
      referenceArtifactIds: historicalContext.references
        .flatMap((reference) => (reference.sourceArtifactId ? [reference.sourceArtifactId] : []))
    }));
    working.plan = {
      goal: working.goal,
      assumptions: uniqueStrings([...working.plan.assumptions, ...repairedPlan.assumptions]),
      steps: [...preservedPlanSteps, ...repairedPlan.steps],
      taskSuccessCriteria: uniqueStrings([
        ...working.plan.taskSuccessCriteria,
        ...repairedPlan.taskSuccessCriteria
      ])
    };
    working.steps = [
      ...working.steps.filter((step) => completedStepIds.has(step.id)),
      ...rebuiltSteps
    ];
    working.currentPlanVersion += 1;
    working.status = TaskStatus.Planned;
    working.updatedAt = nowIso();
    await this.taskRepository.update(working);
    await this.recordEvent(
      working.id,
      TaskEventKind.AttemptEscalated,
      `Partial replan applied after ${failedStep.id}`,
      {
        failedStepId: failedStep.id,
        reason,
        planVersion: working.currentPlanVersion,
        preservedSteps: [...completedStepIds],
        newSteps: rebuiltSteps.map((step) => step.id)
      },
      { stepId: failedStep.id, level: "warn" }
    );
    await this.recordTaskStatus(working, `Task replanned after ${failedStep.id}`);
    await this.saveCheckpointAndEvent(working, failedStep.id);
    return working;
  }
}

export class TaskQueueWorker {
  constructor(
    private readonly orchestrator: TaskOrchestrator,
    private readonly taskJobRepository: TaskJobRepository,
    private readonly taskEventRepository: TaskEventRepository,
    private readonly logger: Logger,
    private readonly workerId = createId("worker"),
    private readonly leaseTimeoutMs = 30_000,
    private readonly heartbeatIntervalMs = Math.max(1_000, Math.floor(leaseTimeoutMs / 3))
  ) {}

  async runNextJob(): Promise<boolean> {
    const job = await this.taskJobRepository.claimNext(this.workerId, this.leaseTimeoutMs);
    if (!job) {
      return false;
    }
    if (job.payload["reclaimedFromStaleLease"] === true) {
      await this.taskEventRepository.create(
        createTaskEvent(
          job.taskId,
          TaskEventKind.StaleJobReclaimed,
          `${job.kind} reclaimed after stale lease`,
          {
            kind: job.kind,
            workerId: this.workerId,
            attempts: job.attempts
          },
          {
            jobId: job.id,
            level: "warn"
          }
        )
      );
    }
    await this.taskEventRepository.create(
      createTaskEvent(
        job.taskId,
        TaskEventKind.Job,
        `${job.kind} claimed by ${this.workerId}`,
        {
          kind: job.kind,
          status: job.status,
          workerId: this.workerId,
          attempts: job.attempts
        },
        {
          jobId: job.id
        }
      )
    );

    const jobLogger = this.logger.child({ workerId: this.workerId, jobId: job.id, taskId: job.taskId });
    const heartbeat = setInterval(() => {
      void this.taskJobRepository.heartbeat(job.id, this.workerId).then((ok) => {
        if (!ok) {
          jobLogger.warn("Task job heartbeat lost lease", {});
        }
      });
    }, this.heartbeatIntervalMs);

    try {
      if (job.kind === TaskJobKind.PrepareTask) {
        const preparedTask = await this.orchestrator.prepareTaskById(job.taskId);
        if (preparedTask.status === TaskStatus.Planned) {
          const nextJob = await this.taskJobRepository.enqueue(
            createTaskJob(job.taskId, TaskJobKind.ExecuteTask)
          );
          await this.taskEventRepository.create(
            createTaskEvent(
              job.taskId,
              TaskEventKind.Job,
              `${nextJob.kind} enqueued`,
              {
                kind: nextJob.kind,
                status: nextJob.status
              },
              {
                jobId: nextJob.id
              }
            )
          );
        }
      } else if (job.kind === TaskJobKind.ExecuteTask) {
        await this.orchestrator.runTaskById(job.taskId);
      } else {
        await this.orchestrator.resumeTask(job.taskId);
      }

      await this.taskJobRepository.markCompleted(job.id, this.workerId);
      await this.taskEventRepository.create(
        createTaskEvent(
          job.taskId,
          TaskEventKind.Job,
          `${job.kind} completed`,
          {
            kind: job.kind,
            workerId: this.workerId
          },
          {
            jobId: job.id
          }
        )
      );
      jobLogger.info("Task job completed", { kind: job.kind });
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = isRetryableJobError(error);
      try {
        if (retryable) {
          await this.orchestrator.prepareTaskForRetry(job.taskId, job.kind, message);
        }
        await this.taskJobRepository.markFailed(job.id, this.workerId, message, retryable);
        await this.taskEventRepository.create(
          createTaskEvent(
            job.taskId,
            TaskEventKind.Job,
            `${job.kind} failed`,
            {
              kind: job.kind,
              workerId: this.workerId,
              error: message
            },
            {
              jobId: job.id,
              level: "error"
            }
          )
        );
      } catch (markFailedError: unknown) {
        jobLogger.warn("Task job could not be marked failed", {
          error:
            markFailedError instanceof Error
              ? markFailedError.message
              : String(markFailedError)
        });
      }
      jobLogger.error("Task job failed", { kind: job.kind, error: message });
      return true;
    } finally {
      clearInterval(heartbeat);
    }
  }
}

export const buildDemoRuntime = (
  workspaceRoot: string,
  logger: Logger = process.env.OPENCLAW_LOG_FORMAT === "json"
    ? new StructuredLogger()
    : new ConsoleLogger()
) => {
  const modelRouter = new ModelRouter();
  const openAiClientOptions: ConstructorParameters<typeof OpenAIResponsesClient>[1] = {};
  if (process.env.OPENAI_API_KEY) {
    openAiClientOptions.apiKey = process.env.OPENAI_API_KEY;
  }
  if (process.env.OPENAI_BASE_URL) {
    openAiClientOptions.baseUrl = process.env.OPENAI_BASE_URL;
  }
  if (process.env.OPENAI_TIMEOUT_MS) {
    openAiClientOptions.timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS);
  }
  if (process.env.OPENAI_SEARCH_TIMEOUT_MS) {
    openAiClientOptions.searchTimeoutMs = Number(process.env.OPENAI_SEARCH_TIMEOUT_MS);
  }
  const defaultSearchLocation = resolveDefaultSearchLocation();
  if (defaultSearchLocation) {
    openAiClientOptions.defaultSearchLocation = defaultSearchLocation;
  }
  const openAiClient = new OpenAIResponsesClient(modelRouter, openAiClientOptions);
  const repositories =
    resolveDbMode() === "prisma"
      ? createPrismaRepositories(process.env.DATABASE_URL)
      : createInMemoryRepositories();
  const {
    taskRepository,
    taskEventRepository,
    artifactRepository,
    taskSummaryRepository,
    artifactIndexRepository,
    taskReferenceRepository,
    wideResearchRunRepository,
    wideResearchItemRepository,
    approvalRequestRepository,
    checkpointRepository,
    taskJobRepository,
    userProfileRepository,
    toolCallRepository,
    memoryRepository,
    benchmarkRunRepository,
    benchmarkRunItemRepository,
    prisma
  } = repositories;
      const workspaceManager = new WorkspaceManager(workspaceRoot);
  const artifactRegistry = new ArtifactRegistry(artifactRepository, workspaceManager);
  const toolMode = resolveToolExecutionMode();
  const agentMode = resolveAgentExecutionMode();
  const searchToolOptions: ConstructorParameters<typeof SearchTool>[1] = {
    mode: toolMode
  };
  const searchAllowedDomains = resolveSearchAllowedDomains();
  if (searchAllowedDomains) {
    searchToolOptions.allowedDomains = searchAllowedDomains;
  }
  const browserToolOptions: ConstructorParameters<typeof BrowserTool>[1] = {
    mode: resolveBrowserMode(toolMode),
    headless: process.env.PLAYWRIGHT_HEADLESS !== "0",
    defaultScreenshot: true,
    profileRootDir: path.resolve(workspaceRoot, "..", "profiles")
  };
  if (process.env.PLAYWRIGHT_BROWSER_CHANNEL) {
    browserToolOptions.channel = process.env.PLAYWRIGHT_BROWSER_CHANNEL;
  }
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) {
    browserToolOptions.executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  }
  const actionToolOptions: ConstructorParameters<typeof ActionTool>[0] = {
    mode: toolMode,
    ...(process.env.OPENCLAW_ACTION_WEBHOOK_URL
      ? { defaultUrl: process.env.OPENCLAW_ACTION_WEBHOOK_URL }
      : {}),
    ...(process.env.OPENCLAW_SLACK_WEBHOOK_URL
      ? { slackWebhookUrl: process.env.OPENCLAW_SLACK_WEBHOOK_URL }
      : {}),
    ...(process.env.OPENCLAW_NOTION_TOKEN || process.env.OPENCLAW_NOTION_PARENT_PAGE_ID
      ? {
          ...(process.env.OPENCLAW_NOTION_TOKEN
            ? { notionToken: process.env.OPENCLAW_NOTION_TOKEN }
            : {}),
          ...(process.env.OPENCLAW_NOTION_PARENT_PAGE_ID
            ? { notionParentPageId: process.env.OPENCLAW_NOTION_PARENT_PAGE_ID }
            : {})
        }
      : {}),
    ...(
      process.env.OPENCLAW_SMTP_HOST ||
      process.env.OPENCLAW_SMTP_PORT ||
      process.env.OPENCLAW_SMTP_FROM
        ? {
            smtp: {
              ...(process.env.OPENCLAW_SMTP_HOST
                ? { host: process.env.OPENCLAW_SMTP_HOST }
                : {}),
              port: Number(process.env.OPENCLAW_SMTP_PORT ?? 587),
              ...(process.env.OPENCLAW_SMTP_USER
                ? { user: process.env.OPENCLAW_SMTP_USER }
                : {}),
              ...(process.env.OPENCLAW_SMTP_PASS
                ? { pass: process.env.OPENCLAW_SMTP_PASS }
                : {}),
              ...(process.env.OPENCLAW_SMTP_FROM
                ? { from: process.env.OPENCLAW_SMTP_FROM }
                : {}),
              secure: process.env.OPENCLAW_SMTP_SECURE === "1"
            }
          }
        : {}
    )
  };
  const pythonToolOptions: ConstructorParameters<typeof PythonTool>[1] = {
    mode: toolMode,
    ...(process.env.OPENCLAW_PYTHON_EXECUTABLE
      ? { pythonExecutable: process.env.OPENCLAW_PYTHON_EXECUTABLE }
      : {})
  };
  const toolRuntime = new ToolRuntime(
    [
      new SearchTool(openAiClient, searchToolOptions),
      new BrowserTool(workspaceManager, browserToolOptions),
      new PythonTool(workspaceManager, pythonToolOptions),
      new FilesystemTool(),
      new DocumentTool(workspaceManager, {
        llmClient: openAiClient,
        mode: toolMode,
        headless: process.env.PLAYWRIGHT_HEADLESS !== "0",
        ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL
          ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL }
          : {}),
        ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
          : {})
      }),
      new ActionTool(actionToolOptions)
    ],
    new ToolPolicyService(),
    artifactRegistry,
    toolCallRepository,
    taskEventRepository,
    logger,
    repositories.browserSessionRepository
  );

  const routerAgent = new RouterAgent(modelRouter, openAiClient, agentMode);
  const plannerAgent = new PlannerAgent(modelRouter, openAiClient, agentMode);
  const replannerAgent = new ReplannerAgent(modelRouter, openAiClient, agentMode);
  const verifierAgent = new VerifierAgent(modelRouter, openAiClient, agentMode);
  const agentRegistry = new AgentRegistry([
    new ResearchAgent(toolRuntime, modelRouter, openAiClient, agentMode),
    new BrowserAgent(toolRuntime, modelRouter, openAiClient, agentMode),
    new CodingAgent(toolRuntime, modelRouter, openAiClient, agentMode),
    new DocumentAgent(toolRuntime, modelRouter, openAiClient, agentMode),
    new ActionAgent(toolRuntime, modelRouter, agentMode)
  ]);
  const memoryStore = resolveDbMode() === "prisma"
    ? new PersistentMemoryStore(memoryRepository)
    : new InMemoryMemoryStore();
  const contextBuilder = new ContextBuilder(
    memoryStore,
    taskSummaryRepository,
    artifactIndexRepository,
    taskReferenceRepository
  );
  const memoryWriter = new MemoryWriter(memoryStore);
  const checkpointManager = new CheckpointManager(checkpointRepository);

  return {
    orchestrator: new TaskOrchestrator(
      routerAgent,
      plannerAgent,
      replannerAgent,
      verifierAgent,
      agentRegistry,
      taskRepository,
      taskEventRepository,
      taskJobRepository,
      artifactRepository,
      taskSummaryRepository,
      artifactIndexRepository,
      taskReferenceRepository,
      wideResearchRunRepository,
      wideResearchItemRepository,
      approvalRequestRepository,
      checkpointManager,
      userProfileRepository,
      contextBuilder,
      memoryWriter,
      workspaceManager,
      logger,
      2,
      Number(process.env.OPENCLAW_STEP_TIMEOUT_MS ?? 300_000),
      repositories.browserSessionRepository
    ),
    taskRepository,
    taskEventRepository,
    artifactRepository,
    taskSummaryRepository,
    artifactIndexRepository,
    taskReferenceRepository,
    wideResearchRunRepository,
    wideResearchItemRepository,
    browserSessionRepository: repositories.browserSessionRepository,
    toolCallRepository,
    approvalRequestRepository,
    checkpointRepository,
    taskJobRepository,
    userProfileRepository,
    benchmarkRunRepository,
    benchmarkRunItemRepository,
    toolMode,
    agentMode,
    dbMode: resolveDbMode(),
    workspaceRoot,
    prisma
  };
};

const resolveToolExecutionMode = (): ToolExecutionMode => {
  const configured = process.env.OPENCLAW_TOOL_MODE;
  if (configured === "live" || configured === "mock") {
    return configured;
  }

  return "mock";
};

const resolveAgentExecutionMode = (): AgentExecutionMode => {
  const configured = process.env.OPENCLAW_AGENT_MODE;
  if (configured === "live" || configured === "mock") {
    return configured;
  }

  return "mock";
};

const resolveDbMode = (): "inmemory" | "prisma" => {
  const configured = process.env.OPENCLAW_DB_MODE;
  if (configured === "inmemory" || configured === "prisma") {
    return configured;
  }

  return "prisma";
};

const resolveBrowserMode = (fallback: ToolExecutionMode): ToolExecutionMode => {
  const configured = process.env.OPENCLAW_BROWSER_MODE;
  if (configured === "live" || configured === "mock") {
    return configured;
  }

  return fallback;
};

const resolveSearchAllowedDomains = (): string[] | undefined => {
  const raw = process.env.OPENAI_SEARCH_ALLOWED_DOMAINS;
  if (!raw) {
    return undefined;
  }

  return raw
    .split(",")
    .map((domain) => domain.trim())
    .filter(Boolean);
};

const resolveDefaultSearchLocation = (): WebSearchLocation | undefined => {
  const country = process.env.OPENAI_SEARCH_COUNTRY;
  const city = process.env.OPENAI_SEARCH_CITY;
  const region = process.env.OPENAI_SEARCH_REGION;
  const timezone = process.env.OPENAI_SEARCH_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (!country && !city && !region && !timezone) {
    return undefined;
  }

  return {
    type: "approximate",
    ...(city ? { city } : {}),
    ...(region ? { region } : {}),
    ...(country ? { country } : {}),
    ...(timezone ? { timezone } : {})
  };
};
