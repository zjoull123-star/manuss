export enum TaskStatus {
  Created = "CREATED",
  Planned = "PLANNED",
  Running = "RUNNING",
  WaitingTool = "WAITING_TOOL",
  WaitingApproval = "WAITING_APPROVAL",
  Verifying = "VERIFYING",
  Retrying = "RETRYING",
  Replanning = "REPLANNING",
  Completed = "COMPLETED",
  Failed = "FAILED",
  Cancelled = "CANCELLED"
}

export enum StepStatus {
  Pending = "PENDING",
  Running = "RUNNING",
  Verifying = "VERIFYING",
  Completed = "COMPLETED",
  Failed = "FAILED",
  Retrying = "RETRYING",
  Skipped = "SKIPPED",
  WaitingApproval = "WAITING_APPROVAL"
}

export enum AgentKind {
  Router = "RouterAgent",
  Planner = "PlannerAgent",
  Replanner = "ReplannerAgent",
  Research = "ResearchAgent",
  Browser = "BrowserAgent",
  Coding = "CodingAgent",
  Document = "DocumentAgent",
  Action = "ActionAgent",
  Verifier = "VerifierAgent"
}

export enum TaskClass {
  ResearchBrowser = "research_browser",
  CodingPython = "coding_python",
  DocumentExport = "document_export",
  ActionExecution = "action_execution"
}

export enum ToolName {
  Search = "search",
  Browser = "browser",
  Python = "python",
  Filesystem = "filesystem",
  Document = "document",
  Action = "action"
}

export enum ArtifactType {
  Plan = "plan",
  Json = "json",
  Markdown = "markdown",
  Pdf = "pdf",
  Document = "document",
  Presentation = "presentation",
  Spreadsheet = "spreadsheet",
  Text = "text",
  Screenshot = "screenshot",
  Report = "report",
  Generic = "generic"
}

export enum DeliveryKind {
  Markdown = "markdown",
  Pdf = "pdf",
  Docx = "docx",
  Pptx = "pptx",
  Xlsx = "xlsx",
  Json = "json",
  Text = "text",
  Webhook = "webhook",
  Email = "email",
  Slack = "slack",
  Notion = "notion"
}

export enum ErrorCode {
  Timeout = "TIMEOUT",
  StepTimeout = "STEP_TIMEOUT",
  NetworkError = "NETWORK_ERROR",
  RateLimit = "RATE_LIMIT",
  AuthRequired = "AUTH_REQUIRED",
  ApprovalRequired = "APPROVAL_REQUIRED",
  PermissionDenied = "PERMISSION_DENIED",
  InvalidInput = "INVALID_INPUT",
  ParsingFailed = "PARSING_FAILED",
  ToolUnavailable = "TOOL_UNAVAILABLE",
  ClarificationRequired = "CLARIFICATION_REQUIRED",
  Unknown = "UNKNOWN"
}

export enum ApprovalStatus {
  Pending = "PENDING",
  Approved = "APPROVED",
  Rejected = "REJECTED",
  Executed = "EXECUTED"
}

export enum TaskJobKind {
  PrepareTask = "PREPARE_TASK",
  ExecuteTask = "EXECUTE_TASK",
  ResumeTask = "RESUME_TASK"
}

export enum TaskJobStatus {
  Pending = "PENDING",
  Running = "RUNNING",
  Completed = "COMPLETED",
  Failed = "FAILED"
}

export enum TaskEventKind {
  TaskStatusChanged = "task_status_changed",
  StepStatusChanged = "step_status_changed",
  Tool = "tool_call",
  Approval = "approval",
  Checkpoint = "checkpoint",
  Error = "error",
  Job = "job",
  QualityGateFailed = "quality_gate_failed",
  RecoveryFallbackUsed = "recovery_fallback_used",
  AttemptEscalated = "attempt_escalated",
  StaleJobReclaimed = "stale_job_reclaimed",
  ArtifactValidated = "artifact_validated",
  TaskReferenced = "task_referenced",
  BenchmarkRun = "benchmark_run"
}

export type RouteKind =
  | "chat"
  | "single_step"
  | "multi_step"
  | "ask_clarification"
  | "approval_required";

export type VerificationVerdict =
  | "pass"
  | "retry_step"
  | "replan_task"
  | "ask_user";

export enum BenchmarkRunStatus {
  Pending = "PENDING",
  Running = "RUNNING",
  Completed = "COMPLETED",
  Failed = "FAILED"
}
