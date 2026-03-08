import { promises as fs } from "node:fs";
import path from "node:path";
import {
  AgentKind,
  AgentRequest,
  AgentResponse,
  ApprovalStatus,
  ErrorCode,
  Plan,
  PlanningAgent,
  QualityProfile,
  ReplanningAgent,
  RouteDecision,
  RoutingAgent,
  StepAgent,
  StepStatus,
  Task,
  TaskClass,
  TaskStep,
  ToolResponse,
  ToolName,
  UserProfile,
  VerificationDecision,
  VerifyingAgent
} from "../../core/src";
import { JsonObject } from "../../shared/src";
import { ModelRouter, OpenAIResponsesClient } from "../../llm/src";
import { buildRecipePlanningContext, getRecipeById, matchRecipeForGoal, RecipeDefinition } from "../../recipes/src";
import {
  BROWSER_PROMPT_TEMPLATE,
  CODING_PROMPT_TEMPLATE,
  DOCUMENT_PROMPT_TEMPLATE,
  PLANNER_PROMPT_TEMPLATE,
  RESEARCH_PROMPT_TEMPLATE,
  REPLANNER_PROMPT_TEMPLATE,
  ROUTER_PROMPT_TEMPLATE,
  VERIFIER_PROMPT_TEMPLATE
} from "../../prompts/src";
import { ToolRuntime } from "../../tools/src";

export type AgentExecutionMode = "mock" | "live";

const hasKeyword = (input: string, keywords: string[]): boolean =>
  keywords.some((keyword) => input.toLowerCase().includes(keyword.toLowerCase()));

const TASK_PREFIX_PATTERN = /^\s*task:\s*/i;

const AGENT_KIND_VALUES = Object.values(AgentKind);
const TASK_CLASS_VALUES = Object.values(TaskClass);

const QUALITY_PROFILE_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    requiredEvidence: {
      type: "array",
      items: { type: "string" }
    },
    minSourceCount: { type: "number" },
    requireFileArtifacts: { type: "boolean" },
    requireSchemaValid: { type: "boolean" },
    requireOutputReadable: { type: "boolean" },
    requireApprovalReceipt: { type: "boolean" }
  }
};

const ROUTE_DECISION_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    route: {
      type: "string",
      enum: ["chat", "single_step", "multi_step", "ask_clarification", "approval_required"]
    },
    intent: { type: "string" },
    reason: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    missingInfo: {
      type: "array",
      items: { type: "string" }
    },
    riskFlags: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: ["route", "intent", "reason", "confidence", "missingInfo", "riskFlags"]
};

const PLAN_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    goal: { type: "string" },
    assumptions: {
      type: "array",
      items: { type: "string" }
    },
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          agent: {
            type: "string",
            enum: AGENT_KIND_VALUES
          },
          taskClass: {
            type: "string",
            enum: TASK_CLASS_VALUES
          },
          qualityProfile: QUALITY_PROFILE_SCHEMA,
          attemptStrategy: {
            type: "object",
            additionalProperties: true
          },
          objective: { type: "string" },
          dependsOn: {
            type: "array",
            items: { type: "string" }
          },
          inputs: {
            type: "array",
            items: { type: "string" }
          },
          expectedOutput: { type: "string" },
          successCriteria: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: [
          "id",
          "title",
          "agent",
          "objective",
          "dependsOn",
          "inputs",
          "expectedOutput",
          "successCriteria"
        ]
      }
    },
    taskSuccessCriteria: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: ["goal", "assumptions", "steps", "taskSuccessCriteria"]
};

const RESEARCH_SYNTHESIS_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    topResultUrl: { type: "string" },
    findings: {
      type: "array",
      items: { type: "string" }
    },
    marketSignals: {
      type: "array",
      items: { type: "string" }
    },
    coverageGaps: {
      type: "array",
      items: { type: "string" }
    },
    timelineEvents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          date: { type: "string" },
          event: { type: "string" },
          sourceUrl: { type: "string" }
        },
        required: ["date", "event", "sourceUrl"]
      }
    }
  },
  required: [
    "summary",
    "topResultUrl",
    "findings",
    "marketSignals",
    "coverageGaps",
    "timelineEvents"
  ]
};

type ResearchSynthesis = {
  summary: string;
  topResultUrl: string;
  findings: string[];
  marketSignals: string[];
  coverageGaps: string[];
  timelineEvents: Array<{ date: string; event: string; sourceUrl: string }>;
};

type BrowserSynthesis = {
  summary: string;
  currentUrl: string;
  pageTitle: string;
  evidencePoints: string[];
  extractedFacts: string[];
  nextQuestions: string[];
};

type CodingDraft = {
  summary: string;
  filename: string;
  pythonCode: string;
  expectedArtifacts: string[];
  fallbackKind?: "python" | "pdf";
};

const BROWSER_SYNTHESIS_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    currentUrl: { type: "string" },
    pageTitle: { type: "string" },
    evidencePoints: {
      type: "array",
      items: { type: "string" }
    },
    extractedFacts: {
      type: "array",
      items: { type: "string" }
    },
    nextQuestions: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: [
    "summary",
    "currentUrl",
    "pageTitle",
    "evidencePoints",
    "extractedFacts",
    "nextQuestions"
  ]
};

const CODING_DRAFT_FIELDS = ["summary", "filename", "pythonCode", "expectedArtifacts"] as const;

const DOCUMENT_DRAFT_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    title: { type: "string" },
    markdownBody: { type: "string" },
    usedSources: {
      type: "array",
      items: { type: "string" }
    },
    keySections: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: ["summary", "title", "markdownBody", "keySections", "usedSources"]
};

type DocumentDraft = {
  summary: string;
  title: string;
  markdownBody: string;
  keySections: string[];
  usedSources: string[];
};

const CODING_DRAFT_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    filename: { type: "string" },
    pythonCode: { type: "string" },
    expectedArtifacts: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: ["summary", "filename", "pythonCode", "expectedArtifacts"]
};

const VERIFICATION_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: {
      type: "string",
      enum: ["pass", "retry_step", "replan_task", "ask_user"]
    },
    reason: { type: "string" },
    missingCriteria: {
      type: "array",
      items: { type: "string" }
    },
    suggestedFix: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    qualityScore: { type: "number", minimum: 0, maximum: 100 },
    qualityDefects: {
      type: "array",
      items: { type: "string" }
    },
    missingEvidence: {
      type: "array",
      items: { type: "string" }
    },
    sourceCoverageScore: { type: "number", minimum: 0, maximum: 100 },
    formatCompliance: { type: "string" }
  },
  required: [
    "verdict",
    "reason",
    "missingCriteria",
    "suggestedFix",
    "confidence",
    "qualityScore",
    "qualityDefects",
    "missingEvidence",
    "sourceCoverageScore",
    "formatCompliance"
  ]
};

const userProfileSummary = (userProfile?: UserProfile): JsonObject =>
  userProfile
    ? {
        language: userProfile.language,
        outputStyle: userProfile.outputStyle,
        riskPolicy: userProfile.riskPolicy,
        preferences: userProfile.preferences
      }
    : {};

const coerceAgentKind = (value: string): AgentKind => {
  if (AGENT_KIND_VALUES.includes(value as AgentKind)) {
    return value as AgentKind;
  }

  throw new Error(`Unsupported agent kind in plan: ${value}`);
};

