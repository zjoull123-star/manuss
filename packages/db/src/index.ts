import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  ApprovalRequest,
  ApprovalRequestRepository,
  Artifact,
  ArtifactIndexEntry,
  ArtifactIndexRepository,
  ArtifactRepository,
  BenchmarkRun,
  BenchmarkRunItem,
  BenchmarkRunItemRepository,
  BenchmarkRunRepository,
  Checkpoint,
  CheckpointRepository,
  MemoryRecord,
  MemoryRepository,
  Task,
  TaskEvent,
  TaskEventRepository,
  TaskJob,
  TaskJobRepository,
  TaskError,
  TaskOrigin,
  TaskReference,
  TaskReferenceRepository,
  TaskRepository,
  TaskSummary,
  TaskSummaryRepository,
  TaskStep,
  TaskClass,
  TaskJobStatus,
  ToolCall,
  ToolCallRepository,
  UserProfile,
  UserProfileRepository
} from "../../core/src";
import { DeliveryKind } from "../../core/src";
import { JsonObject } from "../../shared/src";

const DEFAULT_DATABASE_URL = `file:${path.resolve(process.cwd(), ".data", "openclaw-manus.db")}`;

const serializeJson = (value: unknown): string => JSON.stringify(value ?? null);

const parseJsonValue = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const parseJsonObject = (value: string | null | undefined): JsonObject =>
  parseJsonValue<JsonObject>(value, {});

const parseStringArray = (value: string | null | undefined): string[] =>
  parseJsonValue<string[]>(value, []);

const parseTaskError = (value: string | null | undefined): TaskError | undefined =>
  value ? (JSON.parse(value) as TaskError) : undefined;

const parseTaskOrigin = (value: string | null | undefined): TaskOrigin | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = JSON.parse(value) as Partial<TaskOrigin>;
  if (typeof parsed.channelId !== "string" || parsed.channelId.length === 0) {
    return undefined;
  }
  if (parsed.replyMode !== "manual_status" && parsed.replyMode !== "auto_callback") {
    return undefined;
  }

  return parsed as TaskOrigin;
};

const parseString = (value: string | null | undefined): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const mapStepRecordToTaskStep = (stepRecord: {
  stepId: string;
  title: string;
  agent: string;
  taskClass: string | null;
  qualityProfileJson: string | null;
  attemptStrategyJson: string | null;
  objective: string;
  dependsOnJson: string;
  status: string;
  retryCount: number;
  successCriteriaJson: string;
  summary: string | null;
  inputArtifactsJson: string;
  outputArtifactsJson: string;
  structuredDataJson: string;
  evidencePackageJson: string | null;
  qualityScore: number | null;
  qualityDefectsJson: string | null;
  missingEvidenceJson: string | null;
  sourceCoverageScore: number | null;
  formatCompliance: string | null;
  attemptHistoryJson: string | null;
  referenceArtifactIdsJson: string | null;
  errorJson: string | null;
}): TaskStep => ({
  id: stepRecord.stepId,
  title: stepRecord.title,
  agent: stepRecord.agent as TaskStep["agent"],
  ...(stepRecord.taskClass ? { taskClass: stepRecord.taskClass as TaskClass } : {}),
  ...(stepRecord.qualityProfileJson
    ? { qualityProfile: parseJsonValue(stepRecord.qualityProfileJson, {}) }
    : {}),
  ...(stepRecord.attemptStrategyJson
    ? { attemptStrategy: parseJsonValue(stepRecord.attemptStrategyJson, {}) }
    : {}),
  objective: stepRecord.objective,
  dependsOn: parseStringArray(stepRecord.dependsOnJson),
  status: stepRecord.status as TaskStep["status"],
  retryCount: stepRecord.retryCount,
  successCriteria: parseStringArray(stepRecord.successCriteriaJson),
  ...(stepRecord.summary ? { summary: stepRecord.summary } : {}),
  inputArtifacts: parseStringArray(stepRecord.inputArtifactsJson),
  outputArtifacts: parseStringArray(stepRecord.outputArtifactsJson),
  structuredData: parseJsonObject(stepRecord.structuredDataJson),
  ...(stepRecord.evidencePackageJson
    ? { evidencePackage: parseJsonObject(stepRecord.evidencePackageJson) }
    : {}),
  ...(typeof stepRecord.qualityScore === "number"
    ? { qualityScore: stepRecord.qualityScore }
    : {}),
  ...(stepRecord.qualityDefectsJson
    ? { qualityDefects: parseStringArray(stepRecord.qualityDefectsJson) }
    : {}),
  ...(stepRecord.missingEvidenceJson
    ? { missingEvidence: parseStringArray(stepRecord.missingEvidenceJson) }
    : {}),
  ...(typeof stepRecord.sourceCoverageScore === "number"
    ? { sourceCoverageScore: stepRecord.sourceCoverageScore }
    : {}),
  ...(stepRecord.formatCompliance ? { formatCompliance: stepRecord.formatCompliance } : {}),
  ...(stepRecord.attemptHistoryJson
    ? { attemptHistory: parseJsonValue<JsonObject[]>(stepRecord.attemptHistoryJson, []) }
    : {}),
  ...(stepRecord.referenceArtifactIdsJson
    ? { referenceArtifactIds: parseStringArray(stepRecord.referenceArtifactIdsJson) }
    : {}),
  ...(stepRecord.errorJson ? { error: parseTaskError(stepRecord.errorJson)! } : {})
});

const mapArtifactRecordToArtifact = (record: {
  id: string;
  taskId: string;
  stepId: string | null;
  type: string;
  uri: string;
  title: string | null;
  summary: string | null;
  keywordsJson: string | null;
  validated: boolean | null;
  deliveryKind: string | null;
  metadataJson: string;
  createdAt: Date;
}): Artifact => ({
  id: record.id,
  taskId: record.taskId,
  type: record.type as Artifact["type"],
  uri: record.uri,
  ...(record.title ? { title: record.title } : {}),
  ...(record.summary ? { summary: record.summary } : {}),
  ...(record.keywordsJson ? { keywords: parseStringArray(record.keywordsJson) } : {}),
  ...(typeof record.validated === "boolean" ? { validated: record.validated } : {}),
  ...(record.deliveryKind ? { deliveryKind: record.deliveryKind as DeliveryKind } : {}),
  metadata: parseJsonObject(record.metadataJson),
  createdAt: record.createdAt.toISOString(),
  ...(record.stepId ? { stepId: record.stepId } : {})
});

const subtractMs = (isoValue: string, durationMs: number): string =>
  new Date(new Date(isoValue).getTime() - durationMs).toISOString();

const toDate = (value: string): Date => new Date(value);

const taskStepKey = (taskId: string, stepId: string): string => `${taskId}:${stepId}`;

class PrismaSqliteBootstrap {
  private initialized?: Promise<void>;

  constructor(private readonly prisma: PrismaClient) {}

  async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.initialize();
    }

    await this.initialized;
  }

  private async initialize(): Promise<void> {
    await this.prisma.$executeRawUnsafe(`PRAGMA foreign_keys = ON;`);
  }
}

export class InMemoryTaskRepository implements TaskRepository {
  private readonly tasks = new Map<string, Task>();

  async create(task: Task): Promise<Task> {
    this.tasks.set(task.id, structuredClone(task));
    return structuredClone(task);
  }

  async update(task: Task): Promise<Task> {
    this.tasks.set(task.id, structuredClone(task));
    return structuredClone(task);
  }

  async getById(taskId: string): Promise<Task | undefined> {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : undefined;
  }

  async listRecent(limit = 20): Promise<Task[]> {
    return [...this.tasks.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(1, limit))
      .map((task) => structuredClone(task));
  }
}

export class InMemoryTaskEventRepository implements TaskEventRepository {
  private readonly events = new Map<string, TaskEvent[]>();

  async create(event: TaskEvent): Promise<TaskEvent> {
    const existing = this.events.get(event.taskId) ?? [];
    existing.push(structuredClone(event));
    this.events.set(event.taskId, existing);
    return structuredClone(event);
  }

  async listByTask(taskId: string, limit = 500): Promise<TaskEvent[]> {
    return [...(this.events.get(taskId) ?? [])]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(-Math.max(1, limit))
      .map((event) => structuredClone(event));
  }
}

export class InMemoryCheckpointRepository implements CheckpointRepository {
  private readonly checkpoints = new Map<string, Checkpoint[]>();

