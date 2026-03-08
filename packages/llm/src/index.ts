import { JsonObject, JsonValue } from "../../shared/src";

export type ModelStage =
  | "router"
  | "planner"
  | "replanner"
  | "research"
  | "browser"
  | "coding"
  | "document"
  | "verifier_step"
  | "verifier_final"
  | "embeddings"
  | "moderation";

export interface ModelConfig {
  model: string;
  reasoningEffort: "none" | "low" | "medium" | "high";
}

export type TaskClassHint =
  | "research_browser"
  | "coding_python"
  | "document_export"
  | "action_execution";

export interface ModelSelectionOptions {
  attempt?: number;
  finalDelivery?: boolean;
  taskClass?: TaskClassHint;
}

export const DEFAULT_OPENAI_MODELS: Record<ModelStage, ModelConfig> = {
  router: { model: "gpt-5-nano", reasoningEffort: "none" },
  planner: { model: "gpt-5.4-2026-03-05", reasoningEffort: "high" },
  replanner: { model: "gpt-5.4-2026-03-05", reasoningEffort: "high" },
  research: { model: "gpt-5-mini-2025-08-07", reasoningEffort: "low" },
  browser: { model: "gpt-5-mini-2025-08-07", reasoningEffort: "low" },
  coding: { model: "gpt-5.3-codex", reasoningEffort: "medium" },
  document: { model: "gpt-5-mini-2025-08-07", reasoningEffort: "low" },
  verifier_step: { model: "gpt-5-mini-2025-08-07", reasoningEffort: "medium" },
  verifier_final: { model: "gpt-5.4-2026-03-05", reasoningEffort: "high" },
  embeddings: { model: "text-embedding-3-large", reasoningEffort: "none" },
  moderation: { model: "omni-moderation-latest", reasoningEffort: "none" }
};

type ResponseRole = "system" | "user" | "assistant";

export interface ResponseMessage {
  role: ResponseRole;
  content: string;
}

export interface JsonSchemaDefinition {
  name: string;
  schema: JsonObject;
  description?: string;
}

export interface WebSearchLocation {
  type: "approximate";
  city?: string;
  region?: string;
  country?: string;
  timezone?: string;
}

