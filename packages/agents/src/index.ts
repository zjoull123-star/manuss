import { promises as fs } from "node:fs";
import {
  AgentKind,
  AgentRequest,
  AgentResponse,
  ApprovalStatus,
  ErrorCode,
  Plan,
  PlanningAgent,
  RouteDecision,
  RoutingAgent,
  StepAgent,
  Task,
  TaskStep,
  ToolName,
  UserProfile,
  VerificationDecision,
  VerifyingAgent
} from "../../core/src";
import { JsonObject } from "../../shared/src";
import { ModelRouter, OpenAIResponsesClient } from "../../llm/src";
import {
  BROWSER_PROMPT_TEMPLATE,
  CODING_PROMPT_TEMPLATE,
  DOCUMENT_PROMPT_TEMPLATE,
  PLANNER_PROMPT_TEMPLATE,
  RESEARCH_PROMPT_TEMPLATE,
  ROUTER_PROMPT_TEMPLATE,
  VERIFIER_PROMPT_TEMPLATE
} from "../../prompts/src";
import { ToolRuntime } from "../../tools/src";

export type AgentExecutionMode = "mock" | "live";

const hasKeyword = (input: string, keywords: string[]): boolean =>
  keywords.some((keyword) => input.toLowerCase().includes(keyword.toLowerCase()));

const TASK_PREFIX_PATTERN = /^\s*task:\s*/i;

const AGENT_KIND_VALUES = Object.values(AgentKind);

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
    }
  },
  required: ["summary", "topResultUrl", "findings", "marketSignals", "coverageGaps"]
};

type ResearchSynthesis = {
  summary: string;
  topResultUrl: string;
  findings: string[];
  marketSignals: string[];
  coverageGaps: string[];
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
    keySections: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: ["summary", "title", "markdownBody", "keySections"]
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
    confidence: { type: "number", minimum: 0, maximum: 1 }
  },
  required: ["verdict", "reason", "missingCriteria", "suggestedFix", "confidence"]
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
  "coverageGaps"
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

const normalizeStringList = (value: unknown, fieldName: string): string[] => {
  if (isStringArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    return value
      .split(/\r?\n|•|·|;\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
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

  return {
    summary: candidate.summary,
    topResultUrl: candidate.topResultUrl,
    findings,
    marketSignals,
    coverageGaps
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
          'summary (string), topResultUrl (string), findings (string[]), marketSignals (string[]), coverageGaps (string[]).',
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

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => String(item)) : [];

const asJsonObject = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};

const uniqueStrings = (values: string[]): string[] => [...new Set(values.filter(Boolean))];

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
    return hasKeyword(stepSignals, PDF_KEYWORDS);
  }

  return hasKeyword([input.goal, successCriteria].join("\n"), PDF_KEYWORDS);
};

const stepRequiresPdfArtifact = (step: TaskStep): boolean =>
  hasKeyword(
    [step.title, step.objective, ...(Array.isArray(step.successCriteria) ? step.successCriteria : [])].join(
      "\n"
    ),
    PDF_KEYWORDS
  );

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
      confidence: Math.max(decision.confidence, 0.9)
    };
  }

  return decision;
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