const canUseLiveLlm = (
  mode: AgentExecutionMode,
  llmClient?: OpenAIResponsesClient
): llmClient is OpenAIResponsesClient => mode === "live" && Boolean(llmClient?.isConfigured());

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const buildTextPreview = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated]`;

const uniqueStrings = (values: string[]): string[] => [...new Set(values.filter(Boolean))];

const extractMarkdownHeadings = (markdownBody: string): string[] => {
  const headings = markdownBody
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, "").trim())
    .filter((line) => line.length > 0);

  return headings.length > 0 ? headings : ["Summary"];
};

const PARSE_OR_SCHEMA_ERROR_PATTERN =
  /\b(json|schema|parse|parsing|unexpected token|unterminated|string literal|end of json input)\b/i;

const isParseOrSchemaError = (error: unknown): boolean =>
  PARSE_OR_SCHEMA_ERROR_PATTERN.test(getErrorMessage(error));

const stripMarkdownCodeFence = (text: string): string => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
};

const extractJsonObjectText = (text: string): string => {
  const candidate = stripMarkdownCodeFence(text);
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start === -1 || end === -1 || end < start) {
    return candidate;
  }

  return candidate.slice(start, end + 1);
};

const repairJsonText = (text: string): string => {
  const candidate = extractJsonObjectText(text);
  let repaired = "";
  let inString = false;
  let escapeNext = false;
  const closingStack: string[] = [];

  for (const char of candidate) {
    if (inString) {
      if (escapeNext) {
        repaired += char;
        escapeNext = false;
        continue;
      }

      if (char === "\\") {
        repaired += char;
        escapeNext = true;
        continue;
      }

      if (char === "\"") {
        repaired += char;
        inString = false;
        continue;
      }

      if (char === "\n") {
        repaired += "\\n";
        continue;
      }

      if (char === "\r") {
        repaired += "\\r";
        continue;
      }

      if (char === "\t") {
        repaired += "\\t";
        continue;
      }

      repaired += char;
      continue;
    }

    if (char === "\"") {
      repaired += char;
      inString = true;
      continue;
    }

    if (char === "{") {
      closingStack.push("}");
    } else if (char === "[") {
      closingStack.push("]");
    } else if (char === "}" || char === "]") {
      if (closingStack.at(-1) === char) {
        closingStack.pop();
      }
    }

    repaired += char;
  }

  if (inString) {
    repaired += "\"";
  }

  repaired = repaired.replace(/,\s*([}\]])/g, "$1");

  while (closingStack.length > 0) {
    repaired += closingStack.pop();
  }

  return repaired.trim();
};

const parseJsonWithConservativeRepair = <T>(text: string): T => {
  const candidate = extractJsonObjectText(text);

  try {
    return JSON.parse(candidate) as T;
  } catch {
    return JSON.parse(repairJsonText(candidate)) as T;
  }
};

const RESEARCH_SYNTHESIS_FIELDS = [
  "summary",
  "topResultUrl",
  "findings",
  "marketSignals",
  "coverageGaps",
  "timelineEvents"
] as const;

const BROWSER_SYNTHESIS_FIELDS = [
  "summary",
  "currentUrl",
  "pageTitle",
  "evidencePoints",
  "extractedFacts",
  "nextQuestions"
] as const;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const splitLooseListText = (value: string): string[] =>
  value
    .split(/\r?\n|[•·]|;\s*|；\s*|\u2022/)
    .map((item) => item.trim())
    .filter(Boolean);

const collectLooseStringFragments = (value: unknown, depth = 0): string[] => {
  if (depth > 4 || value == null) {
    return [];
  }

  if (typeof value === "string") {
    return splitLooseListText(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }

  if (Array.isArray(value)) {
    return uniqueStrings(
      value.flatMap((item) => collectLooseStringFragments(item, depth + 1))
    );
  }

  if (typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    const preferredKeys = [
      "items",
      "values",
      "value",
      "text",
      "content",
      "summary",
      "description",
      "snippet",
      "title",
      "label",
      "name",
      "signals",
      "gaps",
      "findings"
    ];
    const prioritized = preferredKeys.flatMap((key) =>
      Object.prototype.hasOwnProperty.call(candidate, key)
        ? collectLooseStringFragments(candidate[key], depth + 1)
        : []
    );
    const fallback = Object.entries(candidate)
      .filter(([key]) => !preferredKeys.includes(key))
      .flatMap(([, item]) => collectLooseStringFragments(item, depth + 1));

    return uniqueStrings([...prioritized, ...fallback]);
  }

  return [];
};

const normalizeStringList = (value: unknown, fieldName: string): string[] => {
  if (isStringArray(value)) {
    return value;
  }

  const normalized = uniqueStrings(collectLooseStringFragments(value));
  if (normalized.length > 0 || value == null) {
    return normalized;
  }

  throw new Error(`research synthesis schema mismatch: ${fieldName} must be string[]`);
};

const validateResearchSynthesis = (value: unknown): ResearchSynthesis => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("research synthesis schema mismatch: expected object");
  }

  const candidate = value as Record<string, unknown>;
  const extraKeys = Object.keys(candidate).filter(
    (key) => !RESEARCH_SYNTHESIS_FIELDS.includes(key as (typeof RESEARCH_SYNTHESIS_FIELDS)[number])
  );
  if (extraKeys.length > 0) {
    throw new Error(
      `research synthesis schema mismatch: unexpected fields ${extraKeys.join(", ")}`
    );
  }

  if (typeof candidate.summary !== "string") {
    throw new Error("research synthesis schema mismatch: summary must be string");
  }

  if (typeof candidate.topResultUrl !== "string") {
    throw new Error("research synthesis schema mismatch: topResultUrl must be string");
  }

  const findings = normalizeStringList(candidate.findings, "findings");
  const marketSignals = normalizeStringList(candidate.marketSignals, "marketSignals");
  const coverageGaps = normalizeStringList(candidate.coverageGaps, "coverageGaps");
  const timelineEvents = Array.isArray(candidate.timelineEvents)
    ? candidate.timelineEvents
        .flatMap((event) => {
          const eventCandidate = asJsonObject(event);
          const date = asOptionalString(eventCandidate["date"]);
          const summary = asOptionalString(eventCandidate["event"]);
          const sourceUrl = asOptionalString(eventCandidate["sourceUrl"]);
          if (!date || !summary || !sourceUrl) {
            return [];
          }
          return [{ date, event: summary, sourceUrl }];
        })
        .slice(0, 12)
    : [];

  return {
    summary: candidate.summary,
    topResultUrl: candidate.topResultUrl,
    findings,
    marketSignals,
    coverageGaps,
    timelineEvents
  };
};

const validateBrowserSynthesis = (value: unknown): BrowserSynthesis => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("browser synthesis schema mismatch: expected object");
  }

  const candidate = value as Record<string, unknown>;
  const extraKeys = Object.keys(candidate).filter(
    (key) => !BROWSER_SYNTHESIS_FIELDS.includes(key as (typeof BROWSER_SYNTHESIS_FIELDS)[number])
  );
  if (extraKeys.length > 0) {
    throw new Error(
      `browser synthesis schema mismatch: unexpected fields ${extraKeys.join(", ")}`
    );
  }

  if (typeof candidate.summary !== "string") {
    throw new Error("browser synthesis schema mismatch: summary must be string");
  }

  if (typeof candidate.currentUrl !== "string") {
    throw new Error("browser synthesis schema mismatch: currentUrl must be string");
  }

  if (typeof candidate.pageTitle !== "string") {
    throw new Error("browser synthesis schema mismatch: pageTitle must be string");
  }

  const evidencePoints = normalizeStringList(candidate.evidencePoints, "evidencePoints");
  const extractedFacts = normalizeStringList(candidate.extractedFacts, "extractedFacts");
  const nextQuestions = normalizeStringList(candidate.nextQuestions, "nextQuestions");

  return {
    summary: candidate.summary,
    currentUrl: candidate.currentUrl,
    pageTitle: candidate.pageTitle,
    evidencePoints,
    extractedFacts,
    nextQuestions
  };
};

const validateCodingDraft = (value: unknown): CodingDraft => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("coding draft schema mismatch: expected object");
  }

  const candidate = value as Record<string, unknown>;
  const extraKeys = Object.keys(candidate).filter(
    (key) => !CODING_DRAFT_FIELDS.includes(key as (typeof CODING_DRAFT_FIELDS)[number])
  );
  if (extraKeys.length > 0) {
    throw new Error(`coding draft schema mismatch: unexpected fields ${extraKeys.join(", ")}`);
  }

  if (typeof candidate.summary !== "string") {
    throw new Error("coding draft schema mismatch: summary must be string");
  }

  if (typeof candidate.filename !== "string") {
    throw new Error("coding draft schema mismatch: filename must be string");
  }

  if (typeof candidate.pythonCode !== "string") {
    throw new Error("coding draft schema mismatch: pythonCode must be string");
  }

  return {
    summary: candidate.summary,
    filename: candidate.filename,
    pythonCode: candidate.pythonCode,
    expectedArtifacts: normalizeStringList(candidate.expectedArtifacts, "expectedArtifacts")
  };
};

const validateDocumentDraft = (value: unknown): DocumentDraft => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("document draft schema mismatch: expected object");
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.summary !== "string") {
    throw new Error("document draft schema mismatch: summary must be string");
  }
  if (typeof candidate.title !== "string") {
    throw new Error("document draft schema mismatch: title must be string");
  }
  if (typeof candidate.markdownBody !== "string") {
    throw new Error("document draft schema mismatch: markdownBody must be string");
  }

  return {
    summary: candidate.summary,
    title: candidate.title,
    markdownBody: candidate.markdownBody,
    keySections: normalizeStringList(candidate.keySections, "keySections"),
    usedSources: normalizeStringList(candidate.usedSources, "usedSources")
  };
};

const QUALITY_THRESHOLDS: Record<TaskClass, number> = {
  [TaskClass.ResearchBrowser]: 75,
  [TaskClass.CodingPython]: 80,
  [TaskClass.DocumentExport]: 80,
  [TaskClass.ActionExecution]: 80
};

const buildQualityProfile = (
  taskClass: TaskClass,
  goal: string,
  step?: Partial<Pick<TaskStep, "title" | "objective" | "successCriteria">>
): QualityProfile => {
  if (taskClass === TaskClass.ResearchBrowser) {
    return {
      requiredEvidence: hasKeyword(goal, ["时间线", "timeline", "latest", "最新"])
        ? ["sources", "findings", "timelineEvents"]
        : ["sources", "findings"],
      minSourceCount: hasKeyword(goal, ["latest", "最新", "局势", "战情", "research", "调研"]) ? 3 : 2,
      requireSchemaValid: true,
      requireOutputReadable: true
    };
  }
  if (taskClass === TaskClass.CodingPython) {
    return {
      requiredEvidence: ["generatedFiles"],
      requireFileArtifacts: true,
      requireSchemaValid: true,
      requireOutputReadable: true
    };
  }
  if (taskClass === TaskClass.ActionExecution) {
    return {
      requiredEvidence: ["deliveryReceipt"],
      requireApprovalReceipt: true,
      requireOutputReadable: true
    };
  }

  const requiresPdf = hasKeyword(
    [goal, step?.title ?? "", step?.objective ?? "", ...(step?.successCriteria ?? [])].join("\n"),
    PDF_KEYWORDS
  );
  return {
    requiredEvidence: requiresPdf
      ? ["reportPreview", "keySections", "artifactValidation"]
      : ["reportPreview", "keySections"],
    requireFileArtifacts: true,
    requireOutputReadable: true,
    requireSchemaValid: true
  };
};

const classifyTaskClass = (
  goal: string,
  step: Pick<Plan["steps"][number], "agent" | "title" | "objective" | "successCriteria">
): TaskClass => {
  if (step.agent === AgentKind.Action) {
    return TaskClass.ActionExecution;
  }
  if (step.agent === AgentKind.Coding) {
    return TaskClass.CodingPython;
  }
  if (step.agent === AgentKind.Document) {
    return TaskClass.DocumentExport;
  }
  return TaskClass.ResearchBrowser;
};

const buildAttemptStrategy = (
  taskClass: TaskClass,
  agent: AgentKind,
  attempt = 0
): JsonObject => {
  if (attempt <= 0) {
    return {
      attempt,
      strategy: "default_execution",
      escalatedModel: false,
      maxRetries:
        agent === AgentKind.Research || agent === AgentKind.Browser
          ? 3
          : agent === AgentKind.Action
            ? 1
            : 2
    };
  }

  const strategy =
    attempt === 1
      ? "repair_context_and_retry"
      : attempt === 2
        ? "escalate_model_or_tool"
        : "fallback_or_replan";

  return {
    attempt,
    strategy,
    escalatedModel:
      attempt >= 1 &&
      [TaskClass.ResearchBrowser, TaskClass.DocumentExport].includes(taskClass),
    maxRetries:
      agent === AgentKind.Research || agent === AgentKind.Browser
        ? 3
        : agent === AgentKind.Action
          ? 1
          : 2
  };
};

export const hasTaskPrefix = (message: string): boolean => TASK_PREFIX_PATTERN.test(message);

export const stripTaskPrefix = (message: string): string =>
  message.replace(TASK_PREFIX_PATTERN, "").trim();

const isLongTaskPrompt = (message: string): boolean => {
  const normalized = message.trim();
  return normalized.length >= 120 || normalized.includes("\n");
};

export const buildPrefixedTaskRoute = (
  message: string,
  source: string,
  originalRoute?: RouteDecision
): RouteDecision => ({
  route: isLongTaskPrompt(stripTaskPrefix(message)) ? "multi_step" : "single_step",
  intent: "task_execution",
  reason: originalRoute
    ? `Classified by ${source} via TASK prefix override; original route=${originalRoute.route}; original reason=${originalRoute.reason}`
    : `Classified by ${source} via TASK prefix override`,
  confidence: 0.98,
  missingInfo: originalRoute?.missingInfo ?? [],
  riskFlags: originalRoute?.riskFlags ?? []
});

const buildLiveSynthesisFailure = (
  stage: string,
  error: unknown,
  structuredData: JsonObject = {}
): AgentResponse => {
  const originalErrorMessage = getErrorMessage(error);

  return {
    status: "failed",
    summary: `${stage} synthesis failed`,
    structuredData: {
      stage,
      originalErrorMessage,
      ...structuredData
    },
    error: {
      code: ErrorCode.Unknown,
      message: `${stage} synthesis failed: ${originalErrorMessage}`,
      retryable: true
    }
  };
};

const LLM_FALLBACK_ERROR_PATTERNS = [
  "insufficient_quota",
  "rate limit",
  "429",
  "timed out",
  "timeout",
  "network",
  "temporarily unavailable",
  "connection",
  "overloaded"
];

const shouldFallbackToLocalDraft = (error: unknown): boolean => {
  const message = getErrorMessage(error).toLowerCase();
  return LLM_FALLBACK_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
};

const classifyLlmFallbackReason = (
  error: unknown
): "quota" | "rate_limit" | "timeout" | "network" | "unavailable" => {
  const message = getErrorMessage(error).toLowerCase();
  if (message.includes("insufficient_quota") || message.includes("quota")) {
    return "quota";
  }
  if (message.includes("rate limit") || message.includes("429")) {
    return "rate_limit";
  }
  if (message.includes("timed out") || message.includes("timeout")) {
    return "timeout";
  }
  if (message.includes("network") || message.includes("connection")) {
    return "network";
  }
  return "unavailable";
};

const summarizeLlmFallbackReason = (
  error: unknown,
  target: "coding" | "document" | "pdf"
): { summary: string; category: string; rawReason: string } => {
  const rawReason = getErrorMessage(error);
  const category = classifyLlmFallbackReason(error);
  const targetLabel =
    target === "coding" ? "本地 Python" : target === "pdf" ? "本地 PDF" : "本地文档";

  switch (category) {
    case "quota":
      return {
        summary: `OpenAI 配额不足，已切换到${targetLabel} fallback`,
        category,
        rawReason
      };
    case "rate_limit":
      return {
        summary: `OpenAI 限流，已切换到${targetLabel} fallback`,
        category,
        rawReason
      };
    case "timeout":
      return {
        summary: `OpenAI 超时，已切换到${targetLabel} fallback`,
        category,
        rawReason
      };
    case "network":
      return {
        summary: `OpenAI 网络异常，已切换到${targetLabel} fallback`,
        category,
        rawReason
      };
    default:
      return {
        summary: `LLM 临时不可用，已切换到${targetLabel} fallback`,
        category,
        rawReason
      };
  }
};

const buildResearchRecoveryFailure = (
  originalError: unknown,
  recoveryError: unknown,
  structuredData: JsonObject = {}
): AgentResponse => {
  const originalErrorMessage = getErrorMessage(originalError);
  const recoveryErrorMessage = getErrorMessage(recoveryError);

  return {
    status: "failed",
    summary: "research synthesis failed",
    structuredData: {
      stage: "research",
      originalErrorMessage,
      recoveryErrorMessage,
      ...structuredData
    },
    error: {
      code: ErrorCode.Unknown,
      message: `research synthesis failed: ${originalErrorMessage}; recovery_failed: ${recoveryErrorMessage}`,
      retryable: true
    }
  };
};

const buildBrowserRecoveryFailure = (
  originalError: unknown,
  recoveryError: unknown,
  structuredData: JsonObject = {}
): AgentResponse => {
  const originalErrorMessage = getErrorMessage(originalError);
  const recoveryErrorMessage = getErrorMessage(recoveryError);

  return {
    status: "failed",
    summary: "browser synthesis failed",
    structuredData: {
      stage: "browser",
      originalErrorMessage,
      recoveryErrorMessage,
      ...structuredData
    },
    error: {
      code: ErrorCode.Unknown,
      message: `browser synthesis failed: ${originalErrorMessage}; recovery_failed: ${recoveryErrorMessage}`,
      retryable: true
    }
  };
};

const recoverResearchSynthesis = async (
  llmClient: OpenAIResponsesClient,
  payload: JsonObject,
  originalError: unknown
): Promise<ResearchSynthesis> => {
  const response = await llmClient.generateText({
    stage: "research",
    messages: [
      {
        role: "system",
        content: [
          RESEARCH_PROMPT_TEMPLATE,
          "Your previous response was invalid JSON or schema-invalid.",
          "Return strict JSON only with exactly these keys:",
          'summary (string), topResultUrl (string), findings (string[]), marketSignals (string[]), coverageGaps (string[]), timelineEvents ({date,event,sourceUrl}[]).',
          "Do not use markdown fences or explanatory text.",
          "Escape newlines inside JSON strings."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            ...payload,
            originalErrorMessage: getErrorMessage(originalError)
          },
          null,
          2
        )
      }
    ],
    maxOutputTokens: 1_200
  });

  return validateResearchSynthesis(parseJsonWithConservativeRepair(response.outputText));
};

const recoverBrowserSynthesis = async (
  llmClient: OpenAIResponsesClient,
  payload: JsonObject,
  originalError: unknown
): Promise<BrowserSynthesis> => {
  const response = await llmClient.generateText({
    stage: "browser",
    messages: [
      {
        role: "system",
        content: [
          BROWSER_PROMPT_TEMPLATE,
          "Your previous response was invalid JSON or schema-invalid.",
          "Return strict JSON only with exactly these keys:",
          'summary (string), currentUrl (string), pageTitle (string), evidencePoints (string[]), extractedFacts (string[]), nextQuestions (string[]).',
          "Do not use markdown fences or explanatory text.",
          "Escape newlines inside JSON strings."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            ...payload,
            originalErrorMessage: getErrorMessage(originalError)
          },
          null,
          2
        )
      }
    ],
    maxOutputTokens: 1_000
  });

  return validateBrowserSynthesis(parseJsonWithConservativeRepair(response.outputText));
};

const recoverCodingDraft = async (
  llmClient: OpenAIResponsesClient,
  payload: JsonObject,
  originalError: unknown
): Promise<CodingDraft> => {
  const response = await llmClient.generateText({
    stage: "coding",
    messages: [
      {
        role: "system",
        content: [
          CODING_PROMPT_TEMPLATE,
          "Your previous response was invalid JSON or schema-invalid.",
          "Return strict JSON only with exactly these keys:",
          'summary (string), filename (string), pythonCode (string), expectedArtifacts (string[]).',
          "Do not use markdown fences or explanatory text.",
          "Escape newlines inside JSON strings."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            ...payload,
            originalErrorMessage: getErrorMessage(originalError)
          },
          null,
          2
        )
      }
    ],
    maxOutputTokens: 2_400
  });

  return validateCodingDraft(parseJsonWithConservativeRepair(response.outputText));
};

const recoverDocumentDraft = async (
  llmClient: OpenAIResponsesClient,
  payload: JsonObject,
  originalError: unknown
): Promise<DocumentDraft> => {
  const response = await llmClient.generateText({
    stage: "document",
    messages: [
      {
        role: "system",
        content: [
          DOCUMENT_PROMPT_TEMPLATE,
          "Your previous response was invalid JSON or schema-invalid.",
          "Return strict JSON only with exactly these keys:",
          'summary (string), title (string), markdownBody (string), keySections (string[]), usedSources (string[]).',
          "Do not use markdown fences or explanatory text.",
          "Escape newlines inside JSON strings."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            ...payload,
            originalErrorMessage: getErrorMessage(originalError)
          },
          null,
          2
        )
      }
    ],
    maxOutputTokens: 2_200
  });

  return validateDocumentDraft(parseJsonWithConservativeRepair(response.outputText));
};

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => String(item)) : [];

const asJsonObject = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};

const asUrlArray = (value: unknown): string[] =>
  uniqueStrings(
    Array.isArray(value)
      ? value
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter((item) => item.startsWith("http://") || item.startsWith("https://"))
      : []
  );

const collectSearchResultUrls = (results: unknown, maxUrls = 6): string[] => {
  if (!Array.isArray(results)) {
    return [];
  }

  const urls = results.flatMap((result) => {
    const candidate = asJsonObject(result);
    return typeof candidate.url === "string" ? [candidate.url.trim()] : [];
  });

  return asUrlArray(urls).slice(0, maxUrls);
};

const classifySourceTier = (url: string): "tier1" | "tier2" | "tier3" => {
  const normalized = url.toLowerCase();
  if (
    normalized.includes(".gov") ||
    normalized.includes(".gouv") ||
    normalized.includes(".edu") ||
    normalized.includes(".org") ||
    normalized.includes("reuters.com") ||
    normalized.includes("apnews.com") ||
    normalized.includes("bbc.") ||
    normalized.includes("u.ae") ||
    normalized.includes("dm.gov.ae") ||
    normalized.includes("mohap.gov.ae")
  ) {
    return "tier1";
  }
  if (
    normalized.includes("gulfbusiness.com") ||
    normalized.includes("gulfnews.com") ||
    normalized.includes("khaleejtimes.com") ||
    normalized.includes("forbes") ||
    normalized.includes("bloomberg") ||
    normalized.includes("intertek") ||
    normalized.includes("sgs")
  ) {
    return "tier2";
  }
  return "tier3";
};

const buildSourceEvidence = (
  results: unknown,
  maxItems = 12
): Array<{ title: string; url: string; snippet: string; tier: string }> => {
  if (!Array.isArray(results)) {
    return [];
  }

  const seen = new Set<string>();
  const sources: Array<{ title: string; url: string; snippet: string; tier: string }> = [];
  for (const result of results) {
    const candidate = asJsonObject(result);
    const url = asOptionalString(candidate["url"]);
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    sources.push({
      title: asOptionalString(candidate["title"]) ?? url,
      url,
      snippet: asOptionalString(candidate["snippet"]) ?? "",
      tier: classifySourceTier(url)
    });
    if (sources.length >= maxItems) {
      break;
    }
  }

  return sources;
};

const DATE_PATTERN =
  /\b(?:20\d{2}[-/]\d{1,2}[-/]\d{1,2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+20\d{2}|\d{1,2}\s+[A-Z][a-z]{2,8}\s+20\d{2})\b/gi;

const buildTimelineEventsFromSources = (
  results: unknown,
  maxItems = 8
): Array<{ date: string; event: string; sourceUrl: string }> => {
  if (!Array.isArray(results)) {
    return [];
  }

  const events: Array<{ date: string; event: string; sourceUrl: string }> = [];
  for (const result of results) {
    const candidate = asJsonObject(result);
    const url = asOptionalString(candidate["url"]);
    const title = asOptionalString(candidate["title"]) ?? "";
    const snippet = asOptionalString(candidate["snippet"]) ?? "";
    if (!url) {
      continue;
    }
    const haystack = `${title}. ${snippet}`;
    const matches = haystack.match(DATE_PATTERN);
    if (!matches || matches.length === 0) {
      continue;
    }
    events.push({
      date: matches[0],
      event: buildTextPreview(haystack, 200),
      sourceUrl: url
    });
    if (events.length >= maxItems) {
      break;
    }
  }

  return events;
};

const BLOCKED_PAGE_PATTERNS = [
  "cloudflare",
  "attention required",
  "captcha",
  "access denied",
  "temporarily blocked",
  "verify you are human",
  "enable javascript and cookies",
  "please enable cookies",
  "security check",
  "request blocked"
];

const detectBlockedPageReason = (
  pageTitle: string,
  extractedText: string,
  currentUrl: string
): string | undefined => {
  const haystack = `${pageTitle}\n${extractedText}\n${currentUrl}`.toLowerCase();
  const matched = BLOCKED_PAGE_PATTERNS.find((pattern) => haystack.includes(pattern));
  if (!matched) {
    return undefined;
  }

  return `Blocked or challenge page detected: ${matched}`;
};

const NON_SUBSTANTIVE_PAGE_PATTERNS = [
  "404 - file or directory not found",
  "404 not found",
  "page not found",
  "file or directory not found",
  "resource you are looking for might have been removed",
  "temporarily unavailable",
  "the page you requested could not be found",
  "page you requested was not found",
  "this page isn’t available",
  "this page isn't available"
];

const detectNonSubstantivePageReason = (
  pageTitle: string,
  extractedText: string,
  currentUrl: string
): string | undefined => {
  const haystack = `${pageTitle}\n${extractedText}\n${currentUrl}`.toLowerCase();
  const matched = NON_SUBSTANTIVE_PAGE_PATTERNS.find((pattern) => haystack.includes(pattern));
  if (!matched) {
    return undefined;
  }

  return `Low-substance page detected: ${matched}`;
};

const getBrowserCandidateUrls = (context: JsonObject): string[] => {
  const explicitCandidates = asUrlArray(context["browserCandidateUrls"]);
  const fallbackTopResult = asOptionalString(context["topResultUrl"]);
  return uniqueStrings(
    fallbackTopResult ? [fallbackTopResult, ...explicitCandidates] : explicitCandidates
  );
};

const SIDE_EFFECT_KEYWORDS = [
  "通知",
  "发送",
  "邮件",
  "email",
  "webhook",
  "slack",
  "notion",
  "发到",
  "post to",
  "push to"
];

const CODING_KEYWORDS = [
  "python",
  "脚本",
  "代码",
  "script",
  "csv",
  "json",
  "excel",
  "xlsx",
  "sql",
  "数据清洗",
  "数据分析",
  "transform",
  "parse"
];

const REPORT_KEYWORDS = ["报告", "report", "总结", "summary", "markdown", "文档", "brief"];

const PDF_KEYWORDS = ["pdf", "导出pdf", "输出pdf", "pdf文件", "导出为pdf", "排版并导出pdf"];
const EMAIL_KEYWORDS = ["email", "邮件", "mail", "发邮件"];
const SLACK_KEYWORDS = ["slack"];
const NOTION_KEYWORDS = ["notion"];

const buildUploadedFileCodingDraft = (input: AgentRequest): CodingDraft | undefined => {
  const currentStep = asJsonObject(input.context["currentStep"]);
  const objective = asOptionalString(currentStep["objective"]) ?? input.goal;
  const uploadedArtifactUris = asStringArray(input.context["uploadedArtifactUris"]).filter((uri) =>
    /\.(csv|tsv|xlsx|xls|json|txt|md)$/i.test(uri)
  );

  if (uploadedArtifactUris.length === 0) {
    return undefined;
  }

  const pythonCode = [
    "from pathlib import Path",
    "import csv",
    "import json",
    "",
    `payload = json.loads(${JSON.stringify(JSON.stringify({
      goal: stripTaskPrefix(input.goal),
      objective,
      uploadedArtifactUris
    }))})`,
    "if isinstance(payload, str):",
    "  payload = json.loads(payload)",
    "inputs_dir = Path('inputs')",
    "analysis = {",
    "  'goal': payload['goal'],",
    "  'objective': payload['objective'],",
    "  'uploadedArtifactUris': payload.get('uploadedArtifactUris', []),",
    "  'files': []",
    "}",
    "report_lines = ['## Uploaded File Analysis', '']",
    "for file_path in sorted(inputs_dir.glob('*')):",
    "  suffix = file_path.suffix.lower()",
    "  entry = {'name': file_path.name, 'suffix': suffix}",
    "  if suffix in ('.csv', '.tsv'):",
    "    delimiter = ',' if suffix == '.csv' else '\\t'",
    "    with file_path.open('r', encoding='utf-8') as handle:",
    "      rows = list(csv.reader(handle, delimiter=delimiter))",
    "    header = rows[0] if rows else []",
    "    data_rows = rows[1:] if len(rows) > 1 else []",
    "    numeric_values = []",
    "    for row in data_rows:",
    "      for value in row:",
    "        try:",
    "          numeric_values.append(float(value))",
    "        except Exception:",
    "          pass",
    "    entry['rowCount'] = len(data_rows)",
    "    entry['columns'] = header",
    "    if numeric_values:",
    "      entry['numericSummary'] = {",
    "        'count': len(numeric_values),",
    "        'sum': sum(numeric_values),",
    "        'min': min(numeric_values),",
    "        'max': max(numeric_values)",
    "      }",
    "    report_lines.append(f\"- {file_path.name}: {len(data_rows)} data rows\")",
    "  elif suffix == '.xlsx':",
    "    try:",
    "      from openpyxl import load_workbook",
    "    except ImportError as exc:",
    "      raise RuntimeError('openpyxl is required to read .xlsx inputs in the python sandbox') from exc",
    "    workbook = load_workbook(file_path, read_only=True, data_only=True)",
    "    sheet = workbook[workbook.sheetnames[0]]",
    "    rows = list(sheet.iter_rows(values_only=True))",
    "    header = [str(cell) if cell is not None else '' for cell in rows[0]] if rows else []",
    "    data_rows = rows[1:] if len(rows) > 1 else []",
    "    numeric_values = []",
    "    for row in data_rows:",
    "      for value in row:",
    "        if isinstance(value, (int, float)):",
    "          numeric_values.append(float(value))",
    "    entry['sheetName'] = workbook.sheetnames[0]",
    "    entry['rowCount'] = len(data_rows)",
    "    entry['columns'] = header",
    "    if numeric_values:",
    "      entry['numericSummary'] = {",
    "        'count': len(numeric_values),",
    "        'sum': sum(numeric_values),",
    "        'min': min(numeric_values),",
    "        'max': max(numeric_values)",
    "      }",
    "    report_lines.append(f\"- {file_path.name}: {len(data_rows)} workbook rows\")",
    "  elif suffix == '.xls':",
    "    raise RuntimeError('.xls inputs are not supported; please convert the file to .xlsx or .csv')",
    "  elif suffix == '.json':",
    "    data = json.loads(file_path.read_text(encoding='utf-8'))",
    "    entry['jsonType'] = type(data).__name__",
    "    if isinstance(data, list):",
    "      entry['itemCount'] = len(data)",
    "    elif isinstance(data, dict):",
    "      entry['keys'] = list(data.keys())[:20]",
    "    report_lines.append(f\"- {file_path.name}: JSON {entry['jsonType']}\")",
    "  else:",
    "    text = file_path.read_text(encoding='utf-8')",
    "    preview = '\\n'.join(text.splitlines()[:12])",
    "    entry['charCount'] = len(text)",
    "    entry['preview'] = preview",
    "    report_lines.append(f\"- {file_path.name}: text preview captured\")",
    "  analysis['files'].append(entry)",
    "Path('coding-output.json').write_text(json.dumps(analysis, ensure_ascii=False, indent=2), encoding='utf-8')",
    "Path('coding-output.md').write_text('\\n'.join(report_lines) + '\\n', encoding='utf-8')",
    "print(json.dumps({'generated': ['coding-output.json', 'coding-output.md'], 'fileCount': len(analysis['files'])}, ensure_ascii=False))"
  ].join("\n");

  return {
    summary: `Prepare a local Python sandbox script for uploaded files: ${objective}`,
    filename: "uploaded-file-analysis.py",
    pythonCode,
    expectedArtifacts: ["coding-output.json", "coding-output.md"],
    fallbackKind: "python"
  };
};

const buildMockCodingDraft = (input: AgentRequest): CodingDraft => {
  const uploadedFileDraft = buildUploadedFileCodingDraft(input);
  if (uploadedFileDraft) {
    return uploadedFileDraft;
  }

  const currentStep = asJsonObject(input.context["currentStep"]);
  const objective = asOptionalString(currentStep["objective"]) ?? input.goal;
  const previousStepSummaries = asStringArray(input.context["previousStepSummaries"]);
  const artifactUris = asStringArray(input.context["artifactUris"]);

  const pythonCode = [
    "from pathlib import Path",
    "import json",
    "import re",
    "",
    `payload = json.loads(${JSON.stringify(JSON.stringify({
      goal: stripTaskPrefix(input.goal),
      objective,
      previousStepSummaries,
      artifactUris
    }))})`,
    "if isinstance(payload, str):",
    "  payload = json.loads(payload)",
    "goal = payload['goal']",
    "objective = payload['objective']",
    "text = goal + '\\n' + objective",
    "numbers = [float(match) for match in re.findall(r'-?\\d+(?:\\.\\d+)?', text)]",
    "analysis = {",
    "  'goal': goal,",
    "  'objective': objective,",
    "  'previousStepSummaries': payload.get('previousStepSummaries', []),",
    "  'artifactUris': payload.get('artifactUris', []),",
    "  'numberCount': len(numbers),",
    "}",
    "if numbers:",
    "  analysis['numericSummary'] = {",
    "    'sum': sum(numbers),",
    "    'min': min(numbers),",
    "    'max': max(numbers)",
    "  }",
    "Path('coding-output.json').write_text(json.dumps(analysis, ensure_ascii=False, indent=2), encoding='utf-8')",
    "report_lines = [",
    "  '## Python Sandbox Result',",
    "  '',",
    "  f'- Goal: {goal}',",
    "  f'- Objective: {objective}',",
    "  f'- Numbers detected: {len(numbers)}'",
    "]",
    "if numbers:",
    "  report_lines.append(f\"- Sum: {sum(numbers)}\")",
    "Path('coding-output.md').write_text('\\n'.join(report_lines) + '\\n', encoding='utf-8')",
    "print(json.dumps({'generated': ['coding-output.json', 'coding-output.md'], 'numberCount': len(numbers)}, ensure_ascii=False))"
  ].join("\n");

  return {
    summary: `Prepare a local Python sandbox script for: ${objective}`,
    filename: "coding-task.py",
    pythonCode,
    expectedArtifacts: ["coding-output.json", "coding-output.md"],
    fallbackKind: "python"
  };
};

const isPdfExportRequest = (input: AgentRequest): boolean => {
  const currentStep = asJsonObject(input.context["currentStep"]);
  const objective = asOptionalString(currentStep["objective"]) ?? "";
  const title = asOptionalString(currentStep["title"]) ?? "";
  const expectedOutput = asOptionalString(currentStep["expectedOutput"]) ?? "";
  const successCriteria = Array.isArray(input.successCriteria)
    ? input.successCriteria.map(String).join("\n")
    : "";
  const stepSignals = [title, objective, expectedOutput, successCriteria]
    .filter((value) => value.length > 0)
    .join("\n");

  if (stepSignals.length > 0) {
    return isExplicitPdfExportPlanStep({
      title,
      objective,
      expectedOutput,
      successCriteria: Array.isArray(input.successCriteria) ? input.successCriteria.map(String) : []
    });
  }

  return hasKeyword([input.goal, successCriteria].join("\n"), PDF_KEYWORDS);
};

const stepRequiresPdfArtifact = (step: TaskStep): boolean =>
  isExplicitPdfExportPlanStep({
    title: step.title,
    objective: step.objective,
    successCriteria: Array.isArray(step.successCriteria) ? step.successCriteria : []
  });

const hasPdfVerificationEvidence = (response: AgentResponse): boolean => {
  const structuredData = asJsonObject(response.structuredData ?? {});
  const reportPreview = asOptionalString(structuredData["reportPreview"]) ?? "";
  const keySections = asStringArray(structuredData["keySections"]);
  const generatedFiles = asStringArray(structuredData["generatedFiles"]);
  const artifacts = Array.isArray(response.artifacts) ? response.artifacts.map(String) : [];

  return (
    (reportPreview.trim().length > 0 || keySections.length > 0) &&
    [...artifacts, ...generatedFiles].some((file) => file.toLowerCase().endsWith(".pdf"))
  );
};

const collectGeneratedArtifactEvidence = async (
  generatedFiles: string[]
): Promise<{
  reportPreview?: string;
  keySections?: string[];
  generatedFilePreviews?: Array<{ path: string; preview: string }>;
}> => {
  const previews: Array<{ path: string; preview: string }> = [];
  let reportPreview: string | undefined;
  let keySections: string[] | undefined;

  for (const filePath of generatedFiles.slice(0, 4)) {
    const lower = filePath.toLowerCase();
    if (![".md", ".txt", ".json", ".csv"].some((extension) => lower.endsWith(extension))) {
      continue;
    }

    try {
      const contents = await fs.readFile(filePath, "utf8");
      const preview = buildTextPreview(contents, 2_000);
      previews.push({ path: filePath, preview });

      if (!reportPreview && (lower.endsWith(".md") || lower.endsWith(".txt"))) {
        reportPreview = preview;
        keySections = extractMarkdownHeadings(contents);
      } else if (!reportPreview && lower.endsWith(".json")) {
        reportPreview = preview;
        keySections = ["JSON Output"];
      }
    } catch {
      // Ignore unreadable generated files; execution already succeeded.
    }
  }

  return {
    ...(reportPreview ? { reportPreview } : {}),
    ...(keySections && keySections.length > 0 ? { keySections } : {}),
    ...(previews.length > 0 ? { generatedFilePreviews: previews } : {})
  };
};

const normalizeVerificationDecision = (
  step: TaskStep,
  response: AgentResponse,
  decision: VerificationDecision
): VerificationDecision => {
  const qualityScore = typeof decision.qualityScore === "number" ? decision.qualityScore : undefined;
  const qualityDefects = Array.isArray(decision.qualityDefects) ? decision.qualityDefects : [];
  const missingEvidence = Array.isArray(decision.missingEvidence) ? decision.missingEvidence : [];
  const sourceCoverageScore =
    typeof decision.sourceCoverageScore === "number" ? decision.sourceCoverageScore : 0;
  const formatCompliance = decision.formatCompliance ?? "unknown";

  if (
    stepRequiresPdfArtifact(step) &&
    decision.verdict !== "pass" &&
    hasPdfVerificationEvidence(response)
  ) {
    return {
      verdict: "pass",
      reason: "PDF artifact and preview evidence are present",
      missingCriteria: [],
      suggestedFix: "",
      confidence: Math.max(decision.confidence, 0.9),
      qualityScore: Math.max(qualityScore ?? 85, 85),
      qualityDefects: qualityDefects.filter((item) => !/pdf|artifact/i.test(item)),
      missingEvidence: missingEvidence.filter((item) => !/pdf|artifact/i.test(item)),
      sourceCoverageScore,
      formatCompliance: "validated_pdf_artifact"
    };
  }

  return {
    ...decision,
    ...(typeof qualityScore === "number" ? { qualityScore } : {}),
    ...(qualityDefects.length > 0 ? { qualityDefects } : {}),
    ...(missingEvidence.length > 0 ? { missingEvidence } : {}),
    ...(typeof sourceCoverageScore === "number" ? { sourceCoverageScore } : {}),
    ...(formatCompliance ? { formatCompliance } : {})
  };
};

const getStepTaskClass = (task: Task, step: TaskStep): TaskClass =>
  step.taskClass ?? classifyTaskClass(task.goal, step);

const calculateQualityAssessment = (
  task: Task,
  step: TaskStep,
  response: AgentResponse
): VerificationDecision => {
  const taskClass = getStepTaskClass(task, step);
  const profile = step.qualityProfile ?? buildQualityProfile(taskClass, task.goal, step);
  const structured = asJsonObject(response.structuredData);
  const artifacts = Array.isArray(response.artifacts) ? response.artifacts.map(String) : [];
  const qualityDefects: string[] = [];
  const missingEvidence: string[] = [];
  const missingCriteria: string[] = [];
  let sourceCoverageScore = 0;
  let formatCompliance = "valid";

  if (response.status === "need_approval") {
    return {
      verdict: "ask_user",
      reason: response.summary || "Step requires approval before execution",
      missingCriteria: step.successCriteria,
      suggestedFix: "Approve the pending action to continue execution",
      confidence: 0.92,
      qualityScore: 80,
      qualityDefects: [],
      missingEvidence: ["approval"],
      sourceCoverageScore: 100,
      formatCompliance: "approval_pending"
    };
  }

  if (response.status !== "success") {
    return {
      verdict: response.error?.retryable ? "retry_step" : "replan_task",
      reason: response.error?.message || response.summary || "Step failed",
      missingCriteria: step.successCriteria,
      suggestedFix: "Inspect tool output or retry with stronger strategy",
      confidence: 0.82,
      qualityScore: 15,
      qualityDefects: [response.error?.message || "step execution failed"],
      missingEvidence: profile.requiredEvidence ?? [],
      sourceCoverageScore: 0,
      formatCompliance: "failed"
    };
  }

  if (taskClass === TaskClass.ResearchBrowser) {
    const sources = Array.isArray(structured["sources"]) ? structured["sources"] : [];
    const findings = asFindingsArray(structured["findings"]);
    const extractedFacts = asStringArray(structured["extractedFacts"]);
    const timelineEvents = Array.isArray(structured["timelineEvents"]) ? structured["timelineEvents"] : [];
    const requiresTimelineEvidence = (profile.requiredEvidence ?? []).includes("timelineEvents");
    const inheritedTimelineEvidence =
      step.agent === AgentKind.Browser &&
      task.steps.some((candidate) => {
        if (candidate.id === step.id || candidate.status !== StepStatus.Completed) {
          return false;
        }
        const candidateStructured = asJsonObject(candidate.structuredData);
        return (
          Array.isArray(candidateStructured["timelineEvents"]) &&
          candidateStructured["timelineEvents"].length > 0
        );
      });
    const sourceCount =
      typeof structured["sourceCount"] === "number" ? Number(structured["sourceCount"]) : sources.length;
    const minSourceCount = profile.minSourceCount ?? 2;
    sourceCoverageScore = Math.min(100, sourceCount * 20);
    if (sourceCount < minSourceCount) {
      qualityDefects.push(`source coverage below threshold (${sourceCount}/${minSourceCount})`);
      missingEvidence.push("sources");
      missingCriteria.push(`至少 ${minSourceCount} 个来源`);
    }
    if (findings.length === 0 && extractedFacts.length === 0) {
      qualityDefects.push("no findings or extracted facts");
      missingEvidence.push("findings");
    }
    if (
      requiresTimelineEvidence &&
      timelineEvents.length === 0 &&
      !inheritedTimelineEvidence
    ) {
      qualityDefects.push("timeline evidence missing");
      missingEvidence.push("timelineEvents");
    }
  } else if (taskClass === TaskClass.CodingPython) {
    const generatedFiles = asStringArray(structured["generatedFiles"]);
    const outputSchemas = asStringArray(structured["outputSchemas"]);
    const artifactValidation = asJsonObject(structured["artifactValidation"]);
    const stderr = asOptionalString(structured["stderr"]) ?? "";
    if ((profile.requireFileArtifacts ?? true) && generatedFiles.length === 0 && artifacts.length === 0) {
      qualityDefects.push("no generated files or artifacts");
      missingEvidence.push("generatedFiles");
    }
    if (stderr.toLowerCase().includes("syntaxerror")) {
      qualityDefects.push("python syntax error");
      formatCompliance = "invalid_python";
    }
    if ((profile.requireSchemaValid ?? true) && generatedFiles.length > 0 && outputSchemas.length === 0) {
      qualityDefects.push("generated files have no output schema hints");
    }
    if (artifactValidation["validated"] === false) {
      qualityDefects.push("artifact validation failed");
      formatCompliance = "artifact_validation_failed";
    }
  } else if (taskClass === TaskClass.DocumentExport) {
    const keySections = asStringArray(structured["keySections"]);
    const reportPreview = asOptionalString(structured["reportPreview"]) ?? "";
    const artifactValidation = asJsonObject(structured["artifactValidation"]);
    const usedSources = asStringArray(structured["usedSources"]);
    if (artifacts.length === 0) {
      qualityDefects.push("document step returned no artifact");
      missingEvidence.push("artifact");
    }
    if (reportPreview.trim().length === 0) {
      qualityDefects.push("missing report preview");
      missingEvidence.push("reportPreview");
    }
    if (keySections.length === 0) {
      qualityDefects.push("missing key sections");
      missingEvidence.push("keySections");
    }
    if (stepRequiresPdfArtifact(step) && ![...artifacts, ...asStringArray(structured["generatedFiles"])].some((file) => file.toLowerCase().endsWith(".pdf"))) {
      qualityDefects.push("missing pdf artifact");
      missingEvidence.push("pdf artifact");
      formatCompliance = "missing_pdf";
    }
    if (usedSources.length === 0 && hasKeyword(task.goal, ["source", "sources", "来源", "链接"])) {
      qualityDefects.push("missing source references");
      missingEvidence.push("usedSources");
    }
    if (artifactValidation["validated"] === false) {
      qualityDefects.push("artifact validation failed");
      formatCompliance = "artifact_validation_failed";
    }
  } else if (taskClass === TaskClass.ActionExecution) {
    const receipt = asJsonObject(structured["deliveryReceipt"]);
    const approvalStatus = asOptionalString(structured["approvalStatus"]);
    if ((profile.requireApprovalReceipt ?? true) && Object.keys(receipt).length === 0) {
      qualityDefects.push("missing delivery receipt");
      missingEvidence.push("deliveryReceipt");
    }
    if (!approvalStatus || (approvalStatus !== ApprovalStatus.Executed && approvalStatus !== ApprovalStatus.Approved)) {
      qualityDefects.push("approval receipt missing or not executed");
    }
  }

  const qualityScore = Math.max(
    0,
    Math.min(100, 100 - qualityDefects.length * 15 - missingEvidence.length * 10)
  );
  const threshold = QUALITY_THRESHOLDS[taskClass];
  const verdict =
    qualityDefects.length === 0 && missingEvidence.length === 0 && qualityScore >= threshold
      ? "pass"
      : response.error?.retryable || qualityDefects.length > 0 || missingEvidence.length > 0
        ? "retry_step"
        : "replan_task";

  return {
    verdict,
    reason:
      verdict === "pass"
        ? `Step satisfies ${taskClass} quality gate`
        : qualityDefects[0] ?? missingEvidence[0] ?? "Step requires more evidence",
    missingCriteria,
    suggestedFix:
      verdict === "pass"
        ? ""
        : taskClass === TaskClass.ResearchBrowser
          ? "Collect more authoritative sources or usable timeline evidence"
          : taskClass === TaskClass.CodingPython
            ? "Regenerate executable code and required artifacts"
            : taskClass === TaskClass.DocumentExport
              ? "Regenerate document with readable sections and final artifacts"
              : "Re-run after approval or collect execution receipt",
    confidence: verdict === "pass" ? 0.9 : 0.83,
    qualityScore,
    qualityDefects,
    missingEvidence,
    sourceCoverageScore,
    formatCompliance
  };
};

const mergeVerificationDecision = (
  baseline: VerificationDecision,
  candidate: VerificationDecision
): VerificationDecision => {
  if (baseline.verdict !== "pass" && candidate.verdict === "pass") {
    return baseline;
  }

  return {
    ...baseline,
    ...candidate,
    ...(typeof candidate.qualityScore === "number"
      ? { qualityScore: candidate.qualityScore }
      : typeof baseline.qualityScore === "number"
        ? { qualityScore: baseline.qualityScore }
        : {}),
    ...((Array.isArray(candidate.qualityDefects) && candidate.qualityDefects.length > 0)
      ? { qualityDefects: candidate.qualityDefects }
      : Array.isArray(baseline.qualityDefects) && baseline.qualityDefects.length > 0
        ? { qualityDefects: baseline.qualityDefects }
        : {}),
    ...((Array.isArray(candidate.missingEvidence) && candidate.missingEvidence.length > 0)
      ? { missingEvidence: candidate.missingEvidence }
      : Array.isArray(baseline.missingEvidence) && baseline.missingEvidence.length > 0
        ? { missingEvidence: baseline.missingEvidence }
        : {}),
    ...(typeof candidate.sourceCoverageScore === "number"
      ? { sourceCoverageScore: candidate.sourceCoverageScore }
      : typeof baseline.sourceCoverageScore === "number"
        ? { sourceCoverageScore: baseline.sourceCoverageScore }
        : {}),
    ...(candidate.formatCompliance
      ? { formatCompliance: candidate.formatCompliance }
      : baseline.formatCompliance
        ? { formatCompliance: baseline.formatCompliance }
        : {})
  };
};

const findMarkdownArtifactForPdfExport = (input: AgentRequest): string | undefined => {
  const artifactUris = uniqueStrings([
    ...asStringArray(input.context["artifactUris"]),
    ...(Array.isArray(input.artifacts) ? input.artifacts.map(String) : [])
  ]).filter((artifact) => artifact.toLowerCase().endsWith(".md"));

  return (
    artifactUris.find((artifact) => artifact.toLowerCase().endsWith("/report.md")) ??
    artifactUris[0]
  );
};

const resolvePdfSource = async (
  input: AgentRequest
): Promise<{ title: string; markdownBody: string; sourceMarkdownPath?: string }> => {
  const currentStep = asJsonObject(input.context["currentStep"]);
  const title =
    asOptionalString(currentStep["title"]) || stripTaskPrefix(input.goal) || "Task Brief";
  const sourceMarkdownPath = findMarkdownArtifactForPdfExport(input);

  if (sourceMarkdownPath) {
    try {
      return {
        title,
        markdownBody: await fs.readFile(sourceMarkdownPath, "utf8"),
        sourceMarkdownPath
      };
    } catch {
      // Fall back to text synthesis below.
    }
  }

  const previousSummaries = asStringArray(input.context["previousStepSummaries"]);
  const markdownBody =
    previousSummaries.length > 0
      ? ["## Key Findings", "", ...previousSummaries.map((summary) => `- ${summary}`)].join("\n")
      : `## Summary\n\n${stripTaskPrefix(input.goal)}`;

  return {
    title,
    markdownBody,
    ...(sourceMarkdownPath ? { sourceMarkdownPath } : {})
  };
};