export interface OpenAIRequestOptions {
  stage: ModelStage;
  messages: ResponseMessage[];
  jsonSchema?: JsonSchemaDefinition;
  tools?: JsonObject[];
  include?: string[];
  metadata?: JsonObject;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface OpenAITextResult {
  id: string;
  model: string;
  outputText: string;
  raw: JsonObject;
}

export interface OpenAIJsonResult<T> extends OpenAITextResult {
  data: T;
}

export interface WebSearchSource {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult extends OpenAITextResult {
  sources: WebSearchSource[];
}

interface ResponsesApiTextFormat extends JsonObject {
  type: "json_schema";
  name: string;
  strict: true;
  schema: JsonObject;
  description?: string;
}

interface ResponsesApiPayload extends JsonObject {
  model: string;
  input: Array<{
    role: ResponseRole;
    content: Array<{
      type: "input_text";
      text: string;
    }>;
  }>;
  reasoning?: {
    effort: "low" | "medium" | "high";
  };
  text?: {
    format?: ResponsesApiTextFormat;
  };
  tools?: JsonObject[];
  include?: string[];
  metadata?: JsonObject;
  max_output_tokens?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 120_000;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const extractOutputText = (raw: JsonObject): string => {
  const topLevel = raw["output_text"];
  if (typeof topLevel === "string" && topLevel.trim().length > 0) {
    return topLevel;
  }

  const outputs = raw["output"];
  if (!Array.isArray(outputs)) {
    return "";
  }

  const segments: string[] = [];
  for (const output of outputs) {
    if (!isObject(output)) {
      continue;
    }

    const content = output["content"];
    if (!Array.isArray(content)) {
      continue;
    }

    for (const item of content) {
      if (!isObject(item)) {
        continue;
      }

      if (item["type"] === "output_text" && typeof item["text"] === "string") {
        segments.push(item["text"]);
      }
    }
  }

  return segments.join("\n").trim();
};

const collectCitedSources = (raw: JsonObject): WebSearchSource[] => {
  const sources = new Map<string, WebSearchSource>();
  const outputs = raw["output"];

  if (!Array.isArray(outputs)) {
    return [];
  }

  for (const output of outputs) {
    if (!isObject(output)) {
      continue;
    }

    const action = output["action"];
    if (isObject(action) && Array.isArray(action["sources"])) {
      for (const source of action["sources"]) {
        if (!isObject(source)) {
          continue;
        }

        const url = typeof source["url"] === "string" ? source["url"] : "";
        if (!url) {
          continue;
        }

        sources.set(url, {
          title: typeof source["title"] === "string" ? source["title"] : url,
          url,
          snippet:
            typeof source["snippet"] === "string"
              ? source["snippet"]
              : typeof source["description"] === "string"
                ? source["description"]
                : ""
        });
      }
    }

    const content = output["content"];
    if (!Array.isArray(content)) {
      continue;
    }

    for (const item of content) {
      if (!isObject(item) || !Array.isArray(item["annotations"])) {
        continue;
      }

      for (const annotation of item["annotations"]) {
        if (!isObject(annotation)) {
          continue;
        }

        const url = typeof annotation["url"] === "string" ? annotation["url"] : "";
        if (!url) {
          continue;
        }

        sources.set(url, {
          title:
            typeof annotation["title"] === "string"
              ? annotation["title"]
              : typeof annotation["text"] === "string"
                ? annotation["text"]
                : url,
          url,
          snippet: typeof annotation["text"] === "string" ? annotation["text"] : ""
        });
      }
    }
  }

  return [...sources.values()];
};

const toInputMessages = (messages: ResponseMessage[]): ResponsesApiPayload["input"] =>
  messages.map((message) => ({
    role: message.role,
    content: [{ type: "input_text", text: message.content }]
  }));

export class ModelRouter {
  get(
    stage: ModelStage,
    options: number | ModelSelectionOptions = 0,
    legacyFinalDelivery = false
  ): ModelConfig {
    const normalized =
      typeof options === "number"
        ? { attempt: options, finalDelivery: legacyFinalDelivery }
        : {
            attempt: options.attempt ?? 0,
            finalDelivery: options.finalDelivery ?? false,
            taskClass: options.taskClass
          };
    const attempt = normalized.attempt ?? 0;
    const finalDelivery = normalized.finalDelivery ?? false;
    const taskClass = normalized.taskClass;

    if (
      finalDelivery &&
      (stage === "document" ||
        stage === "verifier_step" ||
        stage === "verifier_final")
    ) {
      return DEFAULT_OPENAI_MODELS.verifier_final;
    }

    if (attempt >= 1 && ["research", "browser", "verifier_step"].includes(stage)) {
      return DEFAULT_OPENAI_MODELS.verifier_final;
    }

    if (attempt >= 1 && stage === "document" && taskClass === "document_export") {
      return DEFAULT_OPENAI_MODELS.verifier_final;
    }

    if (attempt >= 2 && stage === "coding" && taskClass === "document_export") {
      return DEFAULT_OPENAI_MODELS.verifier_final;
    }

    if (attempt >= 2 && stage !== "planner" && stage !== "replanner") {
      return DEFAULT_OPENAI_MODELS.verifier_final;
    }

    return DEFAULT_OPENAI_MODELS[stage];
  }

  getRequestTimeoutMs(
    stage: ModelStage,
    taskClass?: TaskClassHint
  ): number {
    if (stage === "research") {
      return 90_000;
    }
    if (stage === "browser") {
      return 60_000;
    }
    if (stage === "coding" || stage === "document") {
      return taskClass === "document_export" ? 90_000 : 75_000;
    }
    if (stage === "verifier_step" || stage === "verifier_final") {
      return 60_000;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  getSearchTimeoutMs(): number {
    return 180_000;
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitBreakerOpenError";
  }
}

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private consecutiveFailures = 0;
  private lastFailureTime = 0;

  constructor(
    private readonly failureThreshold = 5,
    private readonly resetTimeoutMs = 60_000
  ) {}

  get currentState(): CircuitState {
    if (this.state === "OPEN" && Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
      this.state = "HALF_OPEN";
    }
    return this.state;
  }

  assertCallAllowed(): void {
    if (this.currentState === "OPEN") {
      throw new CircuitBreakerOpenError(
        `Circuit breaker is OPEN (${this.consecutiveFailures} consecutive failures, resets in ${Math.max(0, this.resetTimeoutMs - (Date.now() - this.lastFailureTime))}ms)`
      );
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "CLOSED";
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    this.lastFailureTime = Date.now();
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "OPEN";
    }
  }
}

export interface OpenAIResponsesClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  searchTimeoutMs?: number;
  defaultSearchLocation?: WebSearchLocation;
  circuitBreakerThreshold?: number;
  circuitBreakerResetMs?: number;
}

export class OpenAIResponsesClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly searchTimeoutMs: number;
  private readonly defaultSearchLocation: WebSearchLocation | undefined;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(
    private readonly modelRouter: ModelRouter,
    private readonly options: OpenAIResponsesClientOptions = {}
  ) {
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.searchTimeoutMs = options.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
    this.defaultSearchLocation = options.defaultSearchLocation;
    this.circuitBreaker = new CircuitBreaker(
      options.circuitBreakerThreshold ?? 5,
      options.circuitBreakerResetMs ?? 60_000
    );
  }