const normalizePdfExportSteps = (goal: string, plan: Plan): Plan => {
  if (!hasKeyword(goal, PDF_KEYWORDS)) {
    return plan;
  }

  const normalizedSteps = plan.steps.map((step) => {
    const stepText = [
      step.title,
      step.objective,
      step.expectedOutput,
      ...step.successCriteria
    ].join("\n");
    const isPdfStep = hasKeyword(stepText, PDF_KEYWORDS);
    const isExplicitExportStep = /(导出|export|排版)/i.test(stepText);

    if (!isPdfStep || !isExplicitExportStep || step.agent === AgentKind.Coding) {
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

  const hasPdfStep = plan.steps.some((step) =>
    hasKeyword(
      [step.title, step.objective, step.expectedOutput, ...step.successCriteria].join("\n"),
      PDF_KEYWORDS
    )
  );
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

  const pdfStepIndex = plan.steps.findIndex((step) =>
    hasKeyword([step.title, step.objective, step.expectedOutput, ...step.successCriteria].join("\n"), PDF_KEYWORDS)
  );
  if (pdfStepIndex === -1) {
    return plan;
  }

  const pdfStep = plan.steps[pdfStepIndex];
  if (!pdfStep) {
    return plan;
  }

  const dependencyStep =
    [...plan.steps.slice(0, pdfStepIndex)].reverse().find((step) => step.agent !== AgentKind.Action) ??
    plan.steps.at(pdfStepIndex - 1);
  const documentStepId = `${pdfStep.id}_doc`;
  const documentStep: Plan["steps"][number] = {
    id: documentStepId,
    title: "生成 Markdown 摘要",
    agent: AgentKind.Document,
    objective: "基于前序分析结果生成结构化 Markdown 摘要，为最终 PDF 导出准备文稿。",
    dependsOn: dependencyStep ? [dependencyStep.id] : pdfStep.dependsOn,
    inputs: dependencyStep ? [`${dependencyStep.id} 结构化结果`] : pdfStep.inputs,
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

const sanitizePlannedTask = (goal: string, plan: Plan): Plan => {
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

  sanitizedPlan = normalizeDirectExecutionSteps(goal, sanitizedPlan);
  sanitizedPlan = ensurePdfExportStep(goal, sanitizedPlan);
  return ensureDocumentBeforePdfStep(goal, sanitizedPlan);
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
  bootstrapSearchSummary?: string;
  fallbackReason: string;
}): AgentResponse => {
  const currentUrl = String(params.toolResponse.output?.currentUrl ?? params.selectedUrl);
  const pageTitle = String(params.toolResponse.output?.pageTitle ?? "");
  const extractedText = String(params.toolResponse.output?.extractedText ?? "");
  const extractedFacts = extractBrowserFactSnippets(extractedText);
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
      currentUrl,
      pageTitle,
      evidencePoints,
      extractedFacts,
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
                  context,
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
        });
      } catch {
        return this.mockPlan(goal);
      }
    }

    return this.mockPlan(goal);
  }

  private mockPlan(goal: string): Plan {
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

    return {
      goal,
      assumptions: ["Public information only", "Chinese output by default"],
      steps,
      taskSuccessCriteria: ["Task completes without manual intervention", "At least one final artifact exists"]
    };
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
    const toolResponse = await this.toolRuntime.execute({
      taskId: input.taskId,
      stepId: input.stepId ?? "unknown-step",
      toolName: ToolName.Search,
      action: "search_web",
      input: {
        query: buildExecutionQuery(input)
      },
      callerAgent: this.kind
    });

    const firstResult = Array.isArray(toolResponse.output?.results)
      ? (toolResponse.output?.results[0] as JsonObject | undefined)
      : undefined;
    const topResultUrl = typeof firstResult?.url === "string" ? firstResult.url : "";
    const candidateSourceUrls = collectSearchResultUrls(toolResponse.output?.results);
    const sourceCount = Array.isArray(toolResponse.output?.results)
      ? toolResponse.output.results.length
      : 0;
    const researchPayload: JsonObject = {
      goal: input.goal,
      searchSummary: toolResponse.summary,
      searchAnswer: typeof toolResponse.output?.answer === "string"
        ? toolResponse.output.answer
        : "",
      results: Array.isArray(toolResponse.output?.results)
        ? toolResponse.output.results
        : []
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
          maxOutputTokens: 1_000
        });

        const structuredData: JsonObject = {
          sourceCount,
          topResultUrl: synthesis.data.topResultUrl || topResultUrl,
          candidateSourceUrls,
          findings: synthesis.data.findings,
          marketSignals: synthesis.data.marketSignals,
          coverageGaps: synthesis.data.coverageGaps
        };
        const qualitySignals = detectResearchQualitySignals(sourceCount, synthesis.data.findings);
        if (qualitySignals.length > 0) {
          return buildResearchQualityFailure(structuredData, qualitySignals);
        }

        return {
          status: "success",
          summary: synthesis.data.summary,
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
              findings: recoveredSynthesis.findings,
              marketSignals: recoveredSynthesis.marketSignals,
              coverageGaps: recoveredSynthesis.coverageGaps
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
          candidateSourceUrls
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
          candidateSourceUrls
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
      sourceCount,
      topResultUrl,
      candidateSourceUrls,
      findings
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
              maxOutputTokens: 600
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

      attemptSummaries.push({
        url: candidateUrl,
        status: attemptResponse.status,
        pageTitle,
        currentUrl,
        ...(blockedReason ? { blockedReason } : {}),
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

      toolResponse = attemptResponse;
      selectedUrl = candidateUrl;
      selectedBlockedReason = undefined;
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

    if (selectedBlockedReason) {
      return {
        status: "failed",
        summary: "Browser extraction only found blocked or challenge pages",
        structuredData: {
          attemptSummaries,
          candidateUrls,
          blockedReason: selectedBlockedReason,
          ...(bootstrapSearchSummary ? { bootstrapSearchSummary } : {})
        },
        ...(toolResponse.artifacts ? { artifacts: toolResponse.artifacts } : {}),
        error: {
          code: ErrorCode.ToolUnavailable,
          message: selectedBlockedReason,
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
          maxOutputTokens: 1_000
        });

        return {
          status: "success",
          summary: synthesis.data.summary,
          structuredData: {
            currentUrl:
              synthesis.data.currentUrl || String(toolResponse.output?.currentUrl ?? selectedUrl),
            pageTitle: synthesis.data.pageTitle || String(toolResponse.output?.pageTitle ?? ""),
            evidencePoints: synthesis.data.evidencePoints,
            extractedFacts: synthesis.data.extractedFacts,
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
                currentUrl:
                  recoveredSynthesis.currentUrl ||
                  String(toolResponse.output?.currentUrl ?? selectedUrl),
                pageTitle:
                  recoveredSynthesis.pageTitle || String(toolResponse.output?.pageTitle ?? ""),
                evidencePoints: recoveredSynthesis.evidencePoints,
                extractedFacts: recoveredSynthesis.extractedFacts,
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
              ...(bootstrapSearchSummary ? { bootstrapSearchSummary } : {}),
              fallbackReason: `browser_json_recovery_failed: ${getErrorMessage(error)}; ${getErrorMessage(recoveryError)}`
            });
          }
        }

        return buildBrowserFallbackResponse({
          toolResponse,
          selectedUrl,
          attemptSummaries,
          ...(bootstrapSearchSummary ? { bootstrapSearchSummary } : {}),
          fallbackReason: `browser_synthesis_failed: ${getErrorMessage(error)}`
        });
      }
    }

    return {
      status: toolResponse.status === "success" ? "success" : "failed",
      summary: `Browser extraction complete using ${this.modelRouter.get("browser").model}`,
      structuredData: {
        extractedText: String(toolResponse.output?.extractedText ?? ""),
        currentUrl: String(toolResponse.output?.currentUrl ?? selectedUrl),
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
    const fallbackBody = [
      `Model: ${this.modelRouter.get("document").model}`,
      "",
      "## Key Findings",
      ...previousSummaries.map((summary) => `- ${summary}`)
    ].join("\n");
    let title = input.goal;
    let body = fallbackBody;
    let summary = "Document artifact generated";
    let keySections: string[] = ["Key Findings"];
    let llmFallbackReason:
      | { summary: string; category: string; rawReason: string }
      | undefined;

    if (canUseLiveLlm(this.mode, this.llmClient)) {
      try {
        const draft = await this.llmClient.generateJson<{
          summary: string;
          title: string;
          markdownBody: string;
          keySections: string[];
        }>({
          stage: "document",
          messages: [
            {
              role: "system",
              content: DOCUMENT_PROMPT_TEMPLATE
            },
            {
              role: "user",
              content: JSON.stringify(
                {
                  goal: input.goal,
                  previousStepSummaries: previousSummaries,
                  context: input.context
                },
                null,
                2
              )
            }
          ],
          jsonSchema: {
            name: "document_draft",
            schema: DOCUMENT_DRAFT_SCHEMA
          },
          maxOutputTokens: 1_800
        });

        title = draft.data.title || title;
        body = draft.data.markdownBody || body;
        summary = draft.data.summary || summary;
        keySections = draft.data.keySections.length > 0 ? draft.data.keySections : keySections;
      } catch (error) {
        if (shouldFallbackToLocalDraft(error)) {
          llmFallbackReason = summarizeLlmFallbackReason(error, "document");
          summary = llmFallbackReason.summary;
          keySections = ["Key Findings", "Fallback Notes"];
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

    return {
      status: toolResponse.status === "success" ? "success" : "failed",
      summary,
      structuredData: {
        title,
        reportBodyLength: body.length,
        keySections,
        reportPreview: buildTextPreview(body, 4_000),
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
          maxOutputTokens: 2_400
        });

        if (response.data.pythonCode.trim()) {
          draft = {
            summary: response.data.summary || draft.summary,
            filename: response.data.filename || draft.filename,
            pythonCode: response.data.pythonCode,
            expectedArtifacts:
              response.data.expectedArtifacts.length > 0
                ? response.data.expectedArtifacts
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

    const generatedFiles = Array.isArray(toolResponse.output?.generatedFiles)
      ? toolResponse.output.generatedFiles.map(String)
      : [];
    const generatedEvidence =
      toolResponse.status === "success"
        ? await collectGeneratedArtifactEvidence(generatedFiles)
        : {};

    return {
      status: toolResponse.status === "success" ? "success" : "failed",
      summary: toolResponse.status === "success" ? draft.summary : toolResponse.summary,
      structuredData: {
        filename: draft.filename,
        expectedArtifacts: draft.expectedArtifacts,
        stdout: String(toolResponse.output?.stdout ?? ""),
        stderr: String(toolResponse.output?.stderr ?? ""),
        generatedFiles,
        scriptPath: String(toolResponse.output?.scriptPath ?? ""),
        inputFiles: Array.isArray(toolResponse.output?.inputFiles)
          ? toolResponse.output?.inputFiles
          : uploadedArtifactUris,
        ...generatedEvidence,
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
    const url =
      asOptionalString(input.context["actionUrl"]) ??
      process.env.OPENCLAW_ACTION_WEBHOOK_URL ??
      (this.mode === "mock" ? "https://example.com/webhook" : "");

    if (!url) {
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

    if (!isApproved) {
      return {
        status: "need_approval",
        summary: `Action step requires approval before posting to ${url}`,
        structuredData: {
          toolName: ToolName.Action,
          action: "post_webhook",
          approvalReason: "This step sends an external webhook and has side effects.",
          approvalPayload: {
            url,
            method: "POST",
            payload
          }
        }
      };
    }

    const toolResponse = await this.toolRuntime.execute({
      taskId: input.taskId,
      stepId: input.stepId ?? "unknown-step",
      toolName: ToolName.Action,
      action: "post_webhook",
      input: {
        url,
        method: "POST",
        payload
      },
      callerAgent: this.kind
    });

    return {
      status: toolResponse.status === "success" ? "success" : "failed",
      summary: toolResponse.status === "success" ? "Action execution complete" : toolResponse.summary,
      structuredData: {
        url,
        deliveryStatus: toolResponse.status,
        response: toolResponse.output ?? {}
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
    if (response.status !== "success") {
      return this.mockVerify(step, response);
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
                    error: response.error ?? null
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
          maxOutputTokens: 800
        });
        return normalizeVerificationDecision(step, response, llmDecision.data);
      } catch {
        return normalizeVerificationDecision(step, response, this.mockVerify(step, response));
      }
    }

    return normalizeVerificationDecision(step, response, this.mockVerify(step, response));
  }

  private mockVerify(step: TaskStep, response: AgentResponse): VerificationDecision {
    if (response.status !== "success") {
      const detailedReason = response.error?.message?.trim();
      return {
        verdict: response.error?.retryable ? "retry_step" : "replan_task",
        reason:
          detailedReason && detailedReason.length > 0
            ? detailedReason
            : `Step failed under ${this.modelRouter.get("verifier_step").model}`,
        missingCriteria: step.successCriteria,
        suggestedFix: "Inspect tool output or retry with stronger strategy",
        confidence: 0.75
      };
    }

    if (step.agent === AgentKind.Document && (!response.artifacts || response.artifacts.length === 0)) {
      return {
        verdict: "retry_step",
        reason: "Document step completed without an artifact",
        missingCriteria: ["A markdown artifact exists"],
        suggestedFix: "Re-run document generation",
        confidence: 0.9
      };
    }

    return {
      verdict: "pass",
      reason: `Step verified using ${this.modelRouter.get("verifier_step").model}`,
      missingCriteria: [],
      suggestedFix: "",
      confidence: 0.92
    };
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