const buildLocalPdfExportDraft = (input: AgentRequest): CodingDraft | undefined => {
  const sourceMarkdownPath = findMarkdownArtifactForPdfExport(input);
  if (!sourceMarkdownPath) {
    return undefined;
  }

  const currentStep = asJsonObject(input.context["currentStep"]);
  const objective = asOptionalString(currentStep["objective"]) ?? input.goal;
  const payload = {
    goal: stripTaskPrefix(input.goal),
    objective,
    sourceMarkdownPath,
    outputPdfName: "brief.pdf",
    manifestName: "pdf-export.json"
  };

  const pythonCode = [
    "from pathlib import Path",
    "import json",
    "from reportlab.lib.pagesizes import A4",
    "from reportlab.lib.utils import simpleSplit",
    "from reportlab.pdfbase import pdfmetrics",
    "from reportlab.pdfbase.cidfonts import UnicodeCIDFont",
    "from reportlab.pdfgen import canvas",
    "",
    `payload = json.loads(${JSON.stringify(JSON.stringify(payload))})`,
    "if isinstance(payload, str):",
    "  payload = json.loads(payload)",
    "source_path = Path(payload['sourceMarkdownPath'])",
    "if not source_path.exists():",
    "  raise FileNotFoundError(f'Markdown source not found: {source_path}')",
    "output_path = Path(payload['outputPdfName'])",
    "manifest_path = Path(payload['manifestName'])",
    "markdown_text = source_path.read_text(encoding='utf-8')",
    "pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))",
    "font_name = 'STSong-Light'",
    "page_width, page_height = A4",
    "margin = 48",
    "line_height = 18",
    "font_size = 11",
    "pdf = canvas.Canvas(str(output_path), pagesize=A4)",
    "pdf.setTitle(payload['goal'])",
    "y = page_height - margin",
    "for raw_line in markdown_text.splitlines():",
    "  line = raw_line.strip()",
    "  if line.startswith('#'):",
    "    line = line.lstrip('#').strip()",
    "  elif line.startswith('- ') or line.startswith('* '):",
    "    line = f'• {line[2:].strip()}'",
    "  if not line:",
    "    if y <= margin:",
    "      pdf.showPage()",
    "      y = page_height - margin",
    "    y -= line_height // 2",
    "    continue",
    "  wrapped = simpleSplit(line, font_name, font_size, page_width - (margin * 2)) or [' ']",
    "  for segment in wrapped:",
    "    if y <= margin:",
    "      pdf.showPage()",
    "      y = page_height - margin",
    "    pdf.setFont(font_name, font_size)",
    "    pdf.drawString(margin, y, segment)",
    "    y -= line_height",
    "  y -= 4",
    "pdf.save()",
    "manifest = {",
    "  'goal': payload['goal'],",
    "  'objective': payload['objective'],",
    "  'sourceMarkdownPath': str(source_path),",
    "  'outputPdfPath': str(output_path),",
    "  'sourceLength': len(markdown_text)",
    "}",
    "manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')",
    "print(json.dumps({'generated': [str(output_path), str(manifest_path)]}, ensure_ascii=False))"
  ].join("\n");

  return {
    summary: "LLM PDF 导出脚本不可用，已切换到本地 PDF fallback",
    filename: "pdf-export",
    pythonCode,
    expectedArtifacts: ["brief.pdf", "pdf-export.json"],
    fallbackKind: "pdf"
  };
};