  async save(checkpoint: Checkpoint): Promise<Checkpoint> {
    const existing = this.checkpoints.get(checkpoint.taskId) ?? [];
    existing.push(structuredClone(checkpoint));
    this.checkpoints.set(checkpoint.taskId, existing);
    return structuredClone(checkpoint);
  }

  async getLatest(taskId: string): Promise<Checkpoint | undefined> {
    const existing = this.checkpoints.get(taskId) ?? [];
    const latest = existing.at(-1);
    return latest ? structuredClone(latest) : undefined;
  }
}

export class InMemoryArtifactRepository implements ArtifactRepository {
  private readonly artifacts = new Map<string, Artifact[]>();

  async save(artifact: Artifact): Promise<Artifact> {
    const existing = this.artifacts.get(artifact.taskId) ?? [];
    existing.push(structuredClone(artifact));
    this.artifacts.set(artifact.taskId, existing);
    return structuredClone(artifact);
  }

  async listByTask(taskId: string): Promise<Artifact[]> {
    return structuredClone(this.artifacts.get(taskId) ?? []);
  }
}

export class InMemoryUserProfileRepository implements UserProfileRepository {
  private readonly profiles = new Map<string, UserProfile>();

  async getByUserId(userId: string): Promise<UserProfile | undefined> {
    const profile = this.profiles.get(userId);
    return profile ? structuredClone(profile) : undefined;
  }

  async save(profile: UserProfile): Promise<UserProfile> {
    this.profiles.set(profile.userId, structuredClone(profile));
    return structuredClone(profile);
  }
}

export class InMemoryToolCallRepository implements ToolCallRepository {
  private readonly toolCalls = new Map<string, ToolCall[]>();

  async save(toolCall: ToolCall): Promise<ToolCall> {
    const existing = this.toolCalls.get(toolCall.taskId) ?? [];
    existing.push(structuredClone(toolCall));
    this.toolCalls.set(toolCall.taskId, existing);
    return structuredClone(toolCall);
  }

  async listByTask(taskId: string): Promise<ToolCall[]> {
    return structuredClone(this.toolCalls.get(taskId) ?? []);
  }
}

export class InMemoryApprovalRequestRepository implements ApprovalRequestRepository {
  private readonly approvals = new Map<string, ApprovalRequest>();

  async create(request: ApprovalRequest): Promise<ApprovalRequest> {
    this.approvals.set(request.id, structuredClone(request));
    return structuredClone(request);
  }

  async getById(approvalId: string): Promise<ApprovalRequest | undefined> {
    const approval = this.approvals.get(approvalId);
    return approval ? structuredClone(approval) : undefined;
  }

  async findLatestByTaskStep(taskId: string, stepId: string): Promise<ApprovalRequest | undefined> {
    const matches = [...this.approvals.values()]
      .filter((approval) => approval.taskId === taskId && approval.stepId === stepId)
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
    const latest = matches.at(-1);
    return latest ? structuredClone(latest) : undefined;
  }

  async listByTask(taskId: string): Promise<ApprovalRequest[]> {
    return [...this.approvals.values()]
      .filter((approval) => approval.taskId === taskId)
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
      .map((approval) => structuredClone(approval));
  }

  async listPending(): Promise<ApprovalRequest[]> {
    return [...this.approvals.values()]
      .filter((approval) => approval.status === "PENDING")
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
      .map((approval) => structuredClone(approval));
  }

  async update(approvalRequest: ApprovalRequest): Promise<ApprovalRequest> {
    this.approvals.set(approvalRequest.id, structuredClone(approvalRequest));
    return structuredClone(approvalRequest);
  }
}

export class InMemoryTaskJobRepository implements TaskJobRepository {
  private readonly jobs = new Map<string, TaskJob>();

  async enqueue(job: TaskJob): Promise<TaskJob> {
    this.jobs.set(job.id, structuredClone(job));
    return structuredClone(job);
  }

  async getById(jobId: string): Promise<TaskJob | undefined> {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : undefined;
  }

  async listByTask(taskId: string): Promise<TaskJob[]> {
    return [...this.jobs.values()]
      .filter((job) => job.taskId === taskId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((job) => structuredClone(job));
  }

  async listPending(): Promise<TaskJob[]> {
    return [...this.jobs.values()]
      .filter((job) => job.status === TaskJobStatus.Pending)
      .sort((left, right) => left.availableAt.localeCompare(right.availableAt))
      .map((job) => structuredClone(job));
  }

  async claimNext(workerId: string, leaseTimeoutMs = 30_000): Promise<TaskJob | undefined> {
    const now = new Date().toISOString();
    const expiredBefore = subtractMs(now, leaseTimeoutMs);
    const pending = [...this.jobs.values()]
      .filter((job) => job.status === TaskJobStatus.Pending && job.availableAt <= now)
      .sort((left, right) => left.availableAt.localeCompare(right.availableAt))[0];
    const staleRunning = [...this.jobs.values()]
      .filter(
        (job) =>
          job.status === TaskJobStatus.Running &&
          typeof job.lockedAt === "string" &&
          job.lockedAt <= expiredBefore
      )
      .sort((left, right) => String(left.lockedAt).localeCompare(String(right.lockedAt)))[0];
    const next = pending ?? staleRunning;

    if (!next) {
      return undefined;
    }

    const claimed: TaskJob = {
      ...structuredClone(next),
      status: TaskJobStatus.Running,
      attempts: next.attempts + 1,
      payload: {
        ...next.payload,
        reclaimedFromStaleLease: next.status === TaskJobStatus.Running
      },
      lockedAt: now,
      lockedBy: workerId,
      updatedAt: now
    };
    this.jobs.set(claimed.id, claimed);
    return structuredClone(claimed);
  }

  async heartbeat(jobId: string, workerId: string): Promise<boolean> {
    const existing = this.jobs.get(jobId);
    if (
      !existing ||
      existing.status !== TaskJobStatus.Running ||
      existing.lockedBy !== workerId
    ) {
      return false;
    }

    const updated: TaskJob = {
      ...structuredClone(existing),
      lockedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.jobs.set(jobId, updated);
    return true;
  }

  async markCompleted(jobId: string, workerId: string): Promise<TaskJob> {
    const existing = this.jobs.get(jobId);
    if (!existing) {
      throw new Error(`Task job ${jobId} not found`);
    }
    if (existing.lockedBy !== workerId) {
      throw new Error(`Task job ${jobId} is not locked by ${workerId}`);
    }

    const completed: TaskJob = {
      ...structuredClone(existing),
      status: TaskJobStatus.Completed,
      updatedAt: new Date().toISOString()
    };
    this.jobs.set(jobId, completed);
    return structuredClone(completed);
  }

  async markFailed(
    jobId: string,
    workerId: string,
    errorMessage: string,
    retryable: boolean
  ): Promise<TaskJob> {
    const existing = this.jobs.get(jobId);
    if (!existing) {
      throw new Error(`Task job ${jobId} not found`);
    }
    if (existing.lockedBy !== workerId) {
      throw new Error(`Task job ${jobId} is not locked by ${workerId}`);
    }

    const exhausted = !retryable || existing.attempts >= existing.maxAttempts;
    const updated: TaskJob = {
      ...structuredClone(existing),
      status: exhausted ? TaskJobStatus.Failed : TaskJobStatus.Pending,
      availableAt: exhausted ? existing.availableAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastError: errorMessage
    };
    if (exhausted) {
      delete updated.lockedAt;
      delete updated.lockedBy;
    } else {
      delete updated.lockedAt;
      delete updated.lockedBy;
    }
    this.jobs.set(jobId, updated);
    return structuredClone(updated);
  }
}

export class PrismaTaskRepository implements TaskRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly bootstrap: PrismaSqliteBootstrap
  ) {}

  async create(task: Task): Promise<Task> {
    await this.bootstrap.ensureInitialized();
    await this.persistTask(task);
    return this.getByIdOrThrow(task.id);
  }

  async update(task: Task): Promise<Task> {
    await this.bootstrap.ensureInitialized();
    await this.persistTask(task);
    return this.getByIdOrThrow(task.id);
  }

