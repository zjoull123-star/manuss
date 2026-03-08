import { createId, JsonObject, nowIso } from "../../shared/src";
import {
  AgentKind,
  ApprovalStatus,
  ArtifactType,
  BenchmarkRunStatus,
  DeliveryKind,
  ErrorCode,
  TaskClass,
  TaskEventKind,
  TaskJobKind,
  TaskJobStatus,
  StepStatus,
  TaskStatus,
  ToolName
} from "./enums";

export interface TaskError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  stage?: string;
  category?: string;
  upstreamErrorMessage?: string;
  fallbackUsed?: boolean;
  fallbackKind?: string;
}

export interface Artifact {
  id: string;
  taskId: string;
  stepId?: string;
  type: ArtifactType;
  uri: string;
  title?: string;
  summary?: string;
  keywords?: string[];
  validated?: boolean;
  deliveryKind?: DeliveryKind;
  metadata: JsonObject;
  createdAt: string;
}

export interface QualityProfile {
  requiredEvidence?: string[];
  minSourceCount?: number;
  requireFileArtifacts?: boolean;
  requireSchemaValid?: boolean;
  requireOutputReadable?: boolean;
  requireApprovalReceipt?: boolean;
}

export interface PlanStep {
  id: string;
  title: string;
  agent: AgentKind;
  taskClass?: TaskClass;
  qualityProfile?: QualityProfile;
  attemptStrategy?: JsonObject;
  objective: string;
  dependsOn: string[];
  inputs: string[];
  expectedOutput: string;
  successCriteria: string[];
}

export interface Plan {
  goal: string;
  assumptions: string[];
  steps: PlanStep[];
  taskSuccessCriteria: string[];
}

export interface FinalArtifactValidation {
  artifactType?: ArtifactType;
  deliveryKind?: DeliveryKind;
  pageCount?: number;
  validated: boolean;
  issues: string[];
}