const buildDeterministicCodingFallback = (input: AgentRequest): CodingDraft =>
  (isPdfExportRequest(input) ? buildLocalPdfExportDraft(input) : undefined) ??
  buildMockCodingDraft(input);

const buildCodingFallbackReason = (
  error: unknown,
  draft: CodingDraft,
  category: string
): { summary: string; category: string; rawReason: string } => {
  if (category === "json_invalid") {
    return {
      summary:
        draft.fallbackKind === "pdf"
          ? "LLM JSON 无效，已切换到本地 PDF fallback"
          : "LLM JSON 无效，已切换到本地 Python fallback",
      category,
      rawReason: getErrorMessage(error)
    };
  }

  return summarizeLlmFallbackReason(error, draft.fallbackKind === "pdf" ? "pdf" : "coding");
};

const isPythonSyntaxFailure = (response: ToolResponse): boolean => {
  const haystack = [
    response.summary,
    typeof response.output?.stderr === "string" ? response.output.stderr : "",
    typeof response.error?.message === "string" ? response.error.message : ""
  ]
    .join("\n")
    .toLowerCase();
  return (
    haystack.includes("syntaxerror") ||
    haystack.includes("eol while scanning string literal") ||
    haystack.includes("unterminated string") ||
    haystack.includes("indentationerror")
  );
};

const buildSimpleDocumentPlan = (goal: string): Plan => ({
  goal,
  assumptions: ["No external side effects are required", "Return the requested output directly"],
  steps: [
    {
      id: "s1",
      title: "Generate requested output",
      agent: AgentKind.Document,
      objective: "Produce the user-facing text or markdown output directly",
      dependsOn: [],
      inputs: ["goal"],
      expectedOutput: "Requested text output",
      successCriteria: ["Output matches the user's request", "No external side effects occur"]
    }
  ],
  taskSuccessCriteria: ["Produce the requested output directly"]
});

const buildNextPlanStepId = (steps: Plan["steps"]): string => {
  const lastStepId = steps.at(-1)?.id;
  if (!lastStepId) {
    return "s1";
  }

  const match = lastStepId.match(/^([A-Za-z]+)(\d+)$/);
  if (!match) {
    return `s${steps.length + 1}`;
  }

  return `${match[1]}${Number(match[2]) + 1}`;
};

const PDF_EXPORT_STEP_HINT_PATTERN = /(导出|export|排版|render|print|生成.*pdf|输出.*pdf)/i;
const PDF_PREPARATION_HINT_PATTERN =
  /(准备文稿|准备markdown|markdown 摘要|markdown 简报|prepare.*markdown|prepare.*document|for final pdf export)/i;

const isExplicitPdfExportPlanStep = (
  step: {
    title?: string;
    objective?: string;
    expectedOutput?: string;
    successCriteria?: string[];
  }
): boolean => {
  const title = step.title ?? "";
  const objective = step.objective ?? "";
  const expectedOutput = step.expectedOutput ?? "";
  const successCriteria = Array.isArray(step.successCriteria) ? step.successCriteria.join("\n") : "";
  const titleAndOutputText = [title, expectedOutput, successCriteria].join("\n");

  if (hasKeyword(titleAndOutputText, PDF_KEYWORDS)) {
    return true;
  }

  return (
    hasKeyword(objective, PDF_KEYWORDS) &&
    PDF_EXPORT_STEP_HINT_PATTERN.test(objective) &&
    !PDF_PREPARATION_HINT_PATTERN.test(objective)
  );
};

const findLastExplicitPdfExportStepIndex = (steps: Plan["steps"]): number => {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step && isExplicitPdfExportPlanStep(step)) {
      return index;
    }
  }

  return -1;
};

const normalizePdfExportSteps = (goal: string, plan: Plan): Plan => {
  if (!hasKeyword(goal, PDF_KEYWORDS)) {
    return plan;
  }

  const normalizedSteps = plan.steps.map((step) => {
    if (!isExplicitPdfExportPlanStep(step) || step.agent === AgentKind.Coding) {
      return step;
    }

    return {
      ...step,
      agent: AgentKind.Coding,
      objective: "将最终简报文稿排版并导出为可打开的 PDF 文件，确保中文显示正常。",
      expectedOutput: "PDF 文件。",
      successCriteria: [
        "成功生成并可打开 PDF",
        "PDF 保留标题、各章节与时间轴格式",
        "中文字符正常显示，无明显排版错误"
      ]
    };
  });

  return {
    ...plan,
    steps: normalizedSteps
  };
};

const ensurePdfExportStep = (goal: string, plan: Plan): Plan => {
  if (!hasKeyword(goal, PDF_KEYWORDS)) {
    return plan;
  }

  const hasPdfStep = findLastExplicitPdfExportStepIndex(plan.steps) !== -1;
  if (hasPdfStep) {
    return plan;
  }

  const dependencyStep =
    [...plan.steps].reverse().find((step) => step.agent === AgentKind.Document) ??
    plan.steps.at(-1);
  const pdfStepId = buildNextPlanStepId(plan.steps);
  const pdfStep: Plan["steps"][number] = {
    id: pdfStepId,
    title: "导出为PDF",
    agent: AgentKind.Coding,
    objective: "将最终简报文稿排版并导出为可打开的 PDF 文件，确保中文显示正常。",
    dependsOn: dependencyStep ? [dependencyStep.id] : [],
    inputs: dependencyStep ? [`${dependencyStep.id} 最终简报文稿`] : ["goal"],
    expectedOutput: "PDF 文件。",
    successCriteria: [
      "成功生成并可打开 PDF",
      "PDF 保留标题、各章节与时间轴格式",
      "中文字符正常显示，无明显排版错误"
    ]
  };

  return {
    ...plan,
    steps: [...plan.steps, pdfStep],
    taskSuccessCriteria: plan.taskSuccessCriteria.some((criteria) => /pdf/i.test(criteria))
      ? plan.taskSuccessCriteria
      : [...plan.taskSuccessCriteria, "最终输出为可打开的 PDF 文件"]
  };
};

const normalizeDirectExecutionSteps = (goal: string, plan: Plan): Plan => {
  const hasGatheringStep = plan.steps.some((step) =>
    [AgentKind.Research, AgentKind.Browser, AgentKind.Action].includes(step.agent)
  );
  if (hasGatheringStep || plan.steps.length === 0) {
    return plan;
  }

  const normalizedGoal = stripTaskPrefix(goal);
  if (hasKeyword(normalizedGoal, CODING_KEYWORDS) && !plan.steps.some((step) => step.agent === AgentKind.Coding)) {
    const [firstStep, ...restSteps] = plan.steps;
    if (!firstStep) {
      return plan;
    }
    return {
      ...plan,
      steps: [
        {
          ...firstStep,
          agent: AgentKind.Coding,
          title: firstStep.title || "Run local Python analysis"
        },
        ...restSteps
      ]
    };
  }

  if (
    hasKeyword(normalizedGoal, REPORT_KEYWORDS) &&
    !hasKeyword(normalizedGoal, CODING_KEYWORDS) &&
    !plan.steps.some((step) => step.agent === AgentKind.Document)
  ) {
    const [firstStep, ...restSteps] = plan.steps;
    if (!firstStep) {
      return plan;
    }
    return {
      ...plan,
      steps: [
        {
          ...firstStep,
          agent: AgentKind.Document,
          title: firstStep.title || "Generate requested output"
        },
        ...restSteps
      ]
    };
  }

  return plan;
};

const ensureDocumentBeforePdfStep = (goal: string, plan: Plan): Plan => {
  if (!hasKeyword(goal, PDF_KEYWORDS) || !hasKeyword(goal, REPORT_KEYWORDS)) {
    return plan;
  }

  if (plan.steps.some((step) => step.agent === AgentKind.Document)) {
    return plan;
  }

  const pdfStepIndex = findLastExplicitPdfExportStepIndex(plan.steps);
  if (pdfStepIndex === -1) {
    return plan;
  }

  const pdfStep = plan.steps[pdfStepIndex];
  if (!pdfStep) {
    return plan;
  }

  const dependencyStep = [...plan.steps.slice(0, pdfStepIndex)]
    .reverse()
    .find((step) => step.agent !== AgentKind.Action && step.agent !== AgentKind.Document);
  const documentStepId = `${pdfStep.id}_doc`;
  const documentStep: Plan["steps"][number] = {
    id: documentStepId,
    title: "生成 Markdown 摘要",
    agent: AgentKind.Document,
    objective: "基于前序分析结果生成结构化 Markdown 摘要，为最终 PDF 导出准备文稿。",
    dependsOn: dependencyStep ? [dependencyStep.id] : [...pdfStep.dependsOn],
    inputs: dependencyStep ? [`${dependencyStep.id} 结构化结果`] : [...pdfStep.inputs],
    expectedOutput: "Markdown 简报文稿。",
    successCriteria: [
      "生成结构清晰的 Markdown 摘要",
      "包含关键发现或主要内容块",
      "可作为最终 PDF 导出的文稿输入"
    ]
  };

  const normalizedSteps = [...plan.steps];
  normalizedSteps.splice(pdfStepIndex, 0, documentStep);
  normalizedSteps[pdfStepIndex + 1] = {
    ...pdfStep,
    dependsOn: [documentStepId],
    inputs: [`${documentStepId} Markdown 简报文稿`]
  };

  return {
    ...plan,
    steps: normalizedSteps
  };
};

const applyRecipeOverrides = (
  goal: string,
  plan: Plan,
  recipe?: RecipeDefinition
): Plan => {
  if (!recipe) {
    return plan;
  }

  return {
    ...plan,
    steps: plan.steps.map((step) => {
      const taskClass = step.taskClass ?? classifyTaskClass(goal, step);
      const qualityProfile =
        taskClass === recipe.taskClass
          ? {
              ...(recipe.qualityProfileOverrides ?? {}),
              ...(step.qualityProfile ?? {})
            }
          : step.qualityProfile;

      return {
        ...step,
        ...(taskClass ? { taskClass } : {}),
        ...(qualityProfile && Object.keys(qualityProfile).length > 0 ? { qualityProfile } : {})
      };
    })
  };
};

const sanitizePlannedTask = (goal: string, plan: Plan, recipe?: RecipeDefinition): Plan => {
  let sanitizedPlan = normalizePdfExportSteps(goal, plan);

  if (!hasKeyword(goal, SIDE_EFFECT_KEYWORDS)) {
    const hasActionStep = sanitizedPlan.steps.some((step) => step.agent === AgentKind.Action);
    if (hasActionStep) {
      if (sanitizedPlan.steps.length === 1 && sanitizedPlan.steps[0]?.agent === AgentKind.Action) {
        sanitizedPlan = buildSimpleDocumentPlan(goal);
      } else {
        const remainingSteps = sanitizedPlan.steps.filter((step) => step.agent !== AgentKind.Action);
        if (remainingSteps.length === 0) {
          sanitizedPlan = buildSimpleDocumentPlan(goal);
        } else {
          const validStepIds = new Set(remainingSteps.map((step) => step.id));

          sanitizedPlan = {
            ...sanitizedPlan,
            steps: remainingSteps.map((step) => ({
              ...step,
              dependsOn: step.dependsOn.filter((dependency) => validStepIds.has(dependency))
            }))
          };
        }
      }
    }
  }

  sanitizedPlan = applyRecipeOverrides(goal, sanitizedPlan, recipe);
  sanitizedPlan = normalizeDirectExecutionSteps(goal, sanitizedPlan);
  sanitizedPlan = ensurePdfExportStep(goal, sanitizedPlan);
  sanitizedPlan = ensureDocumentBeforePdfStep(goal, sanitizedPlan);

  return {
    ...sanitizedPlan,
    steps: sanitizedPlan.steps.map((step) => {
      const taskClass = step.taskClass ?? classifyTaskClass(goal, step);
      return {
        ...step,
        taskClass,
        qualityProfile: step.qualityProfile ?? buildQualityProfile(taskClass, goal, step),
        attemptStrategy: step.attemptStrategy ?? buildAttemptStrategy(taskClass, step.agent, 0)
      };
    })
  };
};

const buildExecutionQuery = (input: AgentRequest): string => {
  const stepContext = asJsonObject(input.context["currentStep"]);
  const objective = asOptionalString(stepContext["objective"]);
  const title = asOptionalString(stepContext["title"]);
  const normalizedGoal = stripTaskPrefix(input.goal);

  return uniqueStrings(
    [objective, title, normalizedGoal].filter(
      (value): value is string => typeof value === "string" && value.length > 0
    )
  ).join("\n");
};

const buildFocusedResearchQueries = (input: AgentRequest): string[] => {
  const baseQuery = buildExecutionQuery(input);
  const normalizedGoal = stripTaskPrefix(input.goal);
  const lines = normalizedGoal
    .split(/\r?\n|(?<=[:：])|(?<=。)|(?<=；)|(?<=;)/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 12);
  const numberedRequirements = normalizedGoal
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => /^(\d+[\).、]|[-*])/.test(line));

  const candidates = uniqueStrings([
    baseQuery,
    ...numberedRequirements.slice(0, 2).map((item) => `${baseQuery}\n${item}`),
    ...lines.slice(0, 2).map((item) => `${baseQuery}\n${item}`)
  ]).filter((query) => query.length > 0);

  return candidates.slice(0, baseQuery.length > 180 ? 3 : 2);
};

const extractHttpUrls = (text: string): string[] =>
  Array.from(new Set(text.match(/https?:\/\/[^\s)\]]+/gi) ?? []));

const collectBootstrapUrlsFromSearchOutput = (output: unknown, maxUrls = 6): string[] => {
  const candidate = asJsonObject(output);
  return uniqueStrings([
    ...collectSearchResultUrls(candidate["results"], maxUrls),
    ...extractHttpUrls(asOptionalString(candidate["answer"]) ?? "")
  ]).slice(0, maxUrls);
};