  async getById(taskId: string): Promise<Task | undefined> {
    await this.bootstrap.ensureInitialized();
    const taskRecord = await this.prisma.taskRecord.findUnique({
      where: { id: taskId },
      include: {
        steps: {
          orderBy: { orderIndex: "asc" }
        }
      }
    });

    if (!taskRecord) {
      return undefined;
    }

    const plan = JSON.parse(taskRecord.planJson) as Task["plan"];
    const origin = parseTaskOrigin(taskRecord.originJson);
    const steps: TaskStep[] = taskRecord.steps.map((stepRecord) =>
      mapStepRecordToTaskStep(stepRecord)
    );

    return {
      id: taskRecord.id,
      userId: taskRecord.userId,
      goal: taskRecord.goal,
      ...(taskRecord.recipeId ? { recipeId: taskRecord.recipeId } : {}),
      status: taskRecord.status as Task["status"],
      createdAt: taskRecord.createdAt.toISOString(),
      updatedAt: taskRecord.updatedAt.toISOString(),
      currentPlanVersion: taskRecord.currentPlanVersion,
      plan,
      steps,
      ...(origin ? { origin } : {}),
      ...(taskRecord.finalArtifactUri ? { finalArtifactUri: taskRecord.finalArtifactUri } : {}),
      ...(taskRecord.finalArtifactValidationJson
        ? {
            finalArtifactValidation: parseJsonValue(
              taskRecord.finalArtifactValidationJson,
              { validated: false, issues: [] }
            )
          }
        : {}),
      ...(taskRecord.retryOfTaskId ? { retryOfTaskId: taskRecord.retryOfTaskId } : {}),
      ...(taskRecord.cancelRequestedAt
        ? { cancelRequestedAt: taskRecord.cancelRequestedAt.toISOString() }
        : {})
    };
  }

  async listRecent(limit = 20): Promise<Task[]> {
    await this.bootstrap.ensureInitialized();
    const records = await this.prisma.taskRecord.findMany({
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      take: Math.max(1, limit)
    });

    const tasks = await Promise.all(records.map((record) => this.getById(record.id)));
    return tasks.filter((task): task is Task => Boolean(task));
  }

