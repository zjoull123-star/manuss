import { JsonObject } from "../../shared/src";
import {
  AgentKind,
  RouteKind,
  ToolName,
  VerificationVerdict
} from "./enums";
import {
  ApprovalRequest,
  Artifact,
  ArtifactIndexEntry,
  BenchmarkRun,
  BenchmarkRunItem,
  Checkpoint,
  MemoryRecord,
  Plan,
  Task,
  TaskEvent,
  TaskJob,
  TaskError,
  TaskReference,
  TaskSummary,
  TaskStep,
  ToolCall,
  UserProfile,
  WideResearchItem,
  WideResearchRun,
  BrowserSession
} from "./domain";

export interface AgentRequest {
  taskId: string;
  stepId?: string;
  goal: string;
  context: JsonObject;
  constraints?: string[];
  successCriteria?: string[];
  artifacts?: string[];
}

export interface AgentResponse {
  status:
    | "success"
    | "failed"
    | "need_retry"
    | "need_clarification"
    | "need_approval";
  summary: string;
  artifacts?: string[];
  structuredData?: JsonObject;
  error?: TaskError;
}

export interface RouteDecision {
  route: RouteKind;
  intent: string;
  reason: string;
  confidence: number;
  missingInfo: string[];
  riskFlags: string[];
}

export interface VerificationDecision {
  verdict: VerificationVerdict;
  reason: string;
  missingCriteria: string[];
  suggestedFix: string;
  confidence: number;
  qualityScore?: number;
  qualityDefects?: string[];
  missingEvidence?: string[];
  sourceCoverageScore?: number;
  formatCompliance?: string;
}

export interface ToolRequest {
  taskId: string;
  stepId: string;
  toolName: ToolName;
  action: string;
  input: JsonObject;
  callerAgent: AgentKind;
  timeoutMs?: number;
  browserProfileId?: string;
  downloadDir?: string;
  inputFiles?: string[];
}

export interface ToolResponse {
  status: "success" | "failed" | "timeout";
  summary: string;
  output?: JsonObject;
  artifacts?: string[];
  error?: TaskError;
  metrics?: {
    durationMs: number;
    cost?: number;
  };
}

export interface StepAgent {
  readonly kind: AgentKind;
  execute(input: AgentRequest): Promise<AgentResponse>;
}

export interface TaskRepository {
  create(task: Task): Promise<Task>;
  update(task: Task): Promise<Task>;
  getById(taskId: string): Promise<Task | undefined>;
  listRecent(limit?: number): Promise<Task[]>;
}

export interface TaskEventRepository {
  create(event: TaskEvent): Promise<TaskEvent>;
  listByTask(taskId: string, limit?: number): Promise<TaskEvent[]>;
}

export interface CheckpointRepository {
  save(checkpoint: Checkpoint): Promise<Checkpoint>;
  getLatest(taskId: string): Promise<Checkpoint | undefined>;
}

export interface ArtifactRepository {
  save(artifact: Artifact): Promise<Artifact>;
  listByTask(taskId: string): Promise<Artifact[]>;
}

export interface TaskSummaryRepository {
  save(summary: TaskSummary): Promise<TaskSummary>;
  listRecentByUser(userId: string, limit?: number): Promise<TaskSummary[]>;
  listByTask(taskId: string): Promise<TaskSummary[]>;
}

export interface ArtifactIndexRepository {
  save(entry: ArtifactIndexEntry): Promise<ArtifactIndexEntry>;
  search(query: {
    q?: string;
    taskClass?: string;
    artifactType?: string;
    validatedOnly?: boolean;
    limit?: number;
  }): Promise<ArtifactIndexEntry[]>;
  listByTask(taskId: string): Promise<ArtifactIndexEntry[]>;
}

export interface TaskReferenceRepository {
  save(reference: TaskReference): Promise<TaskReference>;
  listByTask(taskId: string): Promise<TaskReference[]>;
}

export interface WideResearchRunRepository {
  save(run: WideResearchRun): Promise<WideResearchRun>;
  getByStep(taskId: string, stepId: string): Promise<WideResearchRun | undefined>;
  listByTask(taskId: string): Promise<WideResearchRun[]>;
}

export interface WideResearchItemRepository {
  save(item: WideResearchItem): Promise<WideResearchItem>;
  replaceForRun(wideResearchRunId: string, items: WideResearchItem[]): Promise<WideResearchItem[]>;
  listByRun(wideResearchRunId: string): Promise<WideResearchItem[]>;
}

export interface BrowserSessionRepository {
  save(session: BrowserSession): Promise<BrowserSession>;
  getByProfileId(browserProfileId: string): Promise<BrowserSession | undefined>;
  listRecent(limit?: number): Promise<BrowserSession[]>;
  listByTask(taskId: string): Promise<BrowserSession[]>;
}

export interface UserProfileRepository {
  getByUserId(userId: string): Promise<UserProfile | undefined>;
  save(profile: UserProfile): Promise<UserProfile>;
}

export interface ToolCallRepository {
  save(toolCall: ToolCall): Promise<ToolCall>;
  listByTask(taskId: string): Promise<ToolCall[]>;
}

export interface ApprovalRequestRepository {
  create(request: ApprovalRequest): Promise<ApprovalRequest>;
  getById(approvalId: string): Promise<ApprovalRequest | undefined>;
  findLatestByTaskStep(taskId: string, stepId: string): Promise<ApprovalRequest | undefined>;
  listByTask(taskId: string): Promise<ApprovalRequest[]>;
  listPending(): Promise<ApprovalRequest[]>;
  update(approvalRequest: ApprovalRequest): Promise<ApprovalRequest>;
}

export interface TaskJobRepository {
  enqueue(job: TaskJob): Promise<TaskJob>;
  getById(jobId: string): Promise<TaskJob | undefined>;
  listByTask(taskId: string): Promise<TaskJob[]>;
  listPending(): Promise<TaskJob[]>;
  claimNext(workerId: string, leaseTimeoutMs?: number): Promise<TaskJob | undefined>;
  heartbeat(jobId: string, workerId: string): Promise<boolean>;
  markCompleted(jobId: string, workerId: string): Promise<TaskJob>;
  markFailed(
    jobId: string,
    workerId: string,
    errorMessage: string,
    retryable: boolean
  ): Promise<TaskJob>;
}

export interface MemoryRepository {
  save(record: MemoryRecord): Promise<MemoryRecord>;
  listByTask(taskId: string): Promise<MemoryRecord[]>;
}

export interface BenchmarkRunRepository {
  create(run: BenchmarkRun): Promise<BenchmarkRun>;
  update(run: BenchmarkRun): Promise<BenchmarkRun>;
  getById(runId: string): Promise<BenchmarkRun | undefined>;
  listRecent(limit?: number): Promise<BenchmarkRun[]>;
}

export interface BenchmarkRunItemRepository {
  create(item: BenchmarkRunItem): Promise<BenchmarkRunItem>;
  listByRun(benchmarkRunId: string): Promise<BenchmarkRunItem[]>;
}

export interface PlanningAgent {
  createPlan(goal: string, context: JsonObject): Promise<Plan>;
}

export interface RoutingAgent {
  route(message: string, userProfile?: UserProfile): Promise<RouteDecision>;
}

export interface VerifyingAgent {
  verifyStep(
    task: Task,
    step: TaskStep,
    response: AgentResponse
  ): Promise<VerificationDecision>;
}

export interface ReplanningAgent {
  repairPlan(task: Task, failedStep: TaskStep, context: JsonObject): Promise<Plan>;
}