const buildBrowserUrlSuggestionPrompt = (input: AgentRequest): string => {
  const stepContext = asJsonObject(input.context["currentStep"]);
  const objective = asOptionalString(stepContext["objective"]);
  const title = asOptionalString(stepContext["title"]);
  const normalizedGoal = stripTaskPrefix(input.goal);

  return [
    "Return 5 to 6 direct HTTPS URLs that are good starting points for browsing this task.",
    "Use authoritative public sources only.",
    "Do not ask clarifying questions.",
    "Return only URLs, one per line, with no bullets or commentary.",
    "",
    JSON.stringify(
      {
        goal: normalizedGoal,
        title,
        objective
      },
      null,
      2
    )
  ].join("\n");
};

const extractBrowserFactSnippets = (text: string, maxItems = 6): string[] =>
  uniqueStrings(
    text
      .split(/\r?\n|(?<=[.!?。！？])\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 24)
      .map((item) => (item.length > 220 ? `${item.slice(0, 217)}...` : item))
  ).slice(0, maxItems);

const buildBrowserFallbackResponse = (params: {
  toolResponse: Awaited<ReturnType<ToolRuntime["execute"]>>;
  selectedUrl: string;
  attemptSummaries: JsonObject[];
  inheritedSources?: Array<{ title: string; url: string; snippet: string; tier: string }>;
  bootstrapSearchSummary?: string;
  fallbackReason: string;
}): AgentResponse => {
  const currentUrl = String(params.toolResponse.output?.currentUrl ?? params.selectedUrl);
  const pageTitle = String(params.toolResponse.output?.pageTitle ?? "");
  const extractedText = String(params.toolResponse.output?.extractedText ?? "");
  const extractedFacts = extractBrowserFactSnippets(extractedText);
  const sources = dedupeSourceEvidence([
    ...(params.inheritedSources ?? []),
    ...(currentUrl
      ? [
          {
            title: pageTitle || "Browser extract",
            url: currentUrl,
            snippet: extractedText,
            tier: classifySourceTier(currentUrl)
          }
        ]
      : [])
  ]);
  const evidencePoints = uniqueStrings(
    [
      pageTitle ? `页面标题：${pageTitle}` : "",
      currentUrl ? `来源页面：${currentUrl}` : "",
      extractedFacts[0] ? `关键信息：${extractedFacts[0]}` : ""
    ].filter(Boolean)
  );

  return {
    status: "success",
    summary: pageTitle
      ? `已从 ${pageTitle} 提取页面内容，并使用规则化摘要继续任务`
      : "已提取页面内容，并使用规则化摘要继续任务",
    structuredData: {
      taskClass: TaskClass.ResearchBrowser,
      currentUrl,
      sourceUrls: [currentUrl],
      sources,
      sourceTiers: sources.map((source) => ({ url: source.url, tier: source.tier })),
      pageTitle,
      evidencePoints,
      extractedFacts,
      timelineEvents: buildTimelineEventsFromSources(
        [{ title: pageTitle, snippet: extractedText, url: currentUrl }],
        4
      ),
      nextQuestions: [],
      extractedText,
      attemptSummaries: params.attemptSummaries,
      synthesisFallbackUsed: true,
      synthesisFallbackReason: params.fallbackReason,
      ...(params.bootstrapSearchSummary
        ? { bootstrapSearchSummary: params.bootstrapSearchSummary }
        : {})
    },
    ...(params.toolResponse.artifacts ? { artifacts: params.toolResponse.artifacts } : {})
  };
};

const buildEvidenceOnlyBrowserFallback = (
  input: AgentRequest,
  attemptSummaries: JsonObject[],
  reason: string
): AgentResponse | undefined => {
  const previousEvidence = Array.isArray(input.context["previousStepEvidence"])
    ? input.context["previousStepEvidence"]
    : [];
  const researchEvidence = previousEvidence.find(
    (item) =>
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>)["taskClass"] === TaskClass.ResearchBrowser
  ) as Record<string, unknown> | undefined;
  if (!researchEvidence) {
    return undefined;
  }

  const findings = Array.isArray(researchEvidence["findings"])
    ? researchEvidence["findings"].map(String).slice(0, 8)
    : [];
  const sources = Array.isArray(researchEvidence["sources"])
    ? researchEvidence["sources"].slice(0, 8)
    : [];
  const timelineEvents = Array.isArray(researchEvidence["timelineEvents"])
    ? researchEvidence["timelineEvents"].slice(0, 8)
    : [];
  if (findings.length === 0 && sources.length === 0) {
    return undefined;
  }

  return {
    status: "success",
    summary: "浏览器抽取受阻，已基于上一阶段研究证据继续任务",
    structuredData: {
      taskClass: TaskClass.ResearchBrowser,
      currentUrl: typeof researchEvidence["topResultUrl"] === "string" ? researchEvidence["topResultUrl"] : "",
      sourceUrls: sources
        .flatMap((item) =>
          item &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>)["url"] === "string"
            ? [String((item as Record<string, unknown>)["url"])]
            : []
        )
        .slice(0, 8),
      sources,
      sourceTiers: sources
        .flatMap((item) => {
          const candidate = asJsonObject(item);
          const url = asOptionalString(candidate["url"]);
          const tier = asOptionalString(candidate["tier"]) ?? (url ? classifySourceTier(url) : undefined);
          return url && tier ? [{ url, tier }] : [];
        })
        .slice(0, 8),
      pageTitle: "Evidence fallback",
      evidencePoints: findings.slice(0, 6),
      extractedFacts: findings,
      timelineEvents,
      nextQuestions: [],
      attemptSummaries,
      synthesisFallbackUsed: true,
      synthesisFallbackReason: reason,
      browserFallbackUsed: true,
      fallbackKind: "evidence_only_browser"
    }
  };
};

const goalRequestsLinks = (goal: string): boolean =>
  hasKeyword(goal, [
    "link",
    "links",
    "url",
    "urls",
    "source",
    "sources",
    "citation",
    "reference",
    "链接",
    "网址",
    "来源",
    "出处"
  ]);

const dedupeSourceEvidence = (
  sources: Array<{ title: string; url: string; snippet: string; tier: string }>
): Array<{ title: string; url: string; snippet: string; tier: string }> => {
  const seen = new Set<string>();
  const deduped: Array<{ title: string; url: string; snippet: string; tier: string }> = [];
  for (const source of sources) {
    if (!source.url || seen.has(source.url)) {
      continue;
    }
    seen.add(source.url);
    deduped.push(source);
  }
  return deduped;
};

const extractInheritedResearchSources = (
  input: AgentRequest
): Array<{ title: string; url: string; snippet: string; tier: string }> => {
  const previousEvidence = Array.isArray(input.context["previousStepEvidence"])
    ? input.context["previousStepEvidence"]
    : [];
  return dedupeSourceEvidence(
    previousEvidence.flatMap((item) => {
      const candidate = asJsonObject(item);
      const sources = Array.isArray(candidate["sources"]) ? candidate["sources"] : [];
      return sources.flatMap((source) => {
        const sourceCandidate = asJsonObject(source);
        const url = asOptionalString(sourceCandidate["url"]);
        if (!url) {
          return [];
        }
        return [
          {
            title: asOptionalString(sourceCandidate["title"]) ?? url,
            url,
            snippet: asOptionalString(sourceCandidate["snippet"]) ?? "",
            tier: asOptionalString(sourceCandidate["tier"]) ?? classifySourceTier(url)
          }
        ];
      });
    })
  );
};

const hasOnlyGenericKeyFindingsSection = (body: string): boolean => {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^model:\s+/i.test(line));
  const headings = lines.filter((line) => /^#{1,6}\s+/.test(line));
  const normalizedHeadings = headings.map((line) =>
    line.replace(/^#{1,6}\s+/, "").trim().toLowerCase()
  );

  return normalizedHeadings.length === 1 && normalizedHeadings[0] === "key findings";
};

const detectDocumentPlaceholderSignals = (goal: string, body: string): string[] => {
  const signals: string[] = [];

  if (body.includes("example.com/mock-competitor")) {
    signals.push("contains mock placeholder URL example.com/mock-competitor");
  }

  if (goalRequestsLinks(goal) && extractHttpUrls(body).length === 0 && hasOnlyGenericKeyFindingsSection(body)) {
    signals.push("contains only a generic Key Findings section without source URLs");
  }

  return signals;
};

const buildDocumentFallbackDraft = (input: AgentRequest): DocumentDraft => {
  const previousEvidence = Array.isArray(input.context["previousStepEvidence"])
    ? input.context["previousStepEvidence"]
    : [];
  const previousSummaries = asStringArray(input.context["previousStepSummaries"]);
  const findings = uniqueStrings(
    previousEvidence.flatMap((item) => {
      const candidate = asJsonObject(item);
      return [
        ...asStringArray(candidate["findings"]),
        ...asStringArray(candidate["extractedFacts"])
      ];
    })
  ).slice(0, 12);
  const sourceUrls = uniqueStrings(
    previousEvidence.flatMap((item) => {
      const candidate = asJsonObject(item);
      const sourceUrls = asStringArray(candidate["sourceUrls"]);
      const sources = Array.isArray(candidate["sources"])
        ? candidate["sources"].flatMap((source) => {
            const sourceCandidate = asJsonObject(source);
            return typeof sourceCandidate["url"] === "string" ? [String(sourceCandidate["url"])] : [];
          })
        : [];
      return [...sourceUrls, ...sources];
    })
  ).slice(0, 10);
  const timelineEvents = previousEvidence.flatMap((item) => {
    const candidate = asJsonObject(item);
    return Array.isArray(candidate["timelineEvents"]) ? candidate["timelineEvents"].slice(0, 6) : [];
  });

  const sections = [
    "## 摘要",
    "",
    ...(findings.length > 0
      ? findings.slice(0, 6).map((finding) => `- ${finding}`)
      : previousSummaries.slice(0, 6).map((summary) => `- ${summary}`)),
    "",
    "## 关键证据",
    "",
    ...(sourceUrls.length > 0 ? sourceUrls.map((url) => `- ${url}`) : ["- 以上游步骤结构化结果为准"]),
    ...(timelineEvents.length > 0
      ? [
          "",
          "## 时间线",
          "",
          ...timelineEvents.map((item) => {
            const candidate = asJsonObject(item);
            return `- ${String(candidate["date"] ?? "")} ${String(candidate["event"] ?? "")}`.trim();
          })
        ]
      : [])
  ];

  return {
    summary: "使用结构化证据生成本地文档 fallback",
    title: stripTaskPrefix(input.goal) || "Task Report",
    markdownBody: sections.join("\n"),
    keySections: timelineEvents.length > 0 ? ["摘要", "关键证据", "时间线"] : ["摘要", "关键证据"],
    usedSources: sourceUrls
  };
};

const buildArtifactValidation = (artifacts: string[], preview?: string, keySections: string[] = []) => {
  const hasArtifact = artifacts.length > 0;
  const pdfArtifact = artifacts.find((artifact) => artifact.toLowerCase().endsWith(".pdf")) ?? null;
  const markdownArtifact =
    artifacts.find((artifact) => artifact.toLowerCase().endsWith(".md")) ?? null;
  return {
    hasArtifact,
    artifactCount: artifacts.length,
    hasReadablePreview: Boolean(preview && preview.trim().length > 0),
    hasSections: keySections.length > 0,
    pdfArtifact,
    markdownArtifact,
    validated: hasArtifact && Boolean(preview && preview.trim().length > 0)
  };
};

const RESEARCH_SYNTHETIC_MARKER_PATTERN = /\bsynthetic\b/i;

const asFindingsArray = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.map((item) => String(item))
      : [];

const detectResearchQualitySignals = (sourceCount: number, findings: unknown): string[] => {
  const signals: string[] = [];

  if (sourceCount === 0) {
    signals.push("sourceCount=0 in live mode");
  }

  if (
    asFindingsArray(findings).some((finding) =>
      RESEARCH_SYNTHETIC_MARKER_PATTERN.test(finding)
    )
  ) {
    signals.push("findings contain synthetic marker");
  }

  return signals;
};

const buildResearchQualityFailure = (
  structuredData: JsonObject,
  qualitySignals: string[],
  upstreamErrorMessage?: string
): AgentResponse => ({
  status: "failed",
  summary: "research quality guardrail failed",
  structuredData: {
    stage: "research_quality_guardrail",
    qualitySignals,
    ...structuredData,
    ...(upstreamErrorMessage ? { upstreamErrorMessage } : {})
  },
  error: {
    code: ErrorCode.Unknown,
    message: `research_quality_guardrail failed: ${qualitySignals.join("; ")}${
      upstreamErrorMessage ? `; upstream=${upstreamErrorMessage}` : ""
    }`,
    retryable: false
  }
});

const extractSentenceLikeSnippets = (text: string, maxItems = 6): string[] =>
  uniqueStrings(
    text
      .split(/\r?\n|(?<=[.!?。！？])\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 18)
      .map((item) => (item.length > 220 ? `${item.slice(0, 217)}...` : item))
  ).slice(0, maxItems);

const buildResearchFallbackResponse = (params: {
  sourceCount: number;
  topResultUrl: string;
  candidateSourceUrls: string[];
  searchAnswer: string;
  results: unknown;
  sources?: Array<{ title: string; url: string; snippet: string; tier: string }>;
  timelineEvents?: Array<{ date: string; event: string; sourceUrl: string }>;
  fallbackReason: string;
}): AgentResponse => {
  const results = Array.isArray(params.results) ? params.results : [];
  const sources = params.sources ?? buildSourceEvidence(results);
  const timelineEvents = params.timelineEvents ?? buildTimelineEventsFromSources(results);
  const findingsFromResults = uniqueStrings(
    results.flatMap((result) => {
      const candidate = asJsonObject(result);
      const title = asOptionalString(candidate["title"]) ?? "";
      const snippet = asOptionalString(candidate["snippet"]) ?? "";
      const url = asOptionalString(candidate["url"]) ?? "";
      const combined = [title, snippet].filter(Boolean).join(" - ");
      if (combined) {
        return [url ? `${combined} (${url})` : combined];
      }
      return url ? [url] : [];
    })
  ).slice(0, 6);
  const findings = findingsFromResults.length > 0
    ? findingsFromResults
    : extractSentenceLikeSnippets(params.searchAnswer, 6);
  const marketSignals = uniqueStrings([
    ...extractSentenceLikeSnippets(params.searchAnswer, 3),
    ...findings.map((finding) => finding.replace(/\s*\(https?:\/\/[^\s)]+\)\s*$/i, ""))
  ]).slice(0, 4);
  const coverageGaps =
    findings.length > 0
      ? []
      : ["需要进一步补充更细化的来源证据后再形成完整分析。"];

  return {
    status: "success",
    summary:
      params.sourceCount > 0
        ? `已基于 ${params.sourceCount} 个搜索来源生成规则化研究摘要并继续任务`
        : "已基于搜索结果生成规则化研究摘要并继续任务",
    structuredData: {
      taskClass: TaskClass.ResearchBrowser,
      sourceCount: params.sourceCount,
      topResultUrl: params.topResultUrl,
      candidateSourceUrls: params.candidateSourceUrls,
      sources,
      sourceTiers: sources.map((source) => ({ url: source.url, tier: source.tier })),
      findings,
      marketSignals,
      coverageGaps,
      timelineEvents,
      synthesisFallbackUsed: true,
      synthesisFallbackReason: params.fallbackReason
    }
  };
};

export class RouterAgent implements RoutingAgent {
  constructor(
    private readonly modelRouter: ModelRouter,
    private readonly llmClient?: OpenAIResponsesClient,
    private readonly mode: AgentExecutionMode = "mock"
  ) {}

  async route(message: string, userProfile?: UserProfile): Promise<RouteDecision> {
    if (hasTaskPrefix(message)) {
      return buildPrefixedTaskRoute(message, this.modelRouter.get("router").model);
    }

    if (this.mode === "live" && this.llmClient?.isConfigured()) {
      try {
        const response = await this.llmClient.generateJson<RouteDecision>({
          stage: "router",
          messages: [
            {
              role: "system",
              content: ROUTER_PROMPT_TEMPLATE
            },
            {
              role: "user",
              content: JSON.stringify(
                {
                  message,
                  userProfile: userProfileSummary(userProfile)
                },
                null,
                2
              )
            }
          ],
          jsonSchema: {
            name: "route_decision",
            schema: ROUTE_DECISION_SCHEMA
          },
          maxOutputTokens: 500
        });
        return response.data;
      } catch {
        return this.mockRoute(message);
      }
    }

    return this.mockRoute(message);
  }

  private mockRoute(message: string): RouteDecision {
    const isTask = hasKeyword(message, [
      "调研",
      "研究",
      "report",
      "ppt",
      "deck",
      "分析",
      "generate",
      "build",
      "通知",
      "发送",
      "webhook",
      "slack",
      "email"
    ]);

    return {
      route: isTask ? "multi_step" : "chat",
      intent: isTask ? "task_execution" : "chat_response",
      reason: `Classified by ${this.modelRouter.get("router").model}`,
      confidence: isTask ? 0.9 : 0.7,
      missingInfo: [],
      riskFlags: []
    };
  }
}

export class PlannerAgent implements PlanningAgent {
  constructor(
    private readonly modelRouter: ModelRouter,
    private readonly llmClient?: OpenAIResponsesClient,
    private readonly mode: AgentExecutionMode = "mock"
  ) {}

  async createPlan(goal: string, context: JsonObject): Promise<Plan> {
    const explicitRecipeId = asOptionalString(context["recipeId"]);
    const recipe = getRecipeById(explicitRecipeId) ?? matchRecipeForGoal(goal);
    const recipeContext = recipe
      ? buildRecipePlanningContext(recipe.id)
      : {};
    if (this.mode === "live" && this.llmClient?.isConfigured()) {
      try {
        const response = await this.llmClient.generateJson<Plan>({
          stage: "planner",
          messages: [
            {
              role: "system",
              content: PLANNER_PROMPT_TEMPLATE
            },
            {
              role: "user",
              content: JSON.stringify(
                {
                  goal,
                  context: {
                    ...context,
                    ...recipeContext
                  },
                  allowedAgents: AGENT_KIND_VALUES
                },
                null,
                2
              )
            }
          ],
          jsonSchema: {
            name: "task_plan",
            schema: PLAN_SCHEMA
          },
          maxOutputTokens: 1_500
        });

        return sanitizePlannedTask(goal, {
          ...response.data,
          steps: response.data.steps.map((step) => ({
            ...step,
            agent: coerceAgentKind(step.agent)
          }))
        }, recipe);
      } catch {
        return this.mockPlan(goal, recipe);
      }
    }

    return this.mockPlan(goal, recipe);
  }