  private async getByIdOrThrow(taskId: string): Promise<Task> {
    const task = await this.getById(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found after persistence`);
    }
    return task;
  }

  private async persistTask(task: Task): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.taskRecord.upsert({
        where: { id: task.id },
        update: {
          userId: task.userId,
          goal: task.goal,
          recipeId: task.recipeId ?? null,
          status: task.status,
          createdAt: toDate(task.createdAt),
          updatedAt: toDate(task.updatedAt),
          currentPlanVersion: task.currentPlanVersion,
          planJson: serializeJson(task.plan),
          originJson: task.origin ? serializeJson(task.origin) : null,
          finalArtifactUri: task.finalArtifactUri ?? null,
          finalArtifactValidationJson: task.finalArtifactValidation
            ? serializeJson(task.finalArtifactValidation)
            : null,
          retryOfTaskId: task.retryOfTaskId ?? null,
          cancelRequestedAt: task.cancelRequestedAt ? toDate(task.cancelRequestedAt) : null
        },
        create: {
          id: task.id,
          userId: task.userId,
          goal: task.goal,
          recipeId: task.recipeId ?? null,
          status: task.status,
          createdAt: toDate(task.createdAt),
          updatedAt: toDate(task.updatedAt),
          currentPlanVersion: task.currentPlanVersion,
          planJson: serializeJson(task.plan),
          originJson: task.origin ? serializeJson(task.origin) : null,
          finalArtifactUri: task.finalArtifactUri ?? null,
          finalArtifactValidationJson: task.finalArtifactValidation
            ? serializeJson(task.finalArtifactValidation)
            : null,
          retryOfTaskId: task.retryOfTaskId ?? null,
          cancelRequestedAt: task.cancelRequestedAt ? toDate(task.cancelRequestedAt) : null
        }
      });

      await tx.taskStepRecord.deleteMany({
        where: { taskId: task.id }
      });

      if (task.steps.length > 0) {
        await tx.taskStepRecord.createMany({
          data: task.steps.map((step, index) => ({
            key: taskStepKey(task.id, step.id),
            taskId: task.id,
            stepId: step.id,
            orderIndex: index,
            title: step.title,
            agent: step.agent,
            taskClass: step.taskClass ?? null,
            qualityProfileJson: step.qualityProfile ? serializeJson(step.qualityProfile) : null,
            attemptStrategyJson: step.attemptStrategy ? serializeJson(step.attemptStrategy) : null,
            objective: step.objective,
            dependsOnJson: serializeJson(step.dependsOn),
            status: step.status,
            retryCount: step.retryCount,
            successCriteriaJson: serializeJson(step.successCriteria),
            summary: step.summary ?? null,
            inputArtifactsJson: serializeJson(step.inputArtifacts),
            outputArtifactsJson: serializeJson(step.outputArtifacts),
            structuredDataJson: serializeJson(step.structuredData),
            evidencePackageJson: step.evidencePackage ? serializeJson(step.evidencePackage) : null,
            qualityScore: typeof step.qualityScore === "number" ? step.qualityScore : null,
            qualityDefectsJson: step.qualityDefects ? serializeJson(step.qualityDefects) : null,
            missingEvidenceJson: step.missingEvidence ? serializeJson(step.missingEvidence) : null,
            sourceCoverageScore:
              typeof step.sourceCoverageScore === "number" ? step.sourceCoverageScore : null,
            formatCompliance: step.formatCompliance ?? null,
            attemptHistoryJson: step.attemptHistory ? serializeJson(step.attemptHistory) : null,
            referenceArtifactIdsJson: step.referenceArtifactIds
              ? serializeJson(step.referenceArtifactIds)
              : null,
            errorJson: step.error ? serializeJson(step.error) : null
          }))
        });
      }
    });
  }
}

export class PrismaTaskEventRepository implements TaskEventRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly bootstrap: PrismaSqliteBootstrap
  ) {}

  async create(event: TaskEvent): Promise<TaskEvent> {
    await this.bootstrap.ensureInitialized();
    const record = await this.prisma.taskEventRecord.create({
      data: {
        id: event.id,
        taskId: event.taskId,
        kind: event.kind,
        level: event.level,
        message: event.message,
        stepId: event.stepId ?? null,
        jobId: event.jobId ?? null,
        payloadJson: serializeJson(event.payload),
        createdAt: toDate(event.createdAt)
      }
    });

    return this.mapEvent(record);
  }

  async listByTask(taskId: string, limit = 500): Promise<TaskEvent[]> {
    await this.bootstrap.ensureInitialized();
    const records = await this.prisma.taskEventRecord.findMany({
      where: { taskId },
      orderBy: { createdAt: "desc" },
      take: Math.max(1, limit)
    });

    return records.reverse().map((record) => this.mapEvent(record));
  }

  private mapEvent(record: {
    id: string;
    taskId: string;
    kind: string;
    level: string;
    message: string;
    stepId: string | null;
    jobId: string | null;
    payloadJson: string;
    createdAt: Date;
  }): TaskEvent {
    return {
      id: record.id,
      taskId: record.taskId,
      kind: record.kind as TaskEvent["kind"],
      level: record.level as TaskEvent["level"],
      message: record.message,
      payload: parseJsonObject(record.payloadJson),
      createdAt: record.createdAt.toISOString(),
      ...(record.stepId ? { stepId: record.stepId } : {}),
      ...(record.jobId ? { jobId: record.jobId } : {})
    };
  }
}

export class PrismaCheckpointRepository implements CheckpointRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly bootstrap: PrismaSqliteBootstrap
  ) {}

  async save(checkpoint: Checkpoint): Promise<Checkpoint> {
    await this.bootstrap.ensureInitialized();
    const record = await this.prisma.checkpointRecord.create({
      data: {
        id: checkpoint.id,
        taskId: checkpoint.taskId,
        planVersion: checkpoint.planVersion,
        completedStepsJson: serializeJson(checkpoint.completedSteps),
        currentStepId: checkpoint.currentStepId ?? null,
        artifactUrisJson: serializeJson(checkpoint.artifactUris),
        lastErrorJson: checkpoint.lastError ? serializeJson(checkpoint.lastError) : null,
        createdAt: toDate(checkpoint.createdAt)
      }
    });

    return {
      id: record.id,
      taskId: record.taskId,
      planVersion: record.planVersion,
      completedSteps: parseStringArray(record.completedStepsJson),
      artifactUris: parseStringArray(record.artifactUrisJson),
      createdAt: record.createdAt.toISOString(),
      ...(record.currentStepId ? { currentStepId: record.currentStepId } : {}),
      ...(record.lastErrorJson ? { lastError: parseTaskError(record.lastErrorJson)! } : {})
    };
  }

  async getLatest(taskId: string): Promise<Checkpoint | undefined> {
    await this.bootstrap.ensureInitialized();
    const record = await this.prisma.checkpointRecord.findFirst({
      where: { taskId },
      orderBy: { createdAt: "desc" }
    });

    if (!record) {
      return undefined;
    }

    return {
      id: record.id,
      taskId: record.taskId,
      planVersion: record.planVersion,
      completedSteps: parseStringArray(record.completedStepsJson),
      artifactUris: parseStringArray(record.artifactUrisJson),
      createdAt: record.createdAt.toISOString(),
      ...(record.currentStepId ? { currentStepId: record.currentStepId } : {}),
      ...(record.lastErrorJson ? { lastError: parseTaskError(record.lastErrorJson)! } : {})
    };
  }
}

export class PrismaArtifactRepository implements ArtifactRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly bootstrap: PrismaSqliteBootstrap
  ) {}

  async save(artifact: Artifact): Promise<Artifact> {
    await this.bootstrap.ensureInitialized();
    const record = await this.prisma.artifactRecord.create({
      data: {
        id: artifact.id,
        taskId: artifact.taskId,
        stepId: artifact.stepId ?? null,
        type: artifact.type,
        uri: artifact.uri,
        title: artifact.title ?? null,
        summary: artifact.summary ?? null,
        keywordsJson: artifact.keywords ? serializeJson(artifact.keywords) : null,
        validated: typeof artifact.validated === "boolean" ? artifact.validated : null,
        deliveryKind: artifact.deliveryKind ?? null,
        metadataJson: serializeJson(artifact.metadata),
        createdAt: toDate(artifact.createdAt)
      }
    });

    return mapArtifactRecordToArtifact(record);
  }

  async listByTask(taskId: string): Promise<Artifact[]> {
    await this.bootstrap.ensureInitialized();
    const records = await this.prisma.artifactRecord.findMany({
      where: { taskId },
      orderBy: { createdAt: "asc" }
    });

    return records.map((record) => mapArtifactRecordToArtifact(record));
  }
}

export class PrismaUserProfileRepository implements UserProfileRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly bootstrap: PrismaSqliteBootstrap
  ) {}

  async getByUserId(userId: string): Promise<UserProfile | undefined> {
    await this.bootstrap.ensureInitialized();
    const record = await this.prisma.userProfileRecord.findUnique({
      where: { userId }
    });

    if (!record) {
      return undefined;
    }

    return {
      userId: record.userId,
      language: record.language,
      outputStyle: record.outputStyle,
      riskPolicy: record.riskPolicy as UserProfile["riskPolicy"],
      preferences: parseJsonObject(record.preferencesJson),
      updatedAt: record.updatedAt.toISOString()
    };
  }

  async save(profile: UserProfile): Promise<UserProfile> {
    await this.bootstrap.ensureInitialized();
    const record = await this.prisma.userProfileRecord.upsert({
      where: { userId: profile.userId },
      update: {
        language: profile.language,
        outputStyle: profile.outputStyle,
        riskPolicy: profile.riskPolicy,
        preferencesJson: serializeJson(profile.preferences),
        updatedAt: toDate(profile.updatedAt)
      },
      create: {
        userId: profile.userId,
        language: profile.language,
        outputStyle: profile.outputStyle,
        riskPolicy: profile.riskPolicy,
        preferencesJson: serializeJson(profile.preferences),
        updatedAt: toDate(profile.updatedAt)
      }
    });

    return {
      userId: record.userId,
      language: record.language,
      outputStyle: record.outputStyle,
      riskPolicy: record.riskPolicy as UserProfile["riskPolicy"],
      preferences: parseJsonObject(record.preferencesJson),
      updatedAt: record.updatedAt.toISOString()
    };
  }
}

export class PrismaToolCallRepository implements ToolCallRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly bootstrap: PrismaSqliteBootstrap
  ) {}

  async save(toolCall: ToolCall): Promise<ToolCall> {
    await this.bootstrap.ensureInitialized();
    const record = await this.prisma.toolCallRecord.create({
      data: {
        id: toolCall.id,
        taskId: toolCall.taskId,
        stepId: toolCall.stepId,
        toolName: toolCall.toolName,
        action: toolCall.action,
        callerAgent: toolCall.callerAgent,
        status: toolCall.status,
        durationMs: toolCall.durationMs,
        createdAt: toDate(toolCall.createdAt)
      }
    });

    return {
      id: record.id,
      taskId: record.taskId,
      stepId: record.stepId,
      toolName: record.toolName as ToolCall["toolName"],
      action: record.action,
      callerAgent: record.callerAgent as ToolCall["callerAgent"],
      status: record.status as ToolCall["status"],
      durationMs: record.durationMs,
      createdAt: record.createdAt.toISOString()
    };
  }

  async listByTask(taskId: string): Promise<ToolCall[]> {
    await this.bootstrap.ensureInitialized();
    const records = await this.prisma.toolCallRecord.findMany({
      where: { taskId },
      orderBy: { createdAt: "asc" }
    });

    return records.map((record) => ({
      id: record.id,
      taskId: record.taskId,
      stepId: record.stepId,
      toolName: record.toolName as ToolCall["toolName"],
      action: record.action,
      callerAgent: record.callerAgent as ToolCall["callerAgent"],
      status: record.status as ToolCall["status"],
      durationMs: record.durationMs,
      createdAt: record.createdAt.toISOString()
    }));
  }
}

export class PrismaApprovalRequestRepository implements ApprovalRequestRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly bootstrap: PrismaSqliteBootstrap
  ) {}

  private get delegate(): {
    create(args: {
      data: {
        id: string;
        taskId: string;
        stepId: string;
        toolName: string;
        action: string;
        status: string;
        reason: string;
        payloadJson: string;
        requestedAt: Date;
        decidedAt: Date | null;
        decidedBy: string | null;
        decisionNote: string | null;
      };
    }): Promise<{
      id: string;
      taskId: string;
      stepId: string;
      toolName: string;
      action: string;
      status: string;
      reason: string;
      payloadJson: string;
      requestedAt: Date;
      decidedAt: Date | null;
      decidedBy: string | null;
      decisionNote: string | null;
    }>;
    findUnique(args: { where: { id: string } }): Promise<{
      id: string;
      taskId: string;
      stepId: string;
      toolName: string;
      action: string;
      status: string;
      reason: string;
      payloadJson: string;
      requestedAt: Date;
      decidedAt: Date | null;
      decidedBy: string | null;
      decisionNote: string | null;
    } | null>;
    findFirst(args: {
      where: { taskId: string; stepId: string };
      orderBy: { requestedAt: "desc" | "asc" };
    }): Promise<{
      id: string;
      taskId: string;
      stepId: string;
      toolName: string;
      action: string;
      status: string;
      reason: string;
      payloadJson: string;
      requestedAt: Date;
      decidedAt: Date | null;
      decidedBy: string | null;
      decisionNote: string | null;
    } | null>;
    findMany(args: {
      where: { taskId: string } | { status: string };
      orderBy: { requestedAt: "desc" | "asc" };
    }): Promise<Array<{
      id: string;
      taskId: string;
      stepId: string;
      toolName: string;
      action: string;
      status: string;
      reason: string;
      payloadJson: string;
      requestedAt: Date;
      decidedAt: Date | null;
      decidedBy: string | null;
      decisionNote: string | null;
    }>>;
    update(args: {
      where: { id: string };
      data: {
        status: string;
        reason: string;
        payloadJson: string;
        decidedAt: Date | null;
        decidedBy: string | null;
        decisionNote: string | null;
      };
    }): Promise<{
      id: string;
      taskId: string;
      stepId: string;
      toolName: string;
      action: string;
      status: string;
      reason: string;
      payloadJson: string;
      requestedAt: Date;
      decidedAt: Date | null;
      decidedBy: string | null;
      decisionNote: string | null;
    }>;
  } {
    return (this.prisma as PrismaClient & {
      approvalRequestRecord: PrismaApprovalRequestRepository["delegate"];
    }).approvalRequestRecord;
  }

  async create(request: ApprovalRequest): Promise<ApprovalRequest> {
    await this.bootstrap.ensureInitialized();
    const record = await this.delegate.create({
      data: {
        id: request.id,
        taskId: request.taskId,
        stepId: request.stepId,
        toolName: request.toolName,
        action: request.action,
        status: request.status,
        reason: request.reason,
        payloadJson: serializeJson(request.payload),
        requestedAt: toDate(request.requestedAt),
        decidedAt: request.decidedAt ? toDate(request.decidedAt) : null,
        decidedBy: request.decidedBy ?? null,
        decisionNote: request.decisionNote ?? null
      }
    });

    return {
      id: record.id,
      taskId: record.taskId,
      stepId: record.stepId,
      toolName: record.toolName as ApprovalRequest["toolName"],
      action: record.action,
      status: record.status as ApprovalRequest["status"],
      reason: record.reason,
      payload: parseJsonObject(record.payloadJson),
      requestedAt: record.requestedAt.toISOString(),
      ...(record.decidedAt ? { decidedAt: record.decidedAt.toISOString() } : {}),
      ...(record.decidedBy ? { decidedBy: record.decidedBy } : {}),
      ...(record.decisionNote ? { decisionNote: record.decisionNote } : {})
    };
  }

  async getById(approvalId: string): Promise<ApprovalRequest | undefined> {
    await this.bootstrap.ensureInitialized();
    const record = await this.delegate.findUnique({
      where: { id: approvalId }
    });

    return record ? this.mapApproval(record) : undefined;
  }

  async findLatestByTaskStep(taskId: string, stepId: string): Promise<ApprovalRequest | undefined> {
    await this.bootstrap.ensureInitialized();
    const record = await this.delegate.findFirst({
      where: { taskId, stepId },
      orderBy: { requestedAt: "desc" }
    });

    return record ? this.mapApproval(record) : undefined;
  }

  async listByTask(taskId: string): Promise<ApprovalRequest[]> {
    await this.bootstrap.ensureInitialized();
    const records = await this.delegate.findMany({
      where: { taskId },
      orderBy: { requestedAt: "asc" }
    });
    return records.map((record) => this.mapApproval(record));
  }

  async listPending(): Promise<ApprovalRequest[]> {
    await this.bootstrap.ensureInitialized();
    const records = await this.delegate.findMany({
      where: { status: "PENDING" },
      orderBy: { requestedAt: "asc" }
    });
    return records.map((record) => this.mapApproval(record));
  }

  async update(approvalRequest: ApprovalRequest): Promise<ApprovalRequest> {
    await this.bootstrap.ensureInitialized();
    const record = await this.delegate.update({
      where: { id: approvalRequest.id },
      data: {
        status: approvalRequest.status,
        reason: approvalRequest.reason,
        payloadJson: serializeJson(approvalRequest.payload),
        decidedAt: approvalRequest.decidedAt ? toDate(approvalRequest.decidedAt) : null,
        decidedBy: approvalRequest.decidedBy ?? null,
        decisionNote: approvalRequest.decisionNote ?? null
      }
    });
    return this.mapApproval(record);
  }

  private mapApproval(record: {
    id: string;
    taskId: string;
    stepId: string;
    toolName: string;
    action: string;
    status: string;
    reason: string;
    payloadJson: string;
    requestedAt: Date;
    decidedAt: Date | null;
    decidedBy: string | null;
    decisionNote: string | null;
  }): ApprovalRequest {
    return {
      id: record.id,
      taskId: record.taskId,
      stepId: record.stepId,
      toolName: record.toolName as ApprovalRequest["toolName"],
      action: record.action,
      status: record.status as ApprovalRequest["status"],
      reason: record.reason,
      payload: parseJsonObject(record.payloadJson),
      requestedAt: record.requestedAt.toISOString(),
      ...(record.decidedAt ? { decidedAt: record.decidedAt.toISOString() } : {}),
      ...(record.decidedBy ? { decidedBy: record.decidedBy } : {}),
      ...(record.decisionNote ? { decisionNote: record.decisionNote } : {})
    };
  }
}

export class PrismaTaskJobRepository implements TaskJobRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly bootstrap: PrismaSqliteBootstrap
  ) {}

  private get delegate(): {
    create(args: {
      data: {
        id: string;
        taskId: string;
        kind: string;
        status: string;
        payloadJson: string;
        attempts: number;
        maxAttempts: number;
        availableAt: Date;
        createdAt: Date;
        updatedAt: Date;
        lockedAt: Date | null;
        lockedBy: string | null;
        lastError: string | null;
      };
    }): Promise<{
      id: string;
      taskId: string;
      kind: string;
      status: string;
      payloadJson: string;
      attempts: number;
      maxAttempts: number;
      availableAt: Date;
      createdAt: Date;
      updatedAt: Date;
      lockedAt: Date | null;
      lockedBy: string | null;
      lastError: string | null;
    }>;
    findUnique(args: { where: { id: string } }): Promise<{
      id: string;
      taskId: string;
      kind: string;
      status: string;
      payloadJson: string;
      attempts: number;
      maxAttempts: number;
      availableAt: Date;
      createdAt: Date;
      updatedAt: Date;
      lockedAt: Date | null;
      lockedBy: string | null;
      lastError: string | null;
    } | null>;
    findMany(args: {
      where: { taskId: string } | { status: string };
      orderBy: { createdAt: "asc" } | { availableAt: "asc" };
    }): Promise<Array<{
      id: string;
      taskId: string;
      kind: string;
      status: string;
      payloadJson: string;
      attempts: number;
      maxAttempts: number;
      availableAt: Date;
      createdAt: Date;
      updatedAt: Date;
      lockedAt: Date | null;
      lockedBy: string | null;
      lastError: string | null;
    }>>;
    findFirst(args: {
      where: {
        status: string;
        availableAt?: { lte: Date };
        lockedAt?: { lte: Date };
      };
      orderBy: Array<{ availableAt: "asc" } | { createdAt: "asc" } | { lockedAt: "asc" }>;
    }): Promise<{
      id: string;
      taskId: string;
      kind: string;
      status: string;
      payloadJson: string;
      attempts: number;
      maxAttempts: number;
      availableAt: Date;
      createdAt: Date;
      updatedAt: Date;
      lockedAt: Date | null;
      lockedBy: string | null;
      lastError: string | null;
    } | null>;
    update(args: {
      where: { id: string };
      data: {
        status?: string;
        attempts?: number;
        payloadJson?: string;
        availableAt?: Date;
        updatedAt: Date;
        lockedAt?: Date | null;
        lockedBy?: string | null;
        lastError?: string | null;
      };
    }): Promise<{
      id: string;
      taskId: string;
      kind: string;
      status: string;
      payloadJson: string;
      attempts: number;
      maxAttempts: number;
      availableAt: Date;
      createdAt: Date;
      updatedAt: Date;
      lockedAt: Date | null;
      lockedBy: string | null;
      lastError: string | null;
    }>;
    updateMany(args: {
      where: {
        id: string;
        status?: string;
        lockedAt?: Date | null;
        lockedBy?: string | null;
      };
      data: {
        status?: string;
        attempts?: number;
        payloadJson?: string;
        availableAt?: Date;
        updatedAt: Date;
        lockedAt?: Date | null;
        lockedBy?: string | null;
        lastError?: string | null;
      };
    }): Promise<{ count: number }>;
  } {
    return (this.prisma as PrismaClient & {
      taskJobRecord: PrismaTaskJobRepository["delegate"];
    }).taskJobRecord;
  }

  async enqueue(job: TaskJob): Promise<TaskJob> {
    await this.bootstrap.ensureInitialized();
    const record = await this.delegate.create({
      data: {
        id: job.id,
        taskId: job.taskId,
        kind: job.kind,
        status: job.status,
        payloadJson: serializeJson(job.payload),
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        availableAt: toDate(job.availableAt),
        createdAt: toDate(job.createdAt),
        updatedAt: toDate(job.updatedAt),
        lockedAt: job.lockedAt ? toDate(job.lockedAt) : null,
        lockedBy: job.lockedBy ?? null,
        lastError: job.lastError ?? null
      }
    });
    return this.mapTaskJob(record);
  }

  async getById(jobId: string): Promise<TaskJob | undefined> {
    await this.bootstrap.ensureInitialized();
    const record = await this.delegate.findUnique({
      where: { id: jobId }
    });
    return record ? this.mapTaskJob(record) : undefined;
  }

  async listByTask(taskId: string): Promise<TaskJob[]> {
    await this.bootstrap.ensureInitialized();
    const records = await this.delegate.findMany({
      where: { taskId },
      orderBy: { createdAt: "asc" }
    });
    return records.map((record) => this.mapTaskJob(record));
  }

  async listPending(): Promise<TaskJob[]> {
    await this.bootstrap.ensureInitialized();
    const records = await this.delegate.findMany({
      where: { status: "PENDING" },
      orderBy: { availableAt: "asc" }
    });
    return records.map((record) => this.mapTaskJob(record));
  }

  async claimNext(workerId: string, leaseTimeoutMs = 30_000): Promise<TaskJob | undefined> {
    await this.bootstrap.ensureInitialized();
    const now = new Date();
    const expiredBefore = new Date(now.getTime() - leaseTimeoutMs);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pending = await this.delegate.findFirst({
        where: {
          status: "PENDING",
          availableAt: { lte: now }
        },
        orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }]
      });
      const staleRunning = pending
        ? undefined
        : await this.delegate.findFirst({
            where: {
              status: "RUNNING",
              lockedAt: { lte: expiredBefore }
            },
            orderBy: [{ lockedAt: "asc" }, { createdAt: "asc" }]
          });
      const next = pending ?? staleRunning;

      if (!next) {
        return undefined;
      }

      const claimed = await this.delegate.updateMany({
        where: {
          id: next.id,
          status: next.status,
          ...(next.status === "RUNNING" ? { lockedAt: next.lockedAt } : {})
        },
        data: {
          status: "RUNNING",
          attempts: next.attempts + 1,
          payloadJson: JSON.stringify({
            ...(typeof next.payloadJson === "string" && next.payloadJson.length > 0
              ? JSON.parse(next.payloadJson)
              : {}),
            reclaimedFromStaleLease: next.status === "RUNNING"
          }),
          lockedAt: now,
          lockedBy: workerId,
          updatedAt: now
        }
      });

      if (claimed.count === 1) {
        const job = await this.getById(next.id);
        return job;
      }
    }

    return undefined;
  }

  async heartbeat(jobId: string, workerId: string): Promise<boolean> {
    await this.bootstrap.ensureInitialized();
    const now = new Date();
    const touched = await this.delegate.updateMany({
      where: {
        id: jobId,
        status: "RUNNING",
        lockedBy: workerId
      },
      data: {
        updatedAt: now,
        lockedAt: now
      }
    });
    return touched.count === 1;
  }

  async markCompleted(jobId: string, workerId: string): Promise<TaskJob> {
    await this.bootstrap.ensureInitialized();
    const now = new Date();
    const updated = await this.delegate.updateMany({
      where: {
        id: jobId,
        status: "RUNNING",
        lockedBy: workerId
      },
      data: {
        status: "COMPLETED",
        updatedAt: now,
        lockedAt: null,
        lockedBy: null,
        lastError: null
      }
    });
    if (updated.count !== 1) {
      throw new Error(`Task job ${jobId} is not locked by ${workerId}`);
    }
    const record = await this.getById(jobId);
    if (!record) {
      throw new Error(`Task job ${jobId} not found after completion`);
    }
    return record;
  }

  async markFailed(
    jobId: string,
    workerId: string,
    errorMessage: string,
    retryable: boolean
  ): Promise<TaskJob> {
    await this.bootstrap.ensureInitialized();
    const existing = await this.getById(jobId);
    if (!existing) {
      throw new Error(`Task job ${jobId} not found`);
    }
    if (existing.lockedBy !== workerId) {
      throw new Error(`Task job ${jobId} is not locked by ${workerId}`);
    }

    const exhausted = !retryable || existing.attempts >= existing.maxAttempts;
    const now = new Date();
    const updated = await this.delegate.updateMany({
      where: {
        id: jobId,
        status: "RUNNING",
        lockedBy: workerId
      },
      data: {
        status: exhausted ? "FAILED" : "PENDING",
        availableAt: exhausted ? toDate(existing.availableAt) : now,
        updatedAt: now,
        lockedAt: null,
        lockedBy: null,
        lastError: errorMessage
      }
    });
    if (updated.count !== 1) {
      throw new Error(`Task job ${jobId} is not locked by ${workerId}`);
    }
    const record = await this.getById(jobId);
    if (!record) {
      throw new Error(`Task job ${jobId} not found after failure update`);
    }
    return record;
  }

  private mapTaskJob(record: {
    id: string;
    taskId: string;
    kind: string;
    status: string;
    payloadJson: string;
    attempts: number;
    maxAttempts: number;
    availableAt: Date;
    createdAt: Date;
    updatedAt: Date;
    lockedAt: Date | null;
    lockedBy: string | null;
    lastError: string | null;
  }): TaskJob {
    return {
      id: record.id,
      taskId: record.taskId,
      kind: record.kind as TaskJob["kind"],
      status: record.status as TaskJob["status"],
      payload: parseJsonObject(record.payloadJson),
      attempts: record.attempts,
      maxAttempts: record.maxAttempts,
      availableAt: record.availableAt.toISOString(),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      ...(record.lockedAt ? { lockedAt: record.lockedAt.toISOString() } : {}),
      ...(record.lockedBy ? { lockedBy: record.lockedBy } : {}),
      ...(record.lastError ? { lastError: record.lastError } : {})
    };
  }
}

class InMemoryMemoryRepository implements MemoryRepository {
  private readonly records: MemoryRecord[] = [];

  async save(record: MemoryRecord): Promise<MemoryRecord> {
    this.records.push(record);
    return record;
  }

  async listByTask(taskId: string): Promise<MemoryRecord[]> {
    return this.records
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

class InMemoryTaskSummaryRepository implements TaskSummaryRepository {
  private readonly summaries = new Map<string, TaskSummary[]>();

  async save(summary: TaskSummary): Promise<TaskSummary> {
    const existing = this.summaries.get(summary.taskId) ?? [];
    const next = existing.filter((candidate) => candidate.id !== summary.id);
    next.push(structuredClone(summary));
    this.summaries.set(summary.taskId, next);
    return structuredClone(summary);
  }

  async listRecentByUser(userId: string, limit = 20): Promise<TaskSummary[]> {
    return [...this.summaries.values()]
      .flat()
      .filter((summary) => summary.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, limit))
      .map((summary) => structuredClone(summary));
  }

  async listByTask(taskId: string): Promise<TaskSummary[]> {
    return structuredClone(this.summaries.get(taskId) ?? []);
  }
}

class InMemoryArtifactIndexRepository implements ArtifactIndexRepository {
  private readonly entries = new Map<string, ArtifactIndexEntry>();

  async save(entry: ArtifactIndexEntry): Promise<ArtifactIndexEntry> {
    this.entries.set(entry.id, structuredClone(entry));
    return structuredClone(entry);
  }

  async search(query: {
    q?: string;
    taskClass?: string;
    artifactType?: string;
    validatedOnly?: boolean;
    limit?: number;
  }): Promise<ArtifactIndexEntry[]> {
    const q = String(query.q ?? "").trim().toLowerCase();
    return [...this.entries.values()]
      .filter((entry: ArtifactIndexEntry) => {
        if (query.taskClass && entry.taskClass !== query.taskClass) {
          return false;
        }
        if (query.artifactType && entry.artifactType !== query.artifactType) {
          return false;
        }
        if (query.validatedOnly && entry.validated !== true) {
          return false;
        }
        if (!q) {
          return true;
        }
        const haystack = [
          entry.title ?? "",
          entry.summary ?? "",
          ...entry.keywords,
          entry.uri
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, query.limit ?? 20))
      .map((entry) => structuredClone(entry));
  }

  async listByTask(taskId: string): Promise<ArtifactIndexEntry[]> {
    return [...this.entries.values()]
      .filter((entry) => entry.taskId === taskId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((entry) => structuredClone(entry));
  }
}

class InMemoryTaskReferenceRepository implements TaskReferenceRepository {
  private readonly references = new Map<string, TaskReference[]>();

  async save(reference: TaskReference): Promise<TaskReference> {
    const existing = this.references.get(reference.taskId) ?? [];
    existing.push(structuredClone(reference));
    this.references.set(reference.taskId, existing);
    return structuredClone(reference);
  }

  async listByTask(taskId: string): Promise<TaskReference[]> {
    return [...(this.references.get(taskId) ?? [])]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((reference) => structuredClone(reference));
  }
}

class InMemoryBenchmarkRunRepository implements BenchmarkRunRepository {
  private readonly runs = new Map<string, BenchmarkRun>();

  async create(run: BenchmarkRun): Promise<BenchmarkRun> {
    this.runs.set(run.id, structuredClone(run));
    return structuredClone(run);
  }

  async update(run: BenchmarkRun): Promise<BenchmarkRun> {
    this.runs.set(run.id, structuredClone(run));
    return structuredClone(run);
  }

  async getById(runId: string): Promise<BenchmarkRun | undefined> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  async listRecent(limit = 20): Promise<BenchmarkRun[]> {
    return [...this.runs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, limit))
      .map((run) => structuredClone(run));
  }
}

class InMemoryBenchmarkRunItemRepository implements BenchmarkRunItemRepository {
  private readonly items = new Map<string, BenchmarkRunItem[]>();

  async create(item: BenchmarkRunItem): Promise<BenchmarkRunItem> {
    const existing = this.items.get(item.benchmarkRunId) ?? [];
    existing.push(structuredClone(item));
    this.items.set(item.benchmarkRunId, existing);
    return structuredClone(item);
  }

  async listByRun(benchmarkRunId: string): Promise<BenchmarkRunItem[]> {
    return [...(this.items.get(benchmarkRunId) ?? [])]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((item) => structuredClone(item));
  }
}

class PrismaMemoryRepository implements MemoryRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly bootstrap: PrismaSqliteBootstrap
  ) {}

  async save(record: MemoryRecord): Promise<MemoryRecord> {
    await this.bootstrap.ensureInitialized();
    await (this.prisma as any).memoryRecordModel.create({
      data: {
        id: record.id,
        taskId: record.taskId,
        stepId: record.stepId ?? null,
        summary: record.summary,
        createdAt: new Date(record.createdAt)
      }
    });
    return record;
  }

  async listByTask(taskId: string): Promise<MemoryRecord[]> {
    await this.bootstrap.ensureInitialized();
    const rows = await (this.prisma as any).memoryRecordModel.findMany({
      where: { taskId },
      orderBy: { createdAt: "asc" }
    });
    return rows.map((row: any) => ({
      id: row.id,
      taskId: row.taskId,
      ...(row.stepId ? { stepId: row.stepId } : {}),
      summary: row.summary,
      createdAt: row.createdAt.toISOString()
    }));
  }
}

class PrismaTaskSummaryRepository implements TaskSummaryRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly bootstrap: PrismaSqliteBootstrap
  ) {}

  async save(summary: TaskSummary): Promise<TaskSummary> {
    await this.bootstrap.ensureInitialized();
    const record = await (this.prisma as any).taskSummaryRecord.upsert({
      where: { id: summary.id },
      update: {
        taskId: summary.taskId,
        userId: summary.userId,
        taskClass: summary.taskClass ?? null,
        recipeId: summary.recipeId ?? null,
        summary: summary.summary,
        keywordsJson: serializeJson(summary.keywords),
        validated: summary.validated,
        createdAt: toDate(summary.createdAt)
      },
      create: {
        id: summary.id,
        taskId: summary.taskId,
        userId: summary.userId,
        taskClass: summary.taskClass ?? null,
        recipeId: summary.recipeId ?? null,
        summary: summary.summary,
        keywordsJson: serializeJson(summary.keywords),
        validated: summary.validated,
        createdAt: toDate(summary.createdAt)
      }
    });
    return this.map(record);
  }

  async listRecentByUser(userId: string, limit = 20): Promise<TaskSummary[]> {
    await this.bootstrap.ensureInitialized();
    const records = await (this.prisma as any).taskSummaryRecord.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: Math.max(1, limit)
    });
    return records.map((record: any) => this.map(record));
  }

  async listByTask(taskId: string): Promise<TaskSummary[]> {
    await this.bootstrap.ensureInitialized();
    const records = await (this.prisma as any).taskSummaryRecord.findMany({
      where: { taskId },
      orderBy: { createdAt: "asc" }
    });
    return records.map((record: any) => this.map(record));
  }

  private map(record: any): TaskSummary {
    return {
      id: record.id,
      taskId: record.taskId,
      userId: record.userId,
      ...(record.taskClass ? { taskClass: record.taskClass } : {}),
      ...(record.recipeId ? { recipeId: record.recipeId } : {}),
      summary: record.summary,
      keywords: parseStringArray(record.keywordsJson),
      validated: Boolean(record.validated),
      createdAt: record.createdAt.toISOString()
    };
  }
}

class PrismaArtifactIndexRepository implements ArtifactIndexRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly bootstrap: PrismaSqliteBootstrap
  ) {}

  async save(entry: ArtifactIndexEntry): Promise<ArtifactIndexEntry> {
    await this.bootstrap.ensureInitialized();
    const record = await (this.prisma as any).artifactIndexRecord.upsert({
      where: { id: entry.id },
      update: {
        taskId: entry.taskId,
        stepId: entry.stepId ?? null,
        artifactId: entry.artifactId,
        artifactType: entry.artifactType,
        uri: entry.uri,
        title: entry.title ?? null,
        summary: entry.summary ?? null,
        keywordsJson: serializeJson(entry.keywords),
        validated: entry.validated,
        taskClass: entry.taskClass ?? null,
        recipeId: entry.recipeId ?? null,
        createdAt: toDate(entry.createdAt)
      },
      create: {
        id: entry.id,
        taskId: entry.taskId,
        stepId: entry.stepId ?? null,
        artifactId: entry.artifactId,
        artifactType: entry.artifactType,
        uri: entry.uri,
        title: entry.title ?? null,
        summary: entry.summary ?? null,
        keywordsJson: serializeJson(entry.keywords),
        validated: entry.validated,
        taskClass: entry.taskClass ?? null,
        recipeId: entry.recipeId ?? null,
        createdAt: toDate(entry.createdAt)
      }
    });
    return this.map(record);
  }

  async search(query: {
    q?: string;
    taskClass?: string;
    artifactType?: string;
    validatedOnly?: boolean;
    limit?: number;
  }): Promise<ArtifactIndexEntry[]> {
    await this.bootstrap.ensureInitialized();
    const records = await (this.prisma as any).artifactIndexRecord.findMany({
      where: {
        ...(query.taskClass ? { taskClass: query.taskClass } : {}),
        ...(query.artifactType ? { artifactType: query.artifactType } : {}),
        ...(query.validatedOnly ? { validated: true } : {})
      },
      orderBy: { createdAt: "desc" },
      take: Math.max(1, query.limit ?? 20)
    });

    const normalizedQuery = String(query.q ?? "").trim().toLowerCase();
    return records
      .map((record: any) => this.map(record))
      .filter((entry: ArtifactIndexEntry) => {
        if (!normalizedQuery) {
          return true;
        }
        const haystack = [
          entry.title ?? "",
          entry.summary ?? "",
          ...entry.keywords,
          entry.uri
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(normalizedQuery);
      });
  }

  async listByTask(taskId: string): Promise<ArtifactIndexEntry[]> {
    await this.bootstrap.ensureInitialized();
    const records = await (this.prisma as any).artifactIndexRecord.findMany({
      where: { taskId },
      orderBy: { createdAt: "asc" }
    });
    return records.map((record: any) => this.map(record));
  }

  private map(record: any): ArtifactIndexEntry {
    return {
      id: record.id,
      taskId: record.taskId,
      ...(record.stepId ? { stepId: record.stepId } : {}),
      artifactId: record.artifactId,
      artifactType: record.artifactType,
      uri: record.uri,
      ...(record.title ? { title: record.title } : {}),
      ...(record.summary ? { summary: record.summary } : {}),
      keywords: parseStringArray(record.keywordsJson),
      validated: Boolean(record.validated),
      ...(record.taskClass ? { taskClass: record.taskClass } : {}),
      ...(record.recipeId ? { recipeId: record.recipeId } : {}),
      createdAt: record.createdAt.toISOString()
    };
  }
}

class PrismaTaskReferenceRepository implements TaskReferenceRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly bootstrap: PrismaSqliteBootstrap
  ) {}

  async save(reference: TaskReference): Promise<TaskReference> {
    await this.bootstrap.ensureInitialized();
    const record = await (this.prisma as any).taskReferenceRecord.create({
      data: {
        id: reference.id,
        taskId: reference.taskId,
        sourceTaskId: reference.sourceTaskId ?? null,
        sourceArtifactId: reference.sourceArtifactId ?? null,
        reason: reference.reason,
        metadataJson: serializeJson(reference.metadata),
        createdAt: toDate(reference.createdAt)
      }
    });
    return this.map(record);
  }

  async listByTask(taskId: string): Promise<TaskReference[]> {
    await this.bootstrap.ensureInitialized();
    const records = await (this.prisma as any).taskReferenceRecord.findMany({
      where: { taskId },
      orderBy: { createdAt: "asc" }
    });
    return records.map((record: any) => this.map(record));
  }

  private map(record: any): TaskReference {
    return {
      id: record.id,
      taskId: record.taskId,
      ...(record.sourceTaskId ? { sourceTaskId: record.sourceTaskId } : {}),
      ...(record.sourceArtifactId ? { sourceArtifactId: record.sourceArtifactId } : {}),
      reason: record.reason,
      metadata: parseJsonObject(record.metadataJson),
      createdAt: record.createdAt.toISOString()
    };
  }
}

class PrismaBenchmarkRunRepository implements BenchmarkRunRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly bootstrap: PrismaSqliteBootstrap
  ) {}

  async create(run: BenchmarkRun): Promise<BenchmarkRun> {
    await this.bootstrap.ensureInitialized();
    const record = await (this.prisma as any).benchmarkRunRecord.create({
      data: {
        id: run.id,
        name: run.name,
        suite: run.suite,
        status: run.status,
        startedAt: toDate(run.startedAt),
        completedAt: run.completedAt ? toDate(run.completedAt) : null,
        createdAt: toDate(run.createdAt),
        metadataJson: serializeJson(run.metadata)
      }
    });
    return this.map(record);
  }

  async update(run: BenchmarkRun): Promise<BenchmarkRun> {
    await this.bootstrap.ensureInitialized();
    const record = await (this.prisma as any).benchmarkRunRecord.update({
      where: { id: run.id },
      data: {
        name: run.name,
        suite: run.suite,
        status: run.status,
        startedAt: toDate(run.startedAt),
        completedAt: run.completedAt ? toDate(run.completedAt) : null,
        createdAt: toDate(run.createdAt),
        metadataJson: serializeJson(run.metadata)
      }
    });
    return this.map(record);
  }

  async getById(runId: string): Promise<BenchmarkRun | undefined> {
    await this.bootstrap.ensureInitialized();
    const record = await (this.prisma as any).benchmarkRunRecord.findUnique({
      where: { id: runId }
    });
    return record ? this.map(record) : undefined;
  }

  async listRecent(limit = 20): Promise<BenchmarkRun[]> {
    await this.bootstrap.ensureInitialized();
    const records = await (this.prisma as any).benchmarkRunRecord.findMany({
      orderBy: { createdAt: "desc" },
      take: Math.max(1, limit)
    });
    return records.map((record: any) => this.map(record));
  }

  private map(record: any): BenchmarkRun {
    return {
      id: record.id,
      name: record.name,
      suite: record.suite,
      status: record.status,
      startedAt: record.startedAt.toISOString(),
      ...(record.completedAt ? { completedAt: record.completedAt.toISOString() } : {}),
      createdAt: record.createdAt.toISOString(),
      metadata: parseJsonObject(record.metadataJson)
    };
  }
}

class PrismaBenchmarkRunItemRepository implements BenchmarkRunItemRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly bootstrap: PrismaSqliteBootstrap
  ) {}

  async create(item: BenchmarkRunItem): Promise<BenchmarkRunItem> {
    await this.bootstrap.ensureInitialized();
    const record = await (this.prisma as any).benchmarkRunItemRecord.create({
      data: {
        id: item.id,
        benchmarkRunId: item.benchmarkRunId,
        caseId: item.caseId,
        taskId: item.taskId ?? null,
        completed: item.completed,
        qualityScore: typeof item.qualityScore === "number" ? item.qualityScore : null,
        fallbackUsed: item.fallbackUsed,
        artifactValidated: item.artifactValidated,
        latencyMs: typeof item.latencyMs === "number" ? Math.round(item.latencyMs) : null,
        failureCategory: item.failureCategory ?? null,
        createdAt: toDate(item.createdAt),
        metadataJson: serializeJson(item.metadata)
      }
    });
    return this.map(record);
  }

  async listByRun(benchmarkRunId: string): Promise<BenchmarkRunItem[]> {
    await this.bootstrap.ensureInitialized();
    const records = await (this.prisma as any).benchmarkRunItemRecord.findMany({
      where: { benchmarkRunId },
      orderBy: { createdAt: "asc" }
    });
    return records.map((record: any) => this.map(record));
  }

  private map(record: any): BenchmarkRunItem {
    return {
      id: record.id,
      benchmarkRunId: record.benchmarkRunId,
      caseId: record.caseId,
      ...(record.taskId ? { taskId: record.taskId } : {}),
      completed: Boolean(record.completed),
      ...(typeof record.qualityScore === "number" ? { qualityScore: record.qualityScore } : {}),
      fallbackUsed: Boolean(record.fallbackUsed),
      artifactValidated: Boolean(record.artifactValidated),
      ...(typeof record.latencyMs === "number" ? { latencyMs: record.latencyMs } : {}),
      ...(record.failureCategory ? { failureCategory: record.failureCategory } : {}),
      createdAt: record.createdAt.toISOString(),
      metadata: parseJsonObject(record.metadataJson)
    };
  }
}

export interface RepositoryBundle {
  taskRepository: TaskRepository;
  taskEventRepository: TaskEventRepository;
  checkpointRepository: CheckpointRepository;
  artifactRepository: ArtifactRepository;
  taskSummaryRepository: TaskSummaryRepository;
  artifactIndexRepository: ArtifactIndexRepository;
  taskReferenceRepository: TaskReferenceRepository;
  userProfileRepository: UserProfileRepository;
  toolCallRepository: ToolCallRepository;
  approvalRequestRepository: ApprovalRequestRepository;
  taskJobRepository: TaskJobRepository;
  memoryRepository: MemoryRepository;
  benchmarkRunRepository: BenchmarkRunRepository;
  benchmarkRunItemRepository: BenchmarkRunItemRepository;
  prisma?: PrismaClient;
}

export const createInMemoryRepositories = (): RepositoryBundle => ({
  taskRepository: new InMemoryTaskRepository(),
  taskEventRepository: new InMemoryTaskEventRepository(),
  checkpointRepository: new InMemoryCheckpointRepository(),
  artifactRepository: new InMemoryArtifactRepository(),
  taskSummaryRepository: new InMemoryTaskSummaryRepository(),
  artifactIndexRepository: new InMemoryArtifactIndexRepository(),
  taskReferenceRepository: new InMemoryTaskReferenceRepository(),
  userProfileRepository: new InMemoryUserProfileRepository(),
  toolCallRepository: new InMemoryToolCallRepository(),
  approvalRequestRepository: new InMemoryApprovalRequestRepository(),
  taskJobRepository: new InMemoryTaskJobRepository(),
  memoryRepository: new InMemoryMemoryRepository(),
  benchmarkRunRepository: new InMemoryBenchmarkRunRepository(),
  benchmarkRunItemRepository: new InMemoryBenchmarkRunItemRepository()
});

export const createPrismaRepositories = (databaseUrl?: string): RepositoryBundle => {
  const resolvedUrl = databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const prisma = new PrismaClient(
    {
      datasources: {
        db: {
          url: resolvedUrl
        }
      }
    }
  );
  const bootstrap = new PrismaSqliteBootstrap(prisma);

  return {
    taskRepository: new PrismaTaskRepository(prisma, bootstrap),
    taskEventRepository: new PrismaTaskEventRepository(prisma, bootstrap),
    checkpointRepository: new PrismaCheckpointRepository(prisma, bootstrap),
    artifactRepository: new PrismaArtifactRepository(prisma, bootstrap),
    taskSummaryRepository: new PrismaTaskSummaryRepository(prisma, bootstrap),
    artifactIndexRepository: new PrismaArtifactIndexRepository(prisma, bootstrap),
    taskReferenceRepository: new PrismaTaskReferenceRepository(prisma, bootstrap),
    userProfileRepository: new PrismaUserProfileRepository(prisma, bootstrap),
    toolCallRepository: new PrismaToolCallRepository(prisma, bootstrap),
    approvalRequestRepository: new PrismaApprovalRequestRepository(prisma, bootstrap),
    taskJobRepository: new PrismaTaskJobRepository(prisma, bootstrap),
    memoryRepository: new PrismaMemoryRepository(prisma, bootstrap),
    benchmarkRunRepository: new PrismaBenchmarkRunRepository(prisma, bootstrap),
    benchmarkRunItemRepository: new PrismaBenchmarkRunItemRepository(prisma, bootstrap),
    prisma
  };
};
