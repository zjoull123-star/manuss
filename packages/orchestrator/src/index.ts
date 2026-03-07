import path from "node:path";
import {
  AgentRequest,
  AgentResponse,
  ApprovalRequest,
  ApprovalRequestRepository,
  ApprovalStatus,
  ArtifactRepository,
  Checkpoint,
  CheckpointRepository,
  createTaskEvent,
  createTaskJob,
  createDraftTask,
  createTaskFromPlan,
  ErrorCode,
  isRunnableStep,
  RouteDecision,
  StepStatus,
  Task,
  TaskEventKind,
  TaskEventRepository,
  TaskJob,
  TaskOrigin,
  TaskJobKind,
  TaskJobRepository,
  TaskRepository,
  TaskStatus,
  ToolName,
  UserProfile,
  UserProfileRepository
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
}

export class TaskOrchestrator {
  private readonly scheduler = new Scheduler();

  constructor(
    private readonly routerAgent: RouterAgent,
    private readonly plannerAgent: PlannerAgent,
    private readonly verifierAgent: VerifierAgent,
    private readonly agentRegistry: AgentRegistry,
    private readonly taskRepository: TaskRepository,
    private readonly taskEventRepository: TaskEventRepository,
    private readonly taskJobRepository: TaskJobRepository,
    private readonly artifactRepository: ArtifactRepository,
    private readonly approvalRequestRepository: ApprovalRequestRepository,
    private readonly checkpointManager: CheckpointManager,
    private readonly userProfileRepository: UserProfileRepository,
    private readonly contextBuilder: ContextBuilder,
    private readonly memoryWriter: MemoryWriter,
    private readonly logger: Logger,
    private readonly maxRetries = 2,
    private readonly stepTimeoutMs = 300_000
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
      retryOfTaskId: sourceTask.id
    });
    await this.taskRepository.create(retryTask);
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
    const task = createDraftTask(input.userId, input.goal, input.origin);
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
      const plan = await this.plannerAgent.createPlan(
        normalizedGoal,
        this.contextBuilder.buildPlanningContext(normalizedGoal, userProfile)
      );
      const task = createTaskFromPlan(
        existingTask.userId,
        normalizedGoal,
        plan,
        existingTask.origin,
        {
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
    } else if (currentTask.steps.some((step) => step.status === StepStatus.WaitingApproval)) {
      currentTask.status = TaskStatus.WaitingApproval;
    } else if (currentTask.steps.some((step) => step.status === StepStatus.Failed)) {
      currentTask.status = TaskStatus.Failed;
    } else if (currentTask.status !== TaskStatus.WaitingApproval) {
      currentTask.status = TaskStatus.Failed;
    }

    currentTask.updatedAt = nowIso();
    await this.taskRepository.update(currentTask);
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
    let attempt = step.retryCount;
    while (attempt <= this.maxRetries) {
      const cancelledBeforeAttempt = await this.maybeCancelTask(
        working.id,
        `Task cancelled before starting ${step.id}`,
        step.id
      );
      if (cancelledBeforeAttempt) {
        return cancelledBeforeAttempt;
      }

      step.status = StepStatus.Running;
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
      const context = this.contextBuilder.buildStepContext(working, step, userProfile, artifacts);
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
        response = await this.executeAgentWithTimeout(step.agent, request, this.stepTimeoutMs);
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
          stepLogger.error("Step execution timeout", { timeoutMs: this.stepTimeoutMs });
          await this.recordStepStatus(working.id, step, `Step ${step.id} timed out`, "error");
          await this.recordTaskStatus(working, `Task failed: step ${step.id} timed out`);
          await this.recordEvent(
            working.id,
            TaskEventKind.Error,
            `Step ${step.id} execution timed out after ${this.stepTimeoutMs}ms`,
            { timeoutMs: this.stepTimeoutMs },
            { stepId: step.id, level: "error" }
          );
          await this.saveCheckpointAndEvent(working, step.id);
          return working;
        }
        throw timeoutError;
      }
      this.applyStepResponse(step, response);
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
      if (decision.verdict === "pass") {
        step.status = StepStatus.Completed;
        delete step.error;
        working.status = TaskStatus.Running;
        await this.markApprovalExecutedIfNeeded(working.id, step.id);
        this.memoryWriter.recordStepResult(working, step);
        await this.taskRepository.update(working);
        await this.recordStepStatus(working.id, step, `Step ${step.id} completed`);
        await this.recordTaskStatus(working, `Task running after ${step.id}`);
        await this.saveCheckpointAndEvent(working, step.id);
        return working;
      }

      if (decision.verdict === "retry_step" && attempt < this.maxRetries) {
        attempt += 1;
        step.retryCount = attempt;
        step.status = StepStatus.Pending;
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
        await this.recordStepStatus(working.id, step, `Step ${step.id} retry requested`, "warn");
        await this.recordTaskStatus(working, `Task retrying ${step.id}`);
        continue;
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
          suggestedFix: decision.suggestedFix
        },
        {
          stepId: step.id,
          level: decision.verdict === "ask_user" ? "warn" : "error"
        }
      );
      await this.saveCheckpointAndEvent(working, step.id);
      return working;
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
      try {
        await this.taskJobRepository.markFailed(job.id, this.workerId, message, false);
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
    approvalRequestRepository,
    checkpointRepository,
    taskJobRepository,
    userProfileRepository,
    toolCallRepository,
    memoryRepository,
    prisma
  } = repositories;
  const workspaceManager = new WorkspaceManager(workspaceRoot);
  const artifactRegistry = new ArtifactRegistry(artifactRepository);
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
      : {})
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
    logger
  );

  const routerAgent = new RouterAgent(modelRouter, openAiClient, agentMode);
  const plannerAgent = new PlannerAgent(modelRouter, openAiClient, agentMode);
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
  const contextBuilder = new ContextBuilder(memoryStore);
  const memoryWriter = new MemoryWriter(memoryStore);
  const checkpointManager = new CheckpointManager(checkpointRepository);

  return {
    orchestrator: new TaskOrchestrator(
      routerAgent,
      plannerAgent,
      verifierAgent,
      agentRegistry,
      taskRepository,
      taskEventRepository,
      taskJobRepository,
      artifactRepository,
      approvalRequestRepository,
      checkpointManager,
      userProfileRepository,
      contextBuilder,
      memoryWriter,
      logger,
      2,
      Number(process.env.OPENCLAW_STEP_TIMEOUT_MS ?? 300_000)
    ),
    taskRepository,
    taskEventRepository,
    artifactRepository,
    toolCallRepository,
    approvalRequestRepository,
    checkpointRepository,
    taskJobRepository,
    userProfileRepository,
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