  private mockPlan(goal: string, recipe?: RecipeDefinition): Plan {
    const normalizedGoal = stripTaskPrefix(goal);
    const includesCoding = hasKeyword(normalizedGoal, CODING_KEYWORDS);
    const includesResearch = hasKeyword(normalizedGoal, [
      "调研",
      "研究",
      "research",
      "市场",
      "竞品",
      "对比",
      "分析行业",
      "news",
      "战情"
    ]);
    const includesBrowser = hasKeyword(normalizedGoal, [
      "网站",
      "官网",
      "网页",
      "web",
      "browser",
      "核验",
      "核实",
      "来源",
      "链接",
      "source",
      "citation",
      "reference"
    ]);
    const includesDeck = hasKeyword(normalizedGoal, ["ppt", "deck", "slides"]);
    const needsDocument =
      !includesCoding || includesDeck || hasKeyword(normalizedGoal, REPORT_KEYWORDS);
    const includesAction = hasKeyword(normalizedGoal, [
      "通知",
      "发送",
      "webhook",
      "slack",
      "email",
      "邮件"
    ]);
    const documentTitle = includesDeck ? "Generate report and deck outline" : "Generate report";
    const steps: Plan["steps"] = [];
    const initialStepId = "s1";

    steps.push({
      id: initialStepId,
      title: includesCoding && !includesResearch ? "Run local Python analysis" : "Research source-backed information",
      agent: includesCoding && !includesResearch ? AgentKind.Coding : AgentKind.Research,
      objective:
        includesCoding && !includesResearch
          ? `Use Python in the local sandbox to produce structured results for: ${normalizedGoal}`
          : `Collect source-backed information needed to complete: ${normalizedGoal}`,
      dependsOn: [],
      inputs: ["goal"],
      expectedOutput:
        includesCoding && !includesResearch
          ? "Python script execution summary and generated artifacts"
          : "Research summary and source shortlist",
      successCriteria:
        includesCoding && !includesResearch
          ? ["A Python artifact exists", "The sandbox produced at least one useful output file"]
          : ["At least one relevant source found", "A concise research summary exists"]
    });

    if (includesBrowser) {
      steps.push({
        id: "s2",
        title: "Inspect source evidence",
        agent: AgentKind.Browser,
        objective: `Inspect candidate web pages and extract supporting evidence for: ${normalizedGoal}`,
        dependsOn: [initialStepId],
        inputs: ["research summary"],
        expectedOutput: "Structured browser notes",
        successCriteria: ["A page was extracted", "Useful evidence was captured"]
      });
    }

    if (includesCoding && includesResearch) {
      const dependsOn = includesBrowser ? ["s1", "s2"] : ["s1"];
      steps.push({
        id: includesBrowser ? "s3" : "s2",
        title: "Run local Python analysis",
        agent: AgentKind.Coding,
        objective: `Use Python in the local sandbox to transform or analyze materials for: ${normalizedGoal}`,
        dependsOn,
        inputs: ["research findings", "browser evidence if present"],
        expectedOutput: "Python script execution summary and generated artifacts",
        successCriteria: ["A Python artifact exists", "The sandbox produced at least one useful output file"]
      });
    }

    if (needsDocument) {
      const documentDependsOn = steps.map((step) => step.id).filter((stepId) => stepId !== "s4");
      const documentStepId = `s${steps.length + 1}`;
      steps.push({
        id: documentStepId,
        title: documentTitle,
        agent: AgentKind.Document,
        objective: `Produce the requested user-facing output for: ${normalizedGoal}`,
        dependsOn: documentDependsOn,
        inputs: ["research findings", "browser evidence if present", "coding output if present"],
        expectedOutput: "Markdown report",
        successCriteria: ["A markdown artifact exists", "The report includes key findings"]
      });
    }

    if (includesAction) {
      const lastStepId = steps.at(-1)?.id ?? initialStepId;
      steps.push({
        id: `s${steps.length + 1}`,
        title: "Execute approved external action",
        agent: AgentKind.Action,
        objective: "Send an external notification only after explicit approval",
        dependsOn: [lastStepId],
        inputs: ["report summary", "final artifact"],
        expectedOutput: "External action execution result",
        successCriteria: [
          "An approval request was created or already exists",
          "The external action executes successfully after approval"
        ]
      });
    }

    return sanitizePlannedTask(goal, {
      goal,
      assumptions: ["Public information only", "Chinese output by default"],
      steps,
      taskSuccessCriteria: ["Task completes without manual intervention", "At least one final artifact exists"]
    }, recipe);
  }
}

export class ReplannerAgent implements ReplanningAgent {
  constructor(
    private readonly modelRouter: ModelRouter,
    private readonly llmClient?: OpenAIResponsesClient,
    private readonly mode: AgentExecutionMode = "mock"
  ) {}

  async repairPlan(task: Task, failedStep: TaskStep, context: JsonObject): Promise<Plan> {
    const completedSteps = task.steps.filter((step) => step.status === StepStatus.Completed);
    const recipe = getRecipeById(task.recipeId) ?? matchRecipeForGoal(task.goal);
    const completedIds = new Set(completedSteps.map((step) => step.id));

    if (this.mode === "live" && this.llmClient?.isConfigured()) {
      try {
        const response = await this.llmClient.generateJson<Plan>({
          stage: "replanner",
          messages: [
            {
              role: "system",
              content: REPLANNER_PROMPT_TEMPLATE
            },
            {
              role: "user",
              content: JSON.stringify(
                {
                  goal: task.goal,
                  failedStep: {
                    id: failedStep.id,
                    title: failedStep.title,
                    agent: failedStep.agent,
                    objective: failedStep.objective,
                    summary: failedStep.summary,
                    error: failedStep.error ?? null
                  },
                  completedSteps: completedSteps.map((step) => ({
                    id: step.id,
                    title: step.title,
                    agent: step.agent,
                    taskClass: step.taskClass ?? null,
                    summary: step.summary ?? null,
                    outputArtifacts: step.outputArtifacts
                  })),
                  currentPlan: task.plan,
                  context,
                  recipe: recipe ? buildRecipePlanningContext(recipe.id)["recipe"] : null
                },
                null,
                2
              )
            }
          ],
          jsonSchema: {
            name: "replanned_task",
            schema: PLAN_SCHEMA
          },
          maxOutputTokens: 1_500,
          timeoutMs: this.modelRouter.getRequestTimeoutMs("planner", TaskClass.ResearchBrowser)
        });

        const sanitized = sanitizePlannedTask(
          task.goal,
          {
            ...response.data,
            steps: response.data.steps.map((step) => ({
              ...step,
              agent: coerceAgentKind(step.agent)
            }))
          },
          recipe
        );
        return {
          ...sanitized,
          steps: sanitized.steps.filter((step) => !completedIds.has(step.id))
        };
      } catch {
        // fall through
      }
    }

    const originalSteps = task.plan.steps;
    const failedIndex = originalSteps.findIndex((step) => step.id === failedStep.id);
    const suffixSteps = originalSteps.slice(Math.max(0, failedIndex));
    const repairedSteps = suffixSteps.map((step, index) => ({
      ...step,
      id: `${failedStep.id}r${index + 1}`,
      dependsOn: index === 0
        ? completedSteps.map((completed) => completed.id).slice(-2)
        : [`${failedStep.id}r${index}`]
    }));
    const fallbackPlan: Plan = {
      goal: task.goal,
      assumptions: [
        ...task.plan.assumptions,
        `Replanned after ${failedStep.id} failed`
      ],
      steps: repairedSteps,
      taskSuccessCriteria: task.plan.taskSuccessCriteria
    };
    return sanitizePlannedTask(task.goal, fallbackPlan, recipe);
  }
}

export class ResearchAgent implements StepAgent {
  readonly kind = AgentKind.Research;

  constructor(
    private readonly toolRuntime: ToolRuntime,
    private readonly modelRouter: ModelRouter,
    private readonly llmClient?: OpenAIResponsesClient,
    private readonly mode: AgentExecutionMode = "mock"
  ) {}

  async execute(input: AgentRequest): Promise<AgentResponse> {
    const searchQueries =
      this.mode === "live" ? buildFocusedResearchQueries(input) : [buildExecutionQuery(input)];
    const searchResponses = await Promise.all(
      searchQueries.map((query, index) =>
        this.toolRuntime.execute({
          taskId: input.taskId,
          stepId: input.stepId ?? "unknown-step",
          toolName: ToolName.Search,
          action: "search_web",
          input: {
            query,
            subqueryIndex: index + 1,
            totalSubqueries: searchQueries.length
          },
          callerAgent: this.kind
        })
      )
    );
    const successfulSearchResponses = searchResponses.filter(
      (response) => response.status === "success"
    );
    const toolResponse =
      successfulSearchResponses[0] ??
      searchResponses.at(0) ?? {
        status: "failed" as const,
        summary: "research search failed",
        output: {},
        error: {
          code: ErrorCode.NetworkError,
          message: "research search failed",
          retryable: true
        }
      };

    const mergedResults = uniqueStrings(
      searchResponses.flatMap((response) => {
        const results = Array.isArray(response.output?.results) ? response.output.results : [];
        return results.map((result) => JSON.stringify(result));
      })
    ).map((serialized) => JSON.parse(serialized) as JsonObject);
    const firstResult = mergedResults[0];
    const topResultUrl = typeof firstResult?.url === "string" ? firstResult.url : "";
    const candidateSourceUrls = collectSearchResultUrls(mergedResults);
    const sources = buildSourceEvidence(mergedResults);
    const timelineEvents = buildTimelineEventsFromSources(mergedResults);
    const sourceCount = sources.length;
    const sourceTiers = sources.map((source) => ({ url: source.url, tier: source.tier }));
    const searchAnswer = uniqueStrings(
      searchResponses.flatMap((response) => {
        const answer = typeof response.output?.answer === "string" ? response.output.answer : "";
        return answer ? [answer] : [];
      })
    ).join("\n\n");
    const searchSummary = uniqueStrings(searchResponses.map((response) => response.summary).filter(Boolean)).join(
      " | "
    );
    const researchPayload: JsonObject = {
      goal: input.goal,
      currentStep: asJsonObject(input.context["currentStep"]),
      previousStepSummaries: asStringArray(input.context["previousStepSummaries"]),
      taskMemorySummaries: asStringArray(input.context["taskMemorySummaries"]),
      uploadedArtifactSummaries: Array.isArray(input.context["uploadedArtifactSummaries"])
        ? input.context["uploadedArtifactSummaries"]
        : [],
      previousStepEvidence: Array.isArray(input.context["previousStepEvidence"])
        ? input.context["previousStepEvidence"]
        : [],
      searchQueries,
      searchSummary,
      searchAnswer,
      results: mergedResults,
      sources,
      timelineEvents
    };

    if (toolResponse.status === "success" && canUseLiveLlm(this.mode, this.llmClient)) {
      try {
        const synthesis = await this.llmClient.generateJson<ResearchSynthesis>({
          stage: "research",
          messages: [
            {
              role: "system",
              content: RESEARCH_PROMPT_TEMPLATE
            },
            {
              role: "user",
              content: JSON.stringify(researchPayload, null, 2)
            }
          ],
          jsonSchema: {
            name: "research_synthesis",
            schema: RESEARCH_SYNTHESIS_SCHEMA
          },
          maxOutputTokens: 1_200,
          timeoutMs: this.modelRouter.getRequestTimeoutMs("research", TaskClass.ResearchBrowser)
        });
        const normalizedSynthesis = validateResearchSynthesis(synthesis.data as unknown);

        const structuredData: JsonObject = {
          taskClass: TaskClass.ResearchBrowser,
          qualityProfile: asJsonObject(asJsonObject(input.context["currentStep"])["qualityProfile"]),
          sourceCount,
          topResultUrl: normalizedSynthesis.topResultUrl || topResultUrl,
          candidateSourceUrls,
          sources,
          sourceTiers,
          findings: normalizedSynthesis.findings,
          marketSignals: normalizedSynthesis.marketSignals,
          coverageGaps: normalizedSynthesis.coverageGaps,
          timelineEvents:
            normalizedSynthesis.timelineEvents.length > 0
              ? normalizedSynthesis.timelineEvents
              : timelineEvents
        };
        const qualitySignals = detectResearchQualitySignals(sourceCount, normalizedSynthesis.findings);
        if (qualitySignals.length > 0) {
          return buildResearchQualityFailure(structuredData, qualitySignals);
        }

        return {
          status: "success",
          summary: normalizedSynthesis.summary,
          structuredData
        };
      } catch (error) {
        if (isParseOrSchemaError(error)) {
          try {
            const recoveredSynthesis = await recoverResearchSynthesis(
              this.llmClient,
              researchPayload,
              error
            );

            const structuredData: JsonObject = {
              sourceCount,
              topResultUrl: recoveredSynthesis.topResultUrl || topResultUrl,
              candidateSourceUrls,
              sources,
              sourceTiers,
              findings: recoveredSynthesis.findings,
              marketSignals: recoveredSynthesis.marketSignals,
              coverageGaps: recoveredSynthesis.coverageGaps,
              timelineEvents:
                recoveredSynthesis.timelineEvents.length > 0
                  ? recoveredSynthesis.timelineEvents
                  : timelineEvents
            };
            const qualitySignals = detectResearchQualitySignals(
              sourceCount,
              recoveredSynthesis.findings
            );
            if (qualitySignals.length > 0) {
              return buildResearchQualityFailure(structuredData, qualitySignals);
            }

            return {
              status: "success",
              summary: recoveredSynthesis.summary,
              structuredData
            };
          } catch (recoveryError) {
            const fallbackResponse = buildResearchFallbackResponse({
              sourceCount,
              topResultUrl,
              candidateSourceUrls,
              searchAnswer,
              results: mergedResults,
              sources,
              timelineEvents,
              fallbackReason: `research_json_recovery_failed: ${getErrorMessage(recoveryError)}`
            });
            const fallbackFindings = asFindingsArray(fallbackResponse.structuredData?.findings);
            const qualitySignals = detectResearchQualitySignals(sourceCount, fallbackFindings);
            if (fallbackFindings.length > 0 && qualitySignals.length === 0) {
              return fallbackResponse;
            }

            return buildResearchRecoveryFailure(error, recoveryError, {
              sourceCount,
              topResultUrl,
              candidateSourceUrls
            });
          }
        }

        return buildLiveSynthesisFailure("research", error, {
          sourceCount,
          topResultUrl,
          candidateSourceUrls,
          sources,
          timelineEvents
        });
      }
    }

    if (this.mode === "live" && toolResponse.status !== "success") {
      return {
        status: "failed",
        summary: toolResponse.summary || "research search failed",
        structuredData: {
          stage: "research_search",
          sourceCount,
          topResultUrl,
          candidateSourceUrls,
          sources,
          sourceTiers,
          timelineEvents
        },
        ...(toolResponse.error
          ? { error: toolResponse.error }
          : {
              error: {
                code: ErrorCode.NetworkError,
                message: toolResponse.summary || "research search failed",
                retryable: true
              }
            })
      };
    }

    const findings =
      typeof toolResponse.output?.answer === "string"
        ? toolResponse.output.answer
        : "Synthetic findings: premium EV rental, airport delivery, and monthly subscriptions matter.";
    const structuredData: JsonObject = {
      taskClass: TaskClass.ResearchBrowser,
      sourceCount,
      topResultUrl,
      candidateSourceUrls,
      sources,
      sourceTiers,
      findings,
      timelineEvents
    };

    if (this.mode === "live") {
      const qualitySignals = detectResearchQualitySignals(sourceCount, findings);
      if (qualitySignals.length > 0) {
        return buildResearchQualityFailure(
          structuredData,
          qualitySignals,
          toolResponse.error?.message
        );
      }
    }

    return {
      status: toolResponse.status === "success" ? "success" : "failed",
      summary:
        toolResponse.status === "success"
          ? `Research complete using ${this.modelRouter.get("research").model}`
          : toolResponse.summary || `Research failed using ${this.modelRouter.get("research").model}`,
      structuredData,
      ...(toolResponse.error ? { error: toolResponse.error } : {})
    };
  }
}

export class BrowserAgent implements StepAgent {
  readonly kind = AgentKind.Browser;

  constructor(
    private readonly toolRuntime: ToolRuntime,
    private readonly modelRouter: ModelRouter,
    private readonly llmClient?: OpenAIResponsesClient,
    private readonly mode: AgentExecutionMode = "mock"
  ) {}