export interface WideResearchRun {
  id: string;
  taskId: string;
  stepId: string;
  planVersion: number;
  goal: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  totalItems: number;
  completedItems: number;
  failedItems: number;
  aggregatedSourceCount?: number;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface WideResearchItem {
  id: string;
  wideResearchRunId: string;
  taskId: string;
  stepId: string;
  orderIndex: number;
  query: string;
  title?: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  sourceCount?: number;
  summary?: string;
  errorMessage?: string;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserSession {
  id: string;
  browserProfileId: string;
  taskId?: string;
  stepId?: string;
  profileDir: string;
  storageStatePath?: string;
  downloadDir?: string;
  currentUrl?: string;
  canonicalUrl?: string;
  lastAction: string;
  lastReplayArtifactUri?: string;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface TaskOrigin {
  channelId: string;
  accountId?: string;
  conversationId?: string;
  senderId?: string;
  sessionKey?: string;
  threadId?: string | number;
  replyMode: "manual_status" | "auto_callback";
}

export interface TaskStep {
  id: string;
  title: string;
  agent: AgentKind;
  taskClass?: TaskClass;
  qualityProfile?: QualityProfile;
  attemptStrategy?: JsonObject;
  objective: string;
  dependsOn: string[];
  status: StepStatus;
  retryCount: number;
  successCriteria: string[];
  summary?: string;
  inputArtifacts: string[];
  outputArtifacts: string[];
  structuredData: JsonObject;
  evidencePackage?: JsonObject;
  qualityScore?: number;
  qualityDefects?: string[];
  missingEvidence?: string[];
  sourceCoverageScore?: number;
  formatCompliance?: string;
  attemptHistory?: JsonObject[];
  referenceArtifactIds?: string[];
  error?: TaskError;
}

export interface Task {
  id: string;
  userId: string;
  goal: string;
  recipeId?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  currentPlanVersion: number;
  plan: Plan;
  steps: TaskStep[];
  origin?: TaskOrigin;
  finalArtifactUri?: string;
  finalArtifactValidation?: FinalArtifactValidation;
  retryOfTaskId?: string;
  cancelRequestedAt?: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  kind: TaskEventKind;
  level: "info" | "warn" | "error";
  message: string;
  createdAt: string;
  stepId?: string;
  jobId?: string;
  payload: JsonObject;
}

export interface Checkpoint {
  id: string;
  taskId: string;
  planVersion: number;
  completedSteps: string[];
  currentStepId?: string;
  artifactUris: string[];
  lastError?: TaskError;
  createdAt: string;
}

export interface UserProfile {
  userId: string;
  language: string;
  outputStyle: string;
  riskPolicy: "conservative" | "balanced" | "aggressive";
  preferences: JsonObject;
  updatedAt: string;
}

export interface ToolCall {
  id: string;
  taskId: string;
  stepId: string;
  toolName: ToolName;
  action: string;
  callerAgent: AgentKind;
  status: "success" | "failed" | "timeout";
  durationMs: number;
  createdAt: string;
}

export interface TaskSummary {
  id: string;
  taskId: string;
  userId: string;
  taskClass?: TaskClass;
  recipeId?: string;
  summary: string;
  keywords: string[];
  validated: boolean;
  createdAt: string;
}

export interface ArtifactIndexEntry {
  id: string;
  taskId: string;
  stepId?: string;
  artifactId: string;
  artifactType: ArtifactType;
  uri: string;
  title?: string;
  summary?: string;
  keywords: string[];
  validated: boolean;
  taskClass?: TaskClass;
  recipeId?: string;
  createdAt: string;
}

export interface TaskReference {
  id: string;
  taskId: string;
  sourceTaskId?: string;
  sourceArtifactId?: string;
  reason: string;
  createdAt: string;
  metadata: JsonObject;
}

export interface BenchmarkRun {
  id: string;
  name: string;
  suite: string;
  status: BenchmarkRunStatus;
  startedAt: string;
  completedAt?: string;
  createdAt: string;
  metadata: JsonObject;
}

export interface BenchmarkRunItem {
  id: string;
  benchmarkRunId: string;
  caseId: string;
  taskId?: string;
  completed: boolean;
  qualityScore?: number;
  fallbackUsed: boolean;
  artifactValidated: boolean;
  latencyMs?: number;
  failureCategory?: string;
  createdAt: string;
  metadata: JsonObject;
}

export interface ApprovalRequest {
  id: string;
  taskId: string;
  stepId: string;
  toolName: ToolName;
  action: string;
  status: ApprovalStatus;
  reason: string;
  payload: JsonObject;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
}

export interface TaskJob {
  id: string;
  taskId: string;
  kind: TaskJobKind;
  status: TaskJobStatus;
  payload: JsonObject;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
  lockedAt?: string;
  lockedBy?: string;
  lastError?: string;
}

export const createTaskFromPlan = (
  userId: string,
  goal: string,
  plan: Plan,
  origin?: TaskOrigin,
  options: { recipeId?: string; retryOfTaskId?: string; cancelRequestedAt?: string } = {}
): Task => ({
  id: createId("task"),
  userId,
  goal,
  ...(options.recipeId ? { recipeId: options.recipeId } : {}),
  status: TaskStatus.Planned,
  createdAt: nowIso(),
  updatedAt: nowIso(),
  currentPlanVersion: 1,
  plan,
  steps: plan.steps.map((step) => ({
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
    structuredData: {}
  })),
  ...(origin ? { origin } : {}),
  ...(options.retryOfTaskId ? { retryOfTaskId: options.retryOfTaskId } : {}),
  ...(options.cancelRequestedAt ? { cancelRequestedAt: options.cancelRequestedAt } : {})
});

export const createDraftTask = (
  userId: string,
  goal: string,
  origin?: TaskOrigin,
  options: { recipeId?: string; retryOfTaskId?: string; cancelRequestedAt?: string } = {}
): Task => ({
  id: createId("task"),
  userId,
  goal,
  ...(options.recipeId ? { recipeId: options.recipeId } : {}),
  status: TaskStatus.Created,
  createdAt: nowIso(),
  updatedAt: nowIso(),
  currentPlanVersion: 0,
  plan: {
    goal,
    assumptions: [],
    steps: [],
    taskSuccessCriteria: []
  },
  steps: [],
  ...(origin ? { origin } : {}),
  ...(options.retryOfTaskId ? { retryOfTaskId: options.retryOfTaskId } : {}),
  ...(options.cancelRequestedAt ? { cancelRequestedAt: options.cancelRequestedAt } : {})
});

export const createTaskJob = (
  taskId: string,
  kind: TaskJobKind,
  payload: JsonObject = {}
): TaskJob => ({
  id: createId("job"),
  taskId,
  kind,
  status: TaskJobStatus.Pending,
  payload,
  attempts: 0,
  maxAttempts: 3,
  availableAt: nowIso(),
  createdAt: nowIso(),
  updatedAt: nowIso()
});

export const createTaskEvent = (
  taskId: string,
  kind: TaskEventKind,
  message: string,
  payload: JsonObject = {},
  options: { level?: TaskEvent["level"]; stepId?: string; jobId?: string } = {}
): TaskEvent => ({
  id: createId("event"),
  taskId,
  kind,
  level: options.level ?? "info",
  message,
  createdAt: nowIso(),
  payload,
  ...(options.stepId ? { stepId: options.stepId } : {}),
  ...(options.jobId ? { jobId: options.jobId } : {})
});

export const isTerminalTaskStatus = (status: TaskStatus): boolean =>
  [TaskStatus.Completed, TaskStatus.Failed, TaskStatus.Cancelled].includes(status);

export const getCompletedStepIds = (task: Task): Set<string> =>
  new Set(task.steps.filter((step) => step.status === StepStatus.Completed).map((step) => step.id));

export interface MemoryRecord {
  id: string;
  taskId: string;
  stepId?: string;
  summary: string;
  createdAt: string;
}

export const isRunnableStep = (task: Task, step: TaskStep): boolean => {
  if (step.status !== StepStatus.Pending) {
    return false;
  }

  const completed = getCompletedStepIds(task);
  return step.dependsOn.every((dependency) => completed.has(dependency));
};