  isConfigured(): boolean {
    return Boolean(this.options.apiKey);
  }

  describeRequest(stage: ModelStage, input: string): Record<string, unknown> {
    const config = this.modelRouter.get(stage);
    return {
      endpoint: `${this.baseUrl}/responses`,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      input
    };
  }

  async generateText(options: OpenAIRequestOptions): Promise<OpenAITextResult> {
    const raw = await this.createResponse(options);
    return {
      id: typeof raw["id"] === "string" ? raw["id"] : "unknown",
      model: this.modelRouter.get(options.stage).model,
      outputText: extractOutputText(raw),
      raw
    };
  }

  async generateJson<T>(options: OpenAIRequestOptions): Promise<OpenAIJsonResult<T>> {
    if (!options.jsonSchema) {
      throw new Error("jsonSchema is required for generateJson");
    }

    const textResult = await this.generateText(options);
    const parsed = JSON.parse(textResult.outputText) as T;

    return {
      ...textResult,
      data: parsed
    };
  }

  async searchWeb(params: {
    query: string;
    stage?: ModelStage;
    allowedDomains?: string[];
    userLocation?: WebSearchLocation;
  }): Promise<WebSearchResult> {
    const webSearchTool: JsonObject = {
      type: "web_search"
    };
    const tools: JsonObject[] = [webSearchTool];

    const domains = params.allowedDomains?.filter(Boolean);
    if (domains && domains.length > 0) {
      webSearchTool["search_context_size"] = "medium";
      webSearchTool["filters"] = {
        allowed_domains: domains
      };
    }

    const userLocation = params.userLocation ?? this.defaultSearchLocation;
    if (userLocation) {
      webSearchTool["user_location"] = {
        type: userLocation.type,
        ...(userLocation.city ? { city: userLocation.city } : {}),
        ...(userLocation.region ? { region: userLocation.region } : {}),
        ...(userLocation.country ? { country: userLocation.country } : {}),
        ...(userLocation.timezone ? { timezone: userLocation.timezone } : {})
      };
    }

    const result = await this.generateText({
      stage: params.stage ?? "research",
      messages: [
        {
          role: "user",
          content: params.query
        }
      ],
      tools,
      include: ["web_search_call.action.sources"],
      timeoutMs: params.stage ? this.modelRouter.getSearchTimeoutMs() : this.searchTimeoutMs
    });

    return {
      ...result,
      sources: collectCitedSources(result.raw)
    };
  }

  private async createResponse(options: OpenAIRequestOptions): Promise<JsonObject> {
    if (!this.options.apiKey) {
      throw new Error("OPENAI_API_KEY is not configured");
    }

    this.circuitBreaker.assertCallAllowed();

    const model = this.modelRouter.get(options.stage);
    const payload: ResponsesApiPayload = {
      model: model.model,
      input: toInputMessages(options.messages)
    };

    if (model.reasoningEffort !== "none") {
      payload.reasoning = {
        effort: model.reasoningEffort
      };
    }

    if (options.jsonSchema) {
      payload.text = {
        format: {
          type: "json_schema",
          name: options.jsonSchema.name,
          strict: true,
          schema: options.jsonSchema.schema,
          ...(options.jsonSchema.description
            ? { description: options.jsonSchema.description }
            : {})
        }
      };
    }

    if (options.tools && options.tools.length > 0) {
      payload.tools = options.tools;
    }

    if (options.include && options.include.length > 0) {
      payload.include = options.include;
    }

    if (options.metadata) {
      payload.metadata = options.metadata;
    }

    if (typeof options.maxOutputTokens === "number") {
      payload.max_output_tokens = options.maxOutputTokens;
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.modelRouter.getRequestTimeoutMs(options.stage) ?? this.timeoutMs
    );

    try {
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const raw = (await response.json()) as JsonValue;
      if (!response.ok) {
        throw new Error(`OpenAI Responses API error (${response.status}): ${JSON.stringify(raw)}`);
      }

      if (!isObject(raw)) {
        throw new Error("OpenAI Responses API returned a non-object payload");
      }

      this.circuitBreaker.recordSuccess();
      return raw;
    } catch (error) {
      if (!(error instanceof CircuitBreakerOpenError)) {
        this.circuitBreaker.recordFailure();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