  async execute(input: AgentRequest): Promise<AgentResponse> {
    const inheritedSources = extractInheritedResearchSources(input);
    let candidateUrls = getBrowserCandidateUrls(input.context);
    let bootstrapSearchSummary: string | undefined;

    if (candidateUrls.length === 0) {
      const searchBootstrap = await this.toolRuntime.execute({
        taskId: input.taskId,
        stepId: input.stepId ?? "unknown-step",
        toolName: ToolName.Search,
        action: "search_web",
        input: {
          query: buildExecutionQuery(input)
        },
        callerAgent: this.kind
      });

      if (searchBootstrap.status === "success") {
        candidateUrls = collectBootstrapUrlsFromSearchOutput(searchBootstrap.output);
        bootstrapSearchSummary = searchBootstrap.summary;

        if (candidateUrls.length === 0 && canUseLiveLlm(this.mode, this.llmClient)) {
          try {
            const suggestion = await this.llmClient.generateText({
              stage: "browser",
              messages: [
                {
                  role: "user",
                  content: buildBrowserUrlSuggestionPrompt(input)
                }
              ],
              maxOutputTokens: 600,
              timeoutMs: this.modelRouter.getRequestTimeoutMs("browser", TaskClass.ResearchBrowser)
            });
            const suggestedUrls = extractHttpUrls(suggestion.outputText);
            if (suggestedUrls.length > 0) {
              candidateUrls = uniqueStrings(suggestedUrls).slice(0, 6);
              bootstrapSearchSummary = bootstrapSearchSummary
                ? `${bootstrapSearchSummary}; llm_url_fallback`
                : "Generated browser candidate URLs via LLM fallback";
            }
          } catch {
            // Ignore URL suggestion failures and fall through to the existing guardrail.
          }
        }
      } else if (this.mode !== "mock") {
        return {
          status: "failed",
          summary: "Browser extraction could not bootstrap candidate URLs",
          structuredData: {},
          error: {
            code: searchBootstrap.error?.code ?? ErrorCode.NetworkError,
            message:
              searchBootstrap.error?.message ?? "Browser agent could not search for candidate URLs",
            retryable: searchBootstrap.error?.retryable ?? true
          }
        };
      }
    }

    const fallbackUrl = this.mode === "mock" ? "https://example.com/mock-competitor" : "";
    if (candidateUrls.length === 0 && fallbackUrl) {
      candidateUrls = [fallbackUrl];
    }

    if (candidateUrls.length === 0) {
      const evidenceFallback = buildEvidenceOnlyBrowserFallback(
        input,
        [],
        "no_candidate_urls"
      );
      if (evidenceFallback) {
        return evidenceFallback;
      }
      return {
        status: "failed",
        summary: "Browser extraction has no candidate URLs to inspect",
        structuredData: {},
        error: {
          code: ErrorCode.InvalidInput,
          message: "Provide browserCandidateUrls/topResultUrl or allow search bootstrap to return sources",
          retryable: false
        }
      };
    }

    const attemptSummaries: JsonObject[] = [];
    let toolResponse = undefined as Awaited<ReturnType<ToolRuntime["execute"]>> | undefined;
    let selectedUrl = candidateUrls[0] ?? fallbackUrl;
    let selectedBlockedReason: string | undefined;
    let selectedNonSubstantiveReason: string | undefined;

    for (let index = 0; index < candidateUrls.length; index += 1) {
      const candidateUrl = candidateUrls[index] ?? fallbackUrl;
      const attemptResponse = await this.toolRuntime.execute({
        taskId: input.taskId,
        stepId: input.stepId ?? "unknown-step",
        toolName: ToolName.Browser,
        action: "extract",
        input: {
          url: candidateUrl,
          artifactSuffix: `attempt-${index + 1}`
        },
        callerAgent: this.kind
      });

      const pageTitle = String(attemptResponse.output?.pageTitle ?? "");
      const extractedText = String(attemptResponse.output?.extractedText ?? "");
      const currentUrl = String(attemptResponse.output?.currentUrl ?? candidateUrl);
      const blockedReason =
        attemptResponse.status === "success"
          ? detectBlockedPageReason(pageTitle, extractedText, currentUrl)
          : undefined;
      const nonSubstantiveReason =
        attemptResponse.status === "success" && !blockedReason
          ? detectNonSubstantivePageReason(pageTitle, extractedText, currentUrl)
          : undefined;

      attemptSummaries.push({
        url: candidateUrl,
        status: attemptResponse.status,
        pageTitle,
        currentUrl,
        ...(blockedReason ? { blockedReason } : {}),
        ...(nonSubstantiveReason ? { nonSubstantiveReason } : {}),
        ...(attemptResponse.error ? { error: attemptResponse.error.message } : {})
      });

      if (attemptResponse.status !== "success") {
        toolResponse = attemptResponse;
        selectedUrl = candidateUrl;
        continue;
      }

      if (blockedReason) {
        toolResponse = attemptResponse;
        selectedUrl = candidateUrl;
        selectedBlockedReason = blockedReason;
        continue;
      }

      if (nonSubstantiveReason) {
        toolResponse = attemptResponse;
        selectedUrl = candidateUrl;
        selectedNonSubstantiveReason = nonSubstantiveReason;
        continue;
      }

      toolResponse = attemptResponse;
      selectedUrl = candidateUrl;
      selectedBlockedReason = undefined;
      selectedNonSubstantiveReason = undefined;
      break;
    }

    if (!toolResponse) {
      return {
        status: "failed",
        summary: `Browser extraction failed using ${this.modelRouter.get("browser").model}`,
        structuredData: {
          attemptSummaries,
          candidateUrls,
          ...(bootstrapSearchSummary ? { bootstrapSearchSummary } : {})
        },
        error: {
          code: ErrorCode.ToolUnavailable,
          message: "Browser agent could not start any extraction attempt",
          retryable: false
        }
      };
    }

    if (selectedBlockedReason || selectedNonSubstantiveReason) {
      const evidenceFallback = buildEvidenceOnlyBrowserFallback(
        input,
        attemptSummaries,
        selectedBlockedReason ?? selectedNonSubstantiveReason ?? "browser evidence unavailable"
      );
      if (evidenceFallback) {
        return evidenceFallback;
      }
      return {
        status: "failed",
        summary: "Browser extraction only found blocked or low-substance pages",
        structuredData: {
          attemptSummaries,
          candidateUrls,
          ...(selectedBlockedReason ? { blockedReason: selectedBlockedReason } : {}),
          ...(selectedNonSubstantiveReason
            ? { nonSubstantiveReason: selectedNonSubstantiveReason }
            : {}),
          ...(bootstrapSearchSummary ? { bootstrapSearchSummary } : {})
        },
        ...(toolResponse.artifacts ? { artifacts: toolResponse.artifacts } : {}),
        error: {
          code: ErrorCode.ToolUnavailable,
          message:
            selectedBlockedReason ??
            selectedNonSubstantiveReason ??
            "Browser extraction could not find a substantive page",
          retryable: false
        }
      };
    }

    if (toolResponse.status === "success" && canUseLiveLlm(this.mode, this.llmClient)) {
      const browserPayload: JsonObject = {
        goal: input.goal,
        browserSummary: toolResponse.summary,
        currentUrl: toolResponse.output?.currentUrl ?? selectedUrl,
        pageTitle: toolResponse.output?.pageTitle ?? "",
        extractedText: toolResponse.output?.extractedText ?? "",
        attempts: attemptSummaries
      };

      try {
        const synthesis = await this.llmClient.generateJson<BrowserSynthesis>({
          stage: "browser",
          messages: [
            {
              role: "system",
              content: BROWSER_PROMPT_TEMPLATE
            },
            {
              role: "user",
              content: JSON.stringify(browserPayload, null, 2)
            }
          ],
          jsonSchema: {
            name: "browser_synthesis",
            schema: BROWSER_SYNTHESIS_SCHEMA
          },
          maxOutputTokens: 1_000,
          timeoutMs: this.modelRouter.getRequestTimeoutMs("browser", TaskClass.ResearchBrowser)
        });

        return {
          status: "success",
          summary: synthesis.data.summary,
          structuredData: {
            taskClass: TaskClass.ResearchBrowser,
            currentUrl:
              synthesis.data.currentUrl || String(toolResponse.output?.currentUrl ?? selectedUrl),
            pageTitle: synthesis.data.pageTitle || String(toolResponse.output?.pageTitle ?? ""),
            sourceUrls: uniqueStrings(
              dedupeSourceEvidence([
                ...inheritedSources,
                {
                  title:
                    synthesis.data.pageTitle || String(toolResponse.output?.pageTitle ?? ""),
                  url:
                    synthesis.data.currentUrl ||
                    String(toolResponse.output?.currentUrl ?? selectedUrl),
                  snippet: `${synthesis.data.summary}\n${synthesis.data.extractedFacts.join(" ")}`,
                  tier: classifySourceTier(
                    synthesis.data.currentUrl ||
                      String(toolResponse.output?.currentUrl ?? selectedUrl)
                  )
                }
              ]).map((source) => source.url)
            ),
            sources: dedupeSourceEvidence([
              ...inheritedSources,
              {
                title: synthesis.data.pageTitle || String(toolResponse.output?.pageTitle ?? ""),
                url:
                  synthesis.data.currentUrl ||
                  String(toolResponse.output?.currentUrl ?? selectedUrl),
                snippet: `${synthesis.data.summary}\n${synthesis.data.extractedFacts.join(" ")}`,
                tier: classifySourceTier(
                  synthesis.data.currentUrl ||
                    String(toolResponse.output?.currentUrl ?? selectedUrl)
                )
              }
            ]),
            sourceTiers: dedupeSourceEvidence([
              ...inheritedSources,
              {
                title: synthesis.data.pageTitle || String(toolResponse.output?.pageTitle ?? ""),
                url:
                  synthesis.data.currentUrl ||
                  String(toolResponse.output?.currentUrl ?? selectedUrl),
                snippet: `${synthesis.data.summary}\n${synthesis.data.extractedFacts.join(" ")}`,
                tier: classifySourceTier(
                  synthesis.data.currentUrl ||
                    String(toolResponse.output?.currentUrl ?? selectedUrl)
                )
              }
            ]).map((source) => ({ url: source.url, tier: source.tier })),
            evidencePoints: synthesis.data.evidencePoints,
            extractedFacts: synthesis.data.extractedFacts,
            timelineEvents: buildTimelineEventsFromSources(
              [
                {
                  title: synthesis.data.pageTitle,
                  snippet: `${synthesis.data.summary}\n${synthesis.data.extractedFacts.join(" ")}`,
                  url:
                    synthesis.data.currentUrl ||
                    String(toolResponse.output?.currentUrl ?? selectedUrl)
                }
              ],
              4
            ),
            nextQuestions: synthesis.data.nextQuestions,
            extractedText: String(toolResponse.output?.extractedText ?? ""),
            attemptSummaries,
            ...(bootstrapSearchSummary ? { bootstrapSearchSummary } : {})
          },
          ...(toolResponse.artifacts ? { artifacts: toolResponse.artifacts } : {})
        };
      } catch (error) {
        if (isParseOrSchemaError(error)) {
          try {
            const recoveredSynthesis = await recoverBrowserSynthesis(
              this.llmClient,
              browserPayload,
              error
            );

            return {
              status: "success",
              summary: recoveredSynthesis.summary,
              structuredData: {
                taskClass: TaskClass.ResearchBrowser,
                currentUrl:
                  recoveredSynthesis.currentUrl ||
                  String(toolResponse.output?.currentUrl ?? selectedUrl),
                pageTitle:
                  recoveredSynthesis.pageTitle || String(toolResponse.output?.pageTitle ?? ""),
                sourceUrls: uniqueStrings(
                  dedupeSourceEvidence([
                    ...inheritedSources,
                    {
                      title:
                        recoveredSynthesis.pageTitle ||
                        String(toolResponse.output?.pageTitle ?? ""),
                      url:
                        recoveredSynthesis.currentUrl ||
                        String(toolResponse.output?.currentUrl ?? selectedUrl),
                      snippet: `${recoveredSynthesis.summary}\n${recoveredSynthesis.extractedFacts.join(" ")}`,
                      tier: classifySourceTier(
                        recoveredSynthesis.currentUrl ||
                          String(toolResponse.output?.currentUrl ?? selectedUrl)
                      )
                    }
                  ]).map((source) => source.url)
                ),
                sources: dedupeSourceEvidence([
                  ...inheritedSources,
                  {
                    title:
                      recoveredSynthesis.pageTitle ||
                      String(toolResponse.output?.pageTitle ?? ""),
                    url:
                      recoveredSynthesis.currentUrl ||
                      String(toolResponse.output?.currentUrl ?? selectedUrl),
                    snippet: `${recoveredSynthesis.summary}\n${recoveredSynthesis.extractedFacts.join(" ")}`,
                    tier: classifySourceTier(
                      recoveredSynthesis.currentUrl ||
                        String(toolResponse.output?.currentUrl ?? selectedUrl)
                    )
                  }
                ]),
                sourceTiers: dedupeSourceEvidence([
                  ...inheritedSources,
                  {
                    title:
                      recoveredSynthesis.pageTitle ||
                      String(toolResponse.output?.pageTitle ?? ""),
                    url:
                      recoveredSynthesis.currentUrl ||
                      String(toolResponse.output?.currentUrl ?? selectedUrl),
                    snippet: `${recoveredSynthesis.summary}\n${recoveredSynthesis.extractedFacts.join(" ")}`,
                    tier: classifySourceTier(
                      recoveredSynthesis.currentUrl ||
                        String(toolResponse.output?.currentUrl ?? selectedUrl)
                    )
                  }
                ]).map((source) => ({ url: source.url, tier: source.tier })),
                evidencePoints: recoveredSynthesis.evidencePoints,
                extractedFacts: recoveredSynthesis.extractedFacts,
                timelineEvents: buildTimelineEventsFromSources(
                  [
                    {
                      title:
                        recoveredSynthesis.pageTitle ||
                        String(toolResponse.output?.pageTitle ?? ""),
                      snippet: `${recoveredSynthesis.summary}\n${recoveredSynthesis.extractedFacts.join(" ")}`,
                      url:
                        recoveredSynthesis.currentUrl ||
                        String(toolResponse.output?.currentUrl ?? selectedUrl)
                    }
                  ],
                  4
                ),
                nextQuestions: recoveredSynthesis.nextQuestions,
                extractedText: String(toolResponse.output?.extractedText ?? ""),
                attemptSummaries,
                ...(bootstrapSearchSummary ? { bootstrapSearchSummary } : {})
              },
              ...(toolResponse.artifacts ? { artifacts: toolResponse.artifacts } : {})
            };
          } catch (recoveryError) {
            return buildBrowserFallbackResponse({
              toolResponse,
              selectedUrl,
              attemptSummaries,
              inheritedSources,
              ...(bootstrapSearchSummary ? { bootstrapSearchSummary } : {}),
              fallbackReason: `browser_json_recovery_failed: ${getErrorMessage(error)}; ${getErrorMessage(recoveryError)}`
            });
          }
        }

        return buildBrowserFallbackResponse({
          toolResponse,
          selectedUrl,
          attemptSummaries,
          inheritedSources,
          ...(bootstrapSearchSummary ? { bootstrapSearchSummary } : {}),
          fallbackReason: `browser_synthesis_failed: ${getErrorMessage(error)}`
        });
      }
    }

    const currentUrl = String(toolResponse.output?.currentUrl ?? selectedUrl);
    const pageTitle = String(toolResponse.output?.pageTitle ?? "");
    const extractedText = String(toolResponse.output?.extractedText ?? "");
    const extractedFacts = extractBrowserFactSnippets(extractedText);
    const browserSources = dedupeSourceEvidence([
      ...inheritedSources,
      ...(currentUrl
        ? [
            {
              title: pageTitle || "Browser extract",
              url: currentUrl,
              snippet: extractedText,
              tier: classifySourceTier(currentUrl)
            }
          ]
        : [])
    ]);

    return {
      status: toolResponse.status === "success" ? "success" : "failed",
      summary: `Browser extraction complete using ${this.modelRouter.get("browser").model}`,
      structuredData: {
        taskClass: TaskClass.ResearchBrowser,
        extractedText,
        currentUrl,
        sourceUrls: uniqueStrings(browserSources.map((source) => source.url)),
        sources: browserSources,
        sourceTiers: browserSources.map((source) => ({ url: source.url, tier: source.tier })),
        evidencePoints: uniqueStrings(
          [
            pageTitle ? `页面标题：${pageTitle}` : "",
            extractedFacts[0] ? `关键信息：${extractedFacts[0]}` : "",
            currentUrl ? `来源页面：${currentUrl}` : ""
          ].filter(Boolean)
        ),
        extractedFacts,
        timelineEvents: buildTimelineEventsFromSources(
          [
            {
              title: pageTitle,
              snippet: extractedText,
              url: currentUrl
            }
          ],
          4
        ),
        pageTitle,
        attemptSummaries,
        ...(bootstrapSearchSummary ? { bootstrapSearchSummary } : {})
      },
      ...(toolResponse.artifacts ? { artifacts: toolResponse.artifacts } : {}),
      ...(toolResponse.error ? { error: toolResponse.error } : {})
    };
  }
}

export class DocumentAgent implements StepAgent {
  readonly kind = AgentKind.Document;

  constructor(
    private readonly toolRuntime: ToolRuntime,
    private readonly modelRouter: ModelRouter,
    private readonly llmClient?: OpenAIResponsesClient,
    private readonly mode: AgentExecutionMode = "mock"
  ) {}

  async execute(input: AgentRequest): Promise<AgentResponse> {
    const previousSummaries = Array.isArray(input.context["previousStepSummaries"])
      ? input.context["previousStepSummaries"].map(String)
      : [];
    const stepContext = asJsonObject(input.context["currentStep"]);
    const deterministicFallback = buildDocumentFallbackDraft(input);
    let title = deterministicFallback.title;
    let body = deterministicFallback.markdownBody;
    let summary = "Document artifact generated";
    let keySections: string[] = deterministicFallback.keySections;
    let usedSources = deterministicFallback.usedSources;
    let llmFallbackReason:
      | { summary: string; category: string; rawReason: string }
      | undefined;

    if (canUseLiveLlm(this.mode, this.llmClient)) {
      const documentPayload: JsonObject = {
        goal: input.goal,
        previousStepSummaries: previousSummaries,
        previousStepEvidence: Array.isArray(input.context["previousStepEvidence"])
          ? input.context["previousStepEvidence"]
          : [],
        context: input.context
      };
      try {
        const draft = await this.llmClient.generateJson<DocumentDraft>({
          stage: "document",
          messages: [
            {
              role: "system",
              content: DOCUMENT_PROMPT_TEMPLATE
            },
            {
              role: "user",
              content: JSON.stringify(documentPayload, null, 2)
            }
          ],
          jsonSchema: {
            name: "document_draft",
            schema: DOCUMENT_DRAFT_SCHEMA
          },
          maxOutputTokens: 2_200,
          timeoutMs: this.modelRouter.getRequestTimeoutMs("document", TaskClass.DocumentExport)
        });
        const normalizedDraft = validateDocumentDraft(draft.data as unknown);

        title = normalizedDraft.title || title;
        body = normalizedDraft.markdownBody || body;
        summary = normalizedDraft.summary || summary;
        keySections = normalizedDraft.keySections.length > 0 ? normalizedDraft.keySections : keySections;
        usedSources = normalizedDraft.usedSources.length > 0 ? normalizedDraft.usedSources : usedSources;
      } catch (error) {
        if (isParseOrSchemaError(error)) {
          try {
            const recoveredDraft = await recoverDocumentDraft(this.llmClient, documentPayload, error);
            title = recoveredDraft.title || title;
            body = recoveredDraft.markdownBody || body;
            summary = recoveredDraft.summary || summary;
            keySections =
              recoveredDraft.keySections.length > 0 ? recoveredDraft.keySections : keySections;
            usedSources =
              recoveredDraft.usedSources.length > 0 ? recoveredDraft.usedSources : usedSources;
          } catch (recoveryError) {
            llmFallbackReason = summarizeLlmFallbackReason(recoveryError, "document");
            summary = llmFallbackReason.summary;
          }
        } else if (shouldFallbackToLocalDraft(error)) {
          llmFallbackReason = summarizeLlmFallbackReason(error, "document");
          summary = llmFallbackReason.summary;
          keySections = deterministicFallback.keySections;
        } else {
          return buildLiveSynthesisFailure("document", error, {
            title,
            keySections
          });
        }
      }
    }

    if (this.mode === "live") {
      const placeholderSignals = detectDocumentPlaceholderSignals(input.goal, body);
      if (placeholderSignals.length > 0) {
        return {
          status: "failed",
          summary: "document quality guardrail failed",
          structuredData: {
            stage: "document_quality_guardrail",
            title,
            keySections,
            placeholderSignals
          },
          error: {
            code: ErrorCode.Unknown,
            message: `document_quality_guardrail failed: ${placeholderSignals.join("; ")}`,
            retryable: false
          }
        };
      }
    }

    const toolResponse = await this.toolRuntime.execute({
      taskId: input.taskId,
      stepId: input.stepId ?? "unknown-step",
      toolName: ToolName.Document,
      action: "render_markdown",
      input: {
        filename: "report.md",
        title,
        body
      },
      callerAgent: this.kind
    });

    const artifactPaths = Array.isArray(toolResponse.artifacts)
      ? toolResponse.artifacts.map(String)
      : [];
    const artifactEvidence = await collectGeneratedArtifactEvidence(artifactPaths);
    const reportPreview =
      typeof artifactEvidence.reportPreview === "string"
        ? artifactEvidence.reportPreview
        : buildTextPreview(body, 4_000);
    const normalizedKeySections =
      Array.isArray(artifactEvidence.keySections) && artifactEvidence.keySections.length > 0
        ? artifactEvidence.keySections
        : keySections;
    const artifactValidation = buildArtifactValidation(
      artifactPaths,
      reportPreview,
      normalizedKeySections
    );

    return {
      status: toolResponse.status === "success" ? "success" : "failed",
      summary,
      structuredData: {
        taskClass: TaskClass.DocumentExport,
        qualityProfile: asJsonObject(stepContext["qualityProfile"]),
        title,
        reportBodyLength: body.length,
        keySections: normalizedKeySections,
        reportPreview,
        usedSources,
        sectionCoverage: normalizedKeySections.reduce<Record<string, boolean>>((acc, section) => {
          acc[section] = body.includes(section);
          return acc;
        }, {}),
        artifactValidation,
        ...artifactEvidence,
        ...(llmFallbackReason
          ? {
              llmFallbackUsed: true,
              llmFallbackCategory: llmFallbackReason.category,
              llmFallbackReason: llmFallbackReason.rawReason
            }
          : {})
      },
      ...(toolResponse.artifacts ? { artifacts: toolResponse.artifacts } : {}),
      ...(toolResponse.error ? { error: toolResponse.error } : {})
    };
  }
}

export class CodingAgent implements StepAgent {
  readonly kind = AgentKind.Coding;

  constructor(
    private readonly toolRuntime: ToolRuntime,
    private readonly modelRouter: ModelRouter,
    private readonly llmClient?: OpenAIResponsesClient,
    private readonly mode: AgentExecutionMode = "mock"
  ) {}

  async execute(input: AgentRequest): Promise<AgentResponse> {
    let draft = buildMockCodingDraft(input);
    const stepContext = asJsonObject(input.context["currentStep"]);
    let llmFallbackReason:
      | { summary: string; category: string; rawReason: string }
      | undefined;
    const uploadedArtifactUris = asStringArray(input.context["uploadedArtifactUris"]);
    const codingPayload: JsonObject = {
      goal: input.goal,
      context: input.context,
      successCriteria: input.successCriteria ?? [],
      artifacts: input.artifacts ?? [],
      ...(uploadedArtifactUris.length > 0 ? { uploadedArtifactUris } : {})
    };

    if (canUseLiveLlm(this.mode, this.llmClient)) {
      try {
        const response = await this.llmClient.generateJson<CodingDraft>({
          stage: "coding",
          messages: [
            {
              role: "system",
              content: CODING_PROMPT_TEMPLATE
            },
            {
              role: "user",
              content: JSON.stringify(codingPayload, null, 2)
            }
          ],
          jsonSchema: {
            name: "coding_draft",
            schema: CODING_DRAFT_SCHEMA
          },
          maxOutputTokens: 2_400,
          timeoutMs: this.modelRouter.getRequestTimeoutMs("coding", TaskClass.CodingPython)
        });
        const normalizedDraft = validateCodingDraft(response.data as unknown);

        if (normalizedDraft.pythonCode.trim()) {
          draft = {
            summary: normalizedDraft.summary || draft.summary,
            filename: normalizedDraft.filename || draft.filename,
            pythonCode: normalizedDraft.pythonCode,
            expectedArtifacts:
              normalizedDraft.expectedArtifacts.length > 0
                ? normalizedDraft.expectedArtifacts
                : draft.expectedArtifacts
          };
        }
      } catch (error) {
        if (isParseOrSchemaError(error)) {
          try {
            const recoveredDraft = await recoverCodingDraft(this.llmClient, codingPayload, error);
            draft = recoveredDraft;
          } catch (recoveryError) {
            draft = buildDeterministicCodingFallback(input);
            llmFallbackReason = buildCodingFallbackReason(recoveryError, draft, "json_invalid");
            draft.summary = llmFallbackReason.summary;
          }
        } else if (shouldFallbackToLocalDraft(error)) {
          draft = buildDeterministicCodingFallback(input);
          llmFallbackReason = buildCodingFallbackReason(error, draft, "llm_unavailable");
          draft.summary = llmFallbackReason.summary;
        } else {
          const deterministicFallback = isPdfExportRequest(input)
            ? buildLocalPdfExportDraft(input)
            : undefined;
          if (deterministicFallback) {
            draft = deterministicFallback;
            llmFallbackReason = {
              summary: "LLM 导出脚本生成失败，已切换到本地 PDF fallback",
              category: "llm_error",
              rawReason: getErrorMessage(error)
            };
            draft.summary = llmFallbackReason.summary;
          } else {
            return buildLiveSynthesisFailure("coding", error);
          }
        }
      }
    }

    if (isPdfExportRequest(input)) {
      const pdfSource = await resolvePdfSource(input);
      const keySections = extractMarkdownHeadings(pdfSource.markdownBody);
      const pdfToolResponse = await this.toolRuntime.execute({
        taskId: input.taskId,
        stepId: input.stepId ?? "unknown-step",
        toolName: ToolName.Document,
        action: "render_pdf",
        input: {
          title: pdfSource.title,
          body: pdfSource.markdownBody,
          template: "brief",
          outputFilename: "brief.pdf"
        },
        callerAgent: this.kind
      });

      if (pdfToolResponse.status === "success") {
        return {
          status: "success",
          summary: "Exported PDF via DocumentTool",
          structuredData: {
            renderMode: "document_pdf",
            sourceMarkdownPath: pdfSource.sourceMarkdownPath ?? null,
            reportPreview: buildTextPreview(pdfSource.markdownBody, 4_000),
            keySections,
            generatedFiles: pdfToolResponse.artifacts ?? [],
            outputFilename: String(pdfToolResponse.output?.outputFilename ?? "brief.pdf"),
            ...(llmFallbackReason
              ? {
                  llmFallbackUsed: true,
                  llmFallbackCategory: llmFallbackReason.category,
                  llmFallbackReason: llmFallbackReason.rawReason
                }
              : {})
          },
          ...(pdfToolResponse.artifacts ? { artifacts: pdfToolResponse.artifacts } : {}),
          ...(pdfToolResponse.error ? { error: pdfToolResponse.error } : {})
        };
      }
    }

    const toolResponse = await this.toolRuntime.execute({
      taskId: input.taskId,
      stepId: input.stepId ?? "unknown-step",
      toolName: ToolName.Python,
      action: "run_script",
      inputFiles: uploadedArtifactUris,
      input: {
        filename: draft.filename,
        code: draft.pythonCode,
        ...(uploadedArtifactUris.length > 0 ? { inputFiles: uploadedArtifactUris } : {})
      },
      callerAgent: this.kind
    });

    let effectiveToolResponse = toolResponse;
    let effectiveDraft = draft;
    if (
      toolResponse.status === "failed" &&
      isPythonSyntaxFailure(toolResponse) &&
      !llmFallbackReason
    ) {
      effectiveDraft = buildDeterministicCodingFallback(input);
      llmFallbackReason = {
        summary:
          effectiveDraft.fallbackKind === "pdf"
            ? "LLM 生成脚本存在语法问题，已切换到本地 PDF fallback"
            : "LLM 生成脚本存在语法问题，已切换到本地 Python fallback",
        category: "syntax_invalid",
        rawReason: toolResponse.error?.message ?? toolResponse.summary
      };
      effectiveDraft.summary = llmFallbackReason.summary;
      effectiveToolResponse = await this.toolRuntime.execute({
        taskId: input.taskId,
        stepId: input.stepId ?? "unknown-step",
        toolName: ToolName.Python,
        action: "run_script",
        inputFiles: uploadedArtifactUris,
        input: {
          filename: effectiveDraft.filename,
          code: effectiveDraft.pythonCode,
          ...(uploadedArtifactUris.length > 0 ? { inputFiles: uploadedArtifactUris } : {})
        },
        callerAgent: this.kind
      });
    }

    const generatedFiles = Array.isArray(effectiveToolResponse.output?.generatedFiles)
      ? effectiveToolResponse.output.generatedFiles.map(String)
      : [];
    const generatedEvidence =
      effectiveToolResponse.status === "success"
        ? await collectGeneratedArtifactEvidence(generatedFiles)
        : {};
    const artifactPaths = Array.isArray(effectiveToolResponse.artifacts)
      ? effectiveToolResponse.artifacts.map(String)
      : [];
    const artifactValidation = buildArtifactValidation(
      [...generatedFiles, ...artifactPaths],
      typeof generatedEvidence.reportPreview === "string" ? generatedEvidence.reportPreview : undefined,
      Array.isArray(generatedEvidence.keySections) ? generatedEvidence.keySections : []
    );
    const outputSchemas = uniqueStrings(
      generatedFiles.map((filePath) => {
        const lower = filePath.toLowerCase();
        if (lower.endsWith(".json")) {
          return "json";
        }
        if (lower.endsWith(".md")) {
          return "markdown";
        }
        if (lower.endsWith(".csv")) {
          return "csv";
        }
        if (lower.endsWith(".pdf")) {
          return "pdf";
        }
        return path.extname(lower).replace(/^\./, "") || "file";
      })
    );

    return {
      status: effectiveToolResponse.status === "success" ? "success" : "failed",
      summary:
        effectiveToolResponse.status === "success"
          ? effectiveDraft.summary
          : effectiveToolResponse.summary,
      structuredData: {
        taskClass: TaskClass.CodingPython,
        qualityProfile: asJsonObject(stepContext["qualityProfile"]),
        filename: effectiveDraft.filename,
        expectedArtifacts: effectiveDraft.expectedArtifacts,
        stdout: String(effectiveToolResponse.output?.stdout ?? ""),
        stderr: String(effectiveToolResponse.output?.stderr ?? ""),
        generatedFiles,
        scriptPath: String(effectiveToolResponse.output?.scriptPath ?? ""),
        inputFiles: Array.isArray(effectiveToolResponse.output?.inputFiles)
          ? effectiveToolResponse.output?.inputFiles
          : uploadedArtifactUris,
        outputSchemas,
        artifactValidation,
        ...generatedEvidence,
        ...(llmFallbackReason
          ? {
              llmFallbackUsed: true,
              llmFallbackCategory: llmFallbackReason.category,
              llmFallbackReason: llmFallbackReason.rawReason
            }
          : {})
      },
      ...(effectiveToolResponse.artifacts ? { artifacts: effectiveToolResponse.artifacts } : {}),
      ...(effectiveToolResponse.error ? { error: effectiveToolResponse.error } : {})
    };
  }
}

export class ActionAgent implements StepAgent {
  readonly kind = AgentKind.Action;

  constructor(
    private readonly toolRuntime: ToolRuntime,
    private readonly modelRouter: ModelRouter,
    private readonly mode: AgentExecutionMode = "mock"
  ) {}

  async execute(input: AgentRequest): Promise<AgentResponse> {
    const approvalStatus = asOptionalString(input.context["approvalStatus"]);
    const isApproved =
      approvalStatus === ApprovalStatus.Approved || approvalStatus === ApprovalStatus.Executed;
    const previousStepSummaries = asStringArray(input.context["previousStepSummaries"]);
    const goalAndContext = [input.goal, JSON.stringify(input.context)].join("\n").toLowerCase();
    const actionType =
      asOptionalString(input.context["actionType"]) ??
      (EMAIL_KEYWORDS.some((keyword) => goalAndContext.includes(keyword))
        ? "send_email"
        : SLACK_KEYWORDS.some((keyword) => goalAndContext.includes(keyword))
          ? "send_slack"
          : NOTION_KEYWORDS.some((keyword) => goalAndContext.includes(keyword))
            ? "create_notion_page"
            : "send_webhook");
    const url =
      asOptionalString(input.context["actionUrl"]) ??
      (actionType === "send_slack"
        ? process.env.OPENCLAW_SLACK_WEBHOOK_URL
        : process.env.OPENCLAW_ACTION_WEBHOOK_URL) ??
      (this.mode === "mock" ? "https://example.com/webhook" : "");
    const emailTo = asOptionalString(input.context["emailTo"]);
    const notionParentPageId = asOptionalString(input.context["notionParentPageId"]);

    if (actionType === "send_webhook" && !url) {
      return {
        status: "failed",
        summary: "Action agent is missing a webhook url",
        error: {
          code: ErrorCode.InvalidInput,
          message: "Set OPENCLAW_ACTION_WEBHOOK_URL or provide actionUrl in step context",
          retryable: false
        }
      };
    }

    if (actionType === "send_email" && !emailTo) {
      return {
        status: "failed",
        summary: "Action agent is missing an email recipient",
        error: {
          code: ErrorCode.InvalidInput,
          message: "Provide emailTo in step context for email delivery",
          retryable: false
        }
      };
    }

    if (actionType === "create_notion_page" && !notionParentPageId && !process.env.OPENCLAW_NOTION_PARENT_PAGE_ID) {
      return {
        status: "failed",
        summary: "Action agent is missing a Notion parent page id",
        error: {
          code: ErrorCode.InvalidInput,
          message: "Provide notionParentPageId in step context or set OPENCLAW_NOTION_PARENT_PAGE_ID",
          retryable: false
        }
      };
    }

    const payload: JsonObject = {
      taskId: input.taskId,
      stepId: input.stepId ?? "",
      goal: input.goal,
      message:
        previousStepSummaries.length > 0
          ? previousStepSummaries.join(" | ")
          : `Task completed for goal: ${input.goal}`,
      context: asJsonObject(input.context)
    };
    const resolvedNotionParentPageId =
      notionParentPageId ?? process.env.OPENCLAW_NOTION_PARENT_PAGE_ID;

    if (!isApproved) {
      let approvalPayload: JsonObject;
      if (actionType === "send_email") {
        approvalPayload = {
          ...(emailTo ? { to: emailTo } : {}),
          subject: asOptionalString(input.context["emailSubject"]) ?? `Task ${input.taskId} update`,
          text: String(payload.message)
        };
      } else if (actionType === "send_slack") {
        approvalPayload = {
          url,
          text: String(payload.message)
        };
      } else if (actionType === "create_notion_page") {
        approvalPayload = {
          title: asOptionalString(input.context["notionTitle"]) ?? `Task ${input.taskId}`,
          body: String(payload.message)
        };
        if (resolvedNotionParentPageId) {
          approvalPayload.parentPageId = resolvedNotionParentPageId;
        }
      } else {
        approvalPayload = {
          url,
          method: "POST",
          payload
        };
      }

      return {
        status: "need_approval",
        summary:
          actionType === "send_email"
            ? `Action step requires approval before sending email to ${emailTo}`
            : actionType === "send_slack"
              ? "Action step requires approval before posting to Slack"
              : actionType === "create_notion_page"
                ? "Action step requires approval before creating a Notion page"
                : `Action step requires approval before posting to ${url}`,
        structuredData: {
          taskClass: TaskClass.ActionExecution,
          approvalStatus: ApprovalStatus.Pending,
          toolName: ToolName.Action,
          action: actionType,
          approvalReason: "This step performs an external side effect and requires approval.",
          approvalPayload
        }
      };
    }

    let actionInput: JsonObject;
    if (actionType === "send_email") {
      actionInput = {
        ...(emailTo ? { to: emailTo } : {}),
        subject: asOptionalString(input.context["emailSubject"]) ?? `Task ${input.taskId} update`,
        text: String(payload.message)
      };
    } else if (actionType === "send_slack") {
      actionInput = {
        url,
        text: String(payload.message)
      };
    } else if (actionType === "create_notion_page") {
      actionInput = {
        title: asOptionalString(input.context["notionTitle"]) ?? `Task ${input.taskId}`,
        body: String(payload.message)
      };
      if (resolvedNotionParentPageId) {
        actionInput.parentPageId = resolvedNotionParentPageId;
      }
    } else {
      actionInput = {
        url,
        method: "POST",
        payload
      };
    }

    const toolResponse = await this.toolRuntime.execute({
      taskId: input.taskId,
      stepId: input.stepId ?? "unknown-step",
      toolName: ToolName.Action,
      action: actionType,
      input: actionInput,
      callerAgent: this.kind
    });

    return {
      status: toolResponse.status === "success" ? "success" : "failed",
      summary: toolResponse.status === "success" ? "Action execution complete" : toolResponse.summary,
      structuredData: {
        taskClass: TaskClass.ActionExecution,
        approvalStatus: isApproved ? ApprovalStatus.Executed : ApprovalStatus.Pending,
        actionType,
        ...(url ? { url } : {}),
        ...(emailTo ? { emailTo } : {}),
        ...(notionParentPageId ? { notionParentPageId } : {}),
        deliveryStatus: toolResponse.status,
        response: toolResponse.output ?? {},
        deliveryReceipt: toolResponse.output ?? {}
      },
      ...(toolResponse.error ? { error: toolResponse.error } : {})
    };
  }
}

export class VerifierAgent implements VerifyingAgent {
  constructor(
    private readonly modelRouter: ModelRouter,
    private readonly llmClient?: OpenAIResponsesClient,
    private readonly mode: AgentExecutionMode = "mock"
  ) {}

  async verifyStep(
    task: Task,
    step: TaskStep,
    response: AgentResponse
  ): Promise<VerificationDecision> {
    const baseline = normalizeVerificationDecision(
      step,
      response,
      this.mockVerify(task, step, response)
    );

    if (response.status !== "success") {
      return baseline;
    }

    if (this.mode === "live" && this.llmClient?.isConfigured()) {
      try {
        const llmDecision = await this.llmClient.generateJson<VerificationDecision>({
          stage: "verifier_step",
          messages: [
            {
              role: "system",
              content: VERIFIER_PROMPT_TEMPLATE
            },
            {
              role: "user",
              content: JSON.stringify(
                {
                  taskGoal: task.goal,
                  step: {
                    id: step.id,
                    title: step.title,
                    agent: step.agent,
                    objective: step.objective,
                    successCriteria: step.successCriteria
                  },
                  response: {
                    status: response.status,
                    summary: response.summary,
                    artifacts: response.artifacts ?? [],
                    structuredData: response.structuredData ?? {},
                    error: response.error ?? null,
                    baselineVerification: baseline
                  }
                },
                null,
                2
              )
            }
          ],
          jsonSchema: {
            name: "verification_decision",
            schema: VERIFICATION_SCHEMA
          },
          maxOutputTokens: 1_000,
          timeoutMs: this.modelRouter.getRequestTimeoutMs(
            "verifier_step",
            getStepTaskClass(task, step)
          )
        });
        return normalizeVerificationDecision(
          step,
          response,
          mergeVerificationDecision(baseline, llmDecision.data)
        );
      } catch {
        return baseline;
      }
    }

    return baseline;
  }

  private mockVerify(task: Task, step: TaskStep, response: AgentResponse): VerificationDecision {
    return calculateQualityAssessment(task, step, response);
  }
}

export class AgentRegistry {
  private readonly agents = new Map<AgentKind, StepAgent>();

  constructor(stepAgents: StepAgent[]) {
    for (const agent of stepAgents) {
      this.agents.set(agent.kind, agent);
    }
  }

  get(kind: AgentKind): StepAgent {
    const agent = this.agents.get(kind);
    if (!agent) {
      throw new Error(`No step agent registered for ${kind}`);
    }
    return agent;
  }
}
