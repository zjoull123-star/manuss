import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Document as DocxDocument, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import ExcelJS from "exceljs";
import nodemailer from "nodemailer";
import PptxGenJS from "pptxgenjs";
import {
  createTaskEvent,
  ErrorCode,
  TaskEventKind,
  TaskEventRepository,
  ToolCall,
  ToolCallRepository,
  ToolName,
  ToolRequest,
  ToolResponse
} from "../../core/src";
import { ArtifactRegistry, WorkspaceManager } from "../../artifacts/src";
import { OpenAIResponsesClient } from "../../llm/src";
import { Logger } from "../../observability/src";
import { ToolPolicyService } from "../../policy/src";
import { createId, JsonObject } from "../../shared/src";

export interface Tool {
  readonly name: ToolName;
  execute(request: ToolRequest): Promise<ToolResponse>;
}

export type ToolExecutionMode = "mock" | "live";

export interface SearchToolOptions {
  mode: ToolExecutionMode;
  allowedDomains?: string[];
}

export interface BrowserToolOptions {
  mode: ToolExecutionMode;
  headless?: boolean;
  channel?: string;
  executablePath?: string;
  navigationTimeoutMs?: number;
  defaultScreenshot?: boolean;
  maxExtractedChars?: number;
  profileRootDir?: string;
}

export interface ActionToolOptions {
  mode: ToolExecutionMode;
  defaultUrl?: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
  smtp?: {
    host?: string;
    port?: number;
    user?: string;
    pass?: string;
    from?: string;
    secure?: boolean;
  };
  slackWebhookUrl?: string;
  notionToken?: string;
  notionParentPageId?: string;
}

export interface PythonToolOptions {
  mode: ToolExecutionMode;
  pythonExecutable?: string;
  timeoutMs?: number;
  maxStdoutChars?: number;
  maxStderrChars?: number;
  disableUserSite?: boolean;
  maxMemoryMb?: number;
  maxCpuSeconds?: number;
}

const normalizeToolFailure = (
  message: string,
  code: ErrorCode,
  retryable: boolean
): ToolResponse => ({
  status: "failed",
  summary: message,
  error: {
    code,
    message,
    retryable
  }
});

const normalizeUnexpectedToolFailure = (
  request: ToolRequest,
  error: unknown
): ToolResponse => {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const timeout = lower.includes("timed out") || lower.includes("timeout");
  const retryable =
    timeout ||
    lower.includes("network") ||
    lower.includes("econn") ||
    lower.includes("enotfound") ||
    lower.includes("temporar") ||
    lower.includes("playwright");

  return {
    status: "failed",
    summary: `${request.toolName}.${request.action} failed unexpectedly`,
    error: {
      code: timeout ? ErrorCode.Timeout : ErrorCode.ToolUnavailable,
      message,
      retryable,
      stage: "tool_runtime",
      category: "unhandled_tool_exception",
      upstreamErrorMessage: message
    }
  };
};

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const trimText = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated]`;

const sanitizeFileToken = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

const sanitizeRelativePath = (value: string): string =>
  value
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("/");

const sanitizeFilenamePreserveExtension = (value: string, fallback: string): string => {
  const extension = path.extname(value).toLowerCase();
  const basename = extension ? value.slice(0, -extension.length) : value;
  const token = sanitizeFileToken(basename) || sanitizeFileToken(fallback) || "file";
  return `${token}${extension}`;
};

const asJsonObject = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const markdownToHtml = (markdownBody: string): string => {
  const lines = markdownBody.split(/\r?\n/);
  const chunks: string[] = [];
  let inList = false;

  const closeList = (): void => {
    if (inList) {
      chunks.push("</ul>");
      inList = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      closeList();
      continue;
    }

    if (line.startsWith("### ")) {
      closeList();
      chunks.push(`<h3>${escapeHtml(line.slice(4))}</h3>`);
      continue;
    }

    if (line.startsWith("## ")) {
      closeList();
      chunks.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
      continue;
    }

    if (line.startsWith("# ")) {
      closeList();
      chunks.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
      continue;
    }

    if (line.startsWith("- ") || line.startsWith("* ")) {
      if (!inList) {
        chunks.push("<ul>");
        inList = true;
      }
      chunks.push(`<li>${escapeHtml(line.slice(2))}</li>`);
      continue;
    }

    closeList();
    chunks.push(`<p>${escapeHtml(line)}</p>`);
  }

  closeList();
  return chunks.join("\n");
};

const buildPdfHtml = (title: string, markdownBody: string, template: string): string => {
  const bodyHtml = markdownToHtml(markdownBody);
  const themeClass = template === "brief" ? "theme-brief" : "theme-default";
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light; }
      body {
        font-family: "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
        color: #1f2933;
        margin: 0;
        padding: 0;
        background: #f5f1e8;
      }
      .page {
        max-width: 820px;
        margin: 0 auto;
        padding: 48px 56px 64px;
        background: #fffdf8;
      }
      .theme-brief .cover {
        border-bottom: 2px solid #c9b8a2;
        margin-bottom: 28px;
        padding-bottom: 18px;
      }
      h1 { font-size: 28px; margin: 0 0 18px; }
      h2 { font-size: 20px; margin: 28px 0 12px; }
      h3 { font-size: 16px; margin: 20px 0 10px; }
      p, li { font-size: 13px; line-height: 1.75; }
      ul { margin: 0; padding-left: 20px; }
      .meta { color: #52606d; font-size: 12px; }
    </style>
  </head>
  <body class="${themeClass}">
    <main class="page">
      <section class="cover">
        <h1>${escapeHtml(title)}</h1>
        <div class="meta">Generated by OpenClaw Local Manus</div>
      </section>
      ${bodyHtml}
    </main>
  </body>
</html>`;
};

const normalizeHeaders = (
  value: unknown,
  fallback: Record<string, string> = {}
): Record<string, string> => {
  const candidate = asJsonObject(value);
  return Object.entries({ ...fallback, ...candidate }).reduce<Record<string, string>>(
    (accumulator, [key, headerValue]) => {
      if (typeof headerValue === "string") {
        accumulator[key] = headerValue;
      }
      return accumulator;
    },
    {}
  );
};

const collectFilesRecursive = async (rootDir: string): Promise<string[]> => {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFilesRecursive(absolutePath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
};

const inferArtifactTypeFromPath = (filePath: string) => {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".pdf") {
    return "pdf";
  }
  if (extension === ".md") {
    return "markdown";
  }
  if (extension === ".docx") {
    return "document";
  }
  if (extension === ".pptx") {
    return "presentation";
  }
  if (extension === ".xlsx" || extension === ".xls" || extension === ".csv") {
    return "spreadsheet";
  }
  if (extension === ".json") {
    return "json";
  }
  if (extension === ".txt") {
    return "text";
  }
  return "generic";
};

const stripMarkdownFormatting = (value: string): string =>
  value
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>#-]/g, "")
    .trim();

const splitMarkdownSections = (markdownBody: string): Array<{ heading: string; body: string }> => {
  const lines = markdownBody.split(/\r?\n/);
  const sections: Array<{ heading: string; body: string }> = [];
  let currentHeading = "内容";
  let currentLines: string[] = [];

  const pushCurrent = () => {
    if (currentLines.length === 0 && sections.length > 0) {
      return;
    }
    sections.push({
      heading: currentHeading,
      body: currentLines.join("\n").trim()
    });
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,6}\s+/.test(trimmed)) {
      pushCurrent();
      currentHeading = trimmed.replace(/^#{1,6}\s+/, "").trim() || "内容";
      currentLines = [];
      continue;
    }
    currentLines.push(line);
  }
  pushCurrent();

  return sections.filter((section) => section.heading || section.body);
};

const buildArtifactValidation = (
  filePath: string,
  preview: string,
  issues: string[] = []
): JsonObject => ({
  artifactType: inferArtifactTypeFromPath(filePath),
  validated: issues.length === 0 && preview.trim().length > 0,
  issues,
  preview: trimText(preview, 1000)
});

type NormalizedSection = {
  heading: string;
  body: string;
};

type NormalizedTable = {
  title: string;
  columns: string[];
  rows: string[][];
};

const normalizeSections = (request: ToolRequest, body: string): NormalizedSection[] => {
  const provided = Array.isArray(request.input["sections"]) ? request.input["sections"] : [];
  const normalized = provided
    .map((item) => asJsonObject(item))
    .map((item) => ({
      heading: asString(item["heading"], "内容"),
      body: asString(item["body"])
    }))
    .filter((item) => item.heading.trim().length > 0 || item.body.trim().length > 0);

  if (normalized.length > 0) {
    return normalized;
  }

  return splitMarkdownSections(body).map((section) => ({
    heading: section.heading,
    body: section.body
  }));
};

const normalizeTables = (request: ToolRequest): NormalizedTable[] => {
  const provided = Array.isArray(request.input["tables"]) ? request.input["tables"] : [];
  return provided
    .map((item) => asJsonObject(item))
    .map((item) => {
      const title = asString(item["title"], "Table");
      const columns = Array.isArray(item["columns"])
        ? item["columns"].map((value) => String(value))
        : [];
      const rows = Array.isArray(item["rows"])
        ? item["rows"]
            .map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : []))
            .filter((row) => row.length > 0)
        : [];
      return { title, columns, rows };
    })
    .filter((table) => table.columns.length > 0 || table.rows.length > 0);
};

const extractTextPreviewFromSections = (
  title: string,
  sections: NormalizedSection[],
  body: string
): string => {
  if (sections.length === 0) {
    return trimText(`${title}\n\n${body}`, 1_200);
  }

  return trimText(
    [
      title,
      ...sections.flatMap((section) => [section.heading, section.body].filter(Boolean))
    ].join("\n\n"),
    1_200
    );
};

const buildBrowserOutput = (base: {
  currentUrl: string;
  pageTitle: string;
  browserProfileId: string;
  profileDir: string;
  canonicalUrl?: string | null;
  downloadDir?: string;
  storageStatePath?: string;
  downloadedFile?: string;
  extractedText?: string;
}): JsonObject => ({
  currentUrl: base.currentUrl,
  pageTitle: base.pageTitle,
  browserProfileId: base.browserProfileId,
  profileDir: base.profileDir,
  ...(base.canonicalUrl ? { canonicalUrl: base.canonicalUrl } : {}),
  ...(base.downloadDir ? { downloadDir: base.downloadDir } : {}),
  ...(base.storageStatePath ? { storageStatePath: base.storageStatePath } : {}),
  ...(base.downloadedFile ? { downloadedFile: base.downloadedFile } : {}),
  ...(typeof base.extractedText === "string" ? { extractedText: base.extractedText } : {})
});

export class SearchTool implements Tool {
  readonly name = ToolName.Search;

  constructor(
    private readonly llmClient: OpenAIResponsesClient,
    private readonly options: SearchToolOptions
  ) {}

  async execute(request: ToolRequest): Promise<ToolResponse> {
    const query = asString(request.input["query"], request.taskId);

    if (this.options.mode !== "live" || !this.llmClient.isConfigured()) {
      return {
        status: "success",
        summary: `Collected mock web results for query: ${query}`,
        output: {
          answer: `Synthetic search answer for ${query}`,
          results: [
            {
              title: "Mock competitor profile",
              url: "https://example.com/mock-competitor",
              snippet: `Synthetic search result for ${query}`
            },
            {
              title: "Regional market overview",
              url: "https://market.example/regional-overview",
              snippet: `Regional market overview and demand signals related to ${query}`
            },
            {
              title: "Official guidance",
              url: "https://gov.example/official-guidance",
              snippet: `Official guidance and regulatory considerations relevant to ${query}`
            },
            {
              title: "Industry setup playbook",
              url: "https://industry.example/setup-playbook",
              snippet: `Industry setup, licensing, and operational guidance related to ${query}`
            }
          ]
        },
        metrics: {
          durationMs: 5
        }
      };
    }

    const startedAt = Date.now();
    try {
      const searchParams: {
        query: string;
        stage: "research";
        allowedDomains?: string[];
      } = {
        query: [
          "Perform a best-effort web search using fresh public web sources.",
          "Do not ask the user clarifying questions.",
          "If the request is ambiguous, choose the broadest reasonable interpretation and return source-backed results anyway.",
          "Prefer authoritative and recent sources.",
          "",
          `Query: ${query}`
        ].join("\n"),
        stage: "research"
      };
      if (this.options.allowedDomains) {
        searchParams.allowedDomains = this.options.allowedDomains;
      }

      const result = await this.llmClient.searchWeb(searchParams);

      return {
        status: "success",
        summary: `Collected ${result.sources.length} web results for query: ${query}`,
        output: {
          answer: result.outputText,
          results: result.sources.map((source) => ({
            title: source.title,
            url: source.url,
            snippet: source.snippet
          }))
        },
        metrics: {
          durationMs: Date.now() - startedAt
        }
      };
    } catch (error: unknown) {
      return normalizeToolFailure(
        `OpenAI web search failed: ${error instanceof Error ? error.message : String(error)}`,
        ErrorCode.NetworkError,
        true
      );
    }
  }
}

export class BrowserTool implements Tool {
  readonly name = ToolName.Browser;

  constructor(
    private readonly workspaceManager: WorkspaceManager,
    private readonly options: BrowserToolOptions
  ) {}

  async execute(request: ToolRequest): Promise<ToolResponse> {
    const action = request.action;
    if (!["open", "extract", "click", "type", "wait_for", "download", "screenshot", "save_storage_state", "load_storage_state"].includes(action)) {
      return normalizeToolFailure(
        `Unsupported browser action: ${action}`,
        ErrorCode.InvalidInput,
        false
      );
    }

    const url = asString(request.input["url"]);
    if (!url) {
      return normalizeToolFailure("Browser tool requires a url", ErrorCode.InvalidInput, false);
    }

    if (this.options.mode !== "live") {
      return {
        status: "success",
        summary: `Prepared mock browser action ${action} for ${url}`,
        output: {
          currentUrl: url,
          pageTitle: "Mock Competitor",
          extractedText:
            "Synthetic browser extraction: pricing, fleet mix, airport delivery, and monthly packages."
        },
        metrics: {
          durationMs: 8
        }
      };
    }

    const startedAt = Date.now();
    const { chromium } = await import("playwright");
    let persistentContext: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
    let page:
      | Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launchPersistentContext>>["newPage"]>>
      | undefined;
    let taskDir = "";
    try {
      taskDir = await this.workspaceManager.ensureTaskWorkspace(request.taskId);
      const profileId =
        request.browserProfileId ?? asString(request.input["browserProfileId"], "default");
      const profileRootDir =
        this.options.profileRootDir ?? path.join(taskDir, "profiles");
      const profileDir = path.join(profileRootDir, sanitizeFileToken(profileId) || "default");
      await fs.mkdir(profileDir, { recursive: true });

      const defaultDownloadDir = path.join(
        taskDir,
        "downloads",
        sanitizeFileToken(request.stepId || "step")
      );
      const requestedDownloadDir = sanitizeRelativePath(
        request.downloadDir ?? asString(request.input["downloadDir"])
      );
      const downloadDir = requestedDownloadDir
        ? path.join(taskDir, requestedDownloadDir)
        : defaultDownloadDir;
      await fs.mkdir(downloadDir, { recursive: true });

      persistentContext = await chromium.launchPersistentContext(profileDir, {
        headless: this.options.headless ?? true,
        acceptDownloads: true,
        ...(this.options.channel ? { channel: this.options.channel as "chrome" | "msedge" } : {}),
        ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {})
      });

      page = persistentContext.pages()[0] ?? (await persistentContext.newPage());
      const activePage = page;
      if (!activePage) {
        return normalizeToolFailure(
          "Playwright browser did not create a page",
          ErrorCode.ToolUnavailable,
          true
        );
      }
      if (action === "load_storage_state") {
        const relativeStoragePath = sanitizeRelativePath(
          asString(request.input["storageStatePath"], "browser/storage-state.json")
        );
        const storageStatePath = path.join(taskDir, relativeStoragePath);
        const raw = await fs.readFile(storageStatePath, "utf8");
        const storageState = JSON.parse(raw) as {
          cookies?: Array<Record<string, unknown>>;
          origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
        };
        if (Array.isArray(storageState.cookies) && storageState.cookies.length > 0) {
          await persistentContext.addCookies(
            storageState.cookies as unknown as Parameters<typeof persistentContext.addCookies>[0]
          );
        }
        if (Array.isArray(storageState.origins) && storageState.origins.length > 0) {
          await activePage.addInitScript((origins) => {
            for (const originEntry of origins) {
              if (!originEntry || typeof originEntry.origin !== "string") {
                continue;
              }
              const browserWindow = globalThis as {
                location?: { origin?: string };
                localStorage?: { setItem: (name: string, value: string) => void };
              };
              if (browserWindow.location?.origin !== originEntry.origin) {
                continue;
              }
              if (!Array.isArray(originEntry.localStorage)) {
                continue;
              }
              for (const pair of originEntry.localStorage) {
                if (pair && typeof pair.name === "string" && typeof pair.value === "string") {
                  browserWindow.localStorage?.setItem(pair.name, pair.value);
                }
              }
            }
          }, storageState.origins);
        }
      }
        await activePage.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: this.options.navigationTimeoutMs ?? 30_000
        });

        const canonicalUrl = await activePage
          .locator("link[rel='canonical']")
          .getAttribute("href")
          .catch(() => null);

        if (action === "open") {
          return {
            status: "success",
            summary: `Opened ${url}`,
            output: buildBrowserOutput({
              currentUrl: activePage.url(),
              pageTitle: await activePage.title(),
              canonicalUrl,
              browserProfileId: profileId,
              profileDir
            }),
            metrics: {
              durationMs: Date.now() - startedAt
            }
          };
        }

        if (action === "save_storage_state") {
          const relativeStoragePath = sanitizeRelativePath(
            asString(request.input["storageStatePath"], "browser/storage-state.json")
          );
          const storageStatePath = path.join(taskDir, relativeStoragePath);
          await fs.mkdir(path.dirname(storageStatePath), { recursive: true });
          await persistentContext.storageState({ path: storageStatePath });
          return {
            status: "success",
            summary: `Saved browser storage state for ${url}`,
            output: buildBrowserOutput({
              currentUrl: activePage.url(),
              pageTitle: await activePage.title(),
              canonicalUrl,
              browserProfileId: profileId,
              profileDir,
              storageStatePath
            }),
            artifacts: [storageStatePath],
            metrics: {
              durationMs: Date.now() - startedAt
            }
          };
        }

        if (action === "click") {
          const selector = asString(request.input["selector"]);
          if (!selector) {
            return normalizeToolFailure(
              "Browser click action requires a selector",
              ErrorCode.InvalidInput,
              false
            );
          }
          await activePage.click(selector, {
            timeout: request.timeoutMs ?? this.options.navigationTimeoutMs ?? 30_000
          });
          return {
            status: "success",
            summary: `Clicked ${selector} on ${url}`,
            output: buildBrowserOutput({
              currentUrl: activePage.url(),
              pageTitle: await activePage.title(),
              canonicalUrl,
              browserProfileId: profileId,
              profileDir
            }),
            metrics: {
              durationMs: Date.now() - startedAt
            }
          };
        }

        if (action === "type") {
          const selector = asString(request.input["selector"]);
          const text = asString(request.input["text"]);
          if (!selector || !text) {
            return normalizeToolFailure(
              "Browser type action requires selector and text",
              ErrorCode.InvalidInput,
              false
            );
          }
          await activePage.fill(selector, text, {
            timeout: request.timeoutMs ?? this.options.navigationTimeoutMs ?? 30_000
          });
          return {
            status: "success",
            summary: `Typed into ${selector} on ${url}`,
            output: buildBrowserOutput({
              currentUrl: activePage.url(),
              pageTitle: await activePage.title(),
              canonicalUrl,
              browserProfileId: profileId,
              profileDir
            }),
            metrics: {
              durationMs: Date.now() - startedAt
            }
          };
        }

        if (action === "wait_for") {
          const selector = asString(request.input["selector"]);
          if (!selector) {
            return normalizeToolFailure(
              "Browser wait_for action requires a selector",
              ErrorCode.InvalidInput,
              false
            );
          }
          await activePage.waitForSelector(selector, {
            timeout: request.timeoutMs ?? this.options.navigationTimeoutMs ?? 30_000
          });
          return {
            status: "success",
            summary: `Waited for ${selector} on ${url}`,
            output: buildBrowserOutput({
              currentUrl: activePage.url(),
              pageTitle: await activePage.title(),
              canonicalUrl,
              browserProfileId: profileId,
              profileDir
            }),
            metrics: {
              durationMs: Date.now() - startedAt
            }
          };
        }

        if (action === "download") {
          const selector = asString(request.input["selector"]);
          if (!selector) {
            return normalizeToolFailure(
              "Browser download action requires a selector",
              ErrorCode.InvalidInput,
              false
            );
          }
          const downloadPromise = activePage.waitForEvent("download", {
            timeout: request.timeoutMs ?? this.options.navigationTimeoutMs ?? 30_000
          });
          await activePage.click(selector, {
            timeout: request.timeoutMs ?? this.options.navigationTimeoutMs ?? 30_000
          });
          const download = await downloadPromise;
          const requestedFilename = asString(request.input["outputFilename"]);
          const filename = sanitizeFilenamePreserveExtension(
            requestedFilename || download.suggestedFilename(),
            "download"
          );
          const savedPath = path.join(downloadDir, filename);
          await download.saveAs(savedPath);

          return {
            status: "success",
            summary: `Downloaded file from ${url}`,
            output: buildBrowserOutput({
              currentUrl: activePage.url(),
              pageTitle: await activePage.title(),
              canonicalUrl,
              browserProfileId: profileId,
              profileDir,
              downloadDir,
              downloadedFile: savedPath
            }),
            artifacts: [savedPath],
            metrics: {
              durationMs: Date.now() - startedAt
            }
          };
        }

        const shouldScreenshot =
          action === "screenshot" ||
          (typeof request.input["takeScreenshot"] === "boolean"
            ? Boolean(request.input["takeScreenshot"])
            : this.options.defaultScreenshot ?? true);
        const artifactSuffix = sanitizeFileToken(asString(request.input["artifactSuffix"]));
        const screenshotPath = shouldScreenshot
          ? path.join(
              taskDir,
              "screenshots",
              `${request.stepId}${artifactSuffix ? `-${artifactSuffix}` : ""}.png`
            )
          : undefined;

        if (screenshotPath) {
          await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
          await activePage.screenshot({
            path: screenshotPath,
            fullPage: true
          });
        }

        if (action === "screenshot") {
          return {
            status: "success",
            summary: `Captured screenshot for ${url}`,
            output: buildBrowserOutput({
              currentUrl: activePage.url(),
              pageTitle: await activePage.title(),
              canonicalUrl,
              browserProfileId: profileId,
              profileDir
            }),
            ...(screenshotPath ? { artifacts: [screenshotPath] } : {}),
            metrics: {
              durationMs: Date.now() - startedAt
            }
          };
        }

        const selector = asString(request.input["selector"], "body");
        const locator = activePage.locator(selector);
        const rawText =
          (await locator
            .innerText({
              timeout: 5_000
            })
            .catch(async () => (await activePage.locator("body").textContent()) ?? "")) ?? "";
        const extractedText = trimText(
          rawText,
          typeof request.input["maxChars"] === "number"
            ? Number(request.input["maxChars"])
            : this.options.maxExtractedChars ?? 12_000
        );

        const output = buildBrowserOutput({
          currentUrl: activePage.url(),
          canonicalUrl,
          pageTitle: await activePage.title(),
          extractedText,
          browserProfileId: profileId,
          profileDir,
          downloadDir
        });

        return {
          status: "success",
          summary: `Extracted browser content from ${url}`,
          output,
          ...(screenshotPath ? { artifacts: [screenshotPath] } : {}),
          metrics: {
            durationMs: Date.now() - startedAt
          }
        };
    } catch (error: unknown) {
      const failureScreenshotPath =
        taskDir && request.stepId
          ? path.join(taskDir, "screenshots", `${request.stepId}-failure.png`)
          : undefined;
      if (page !== undefined && failureScreenshotPath) {
        try {
          await fs.mkdir(path.dirname(failureScreenshotPath), { recursive: true });
          await page.screenshot({
            path: failureScreenshotPath,
            fullPage: true
          });
        } catch {
          // Best effort failure evidence only.
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      const response = normalizeToolFailure(
        `Playwright browser execution failed: ${message}`,
        ErrorCode.ToolUnavailable,
        true
      );
      if (failureScreenshotPath) {
        response.artifacts = [failureScreenshotPath];
      }
      return response;
    } finally {
      if (persistentContext) {
        await persistentContext.close().catch(() => {});
      }
    }
  }
}

export class PythonTool implements Tool {
  readonly name = ToolName.Python;

  constructor(
    private readonly workspaceManager: WorkspaceManager,
    private readonly options: PythonToolOptions
  ) {}

  async execute(request: ToolRequest): Promise<ToolResponse> {
    if (request.action !== "run_script") {
      return normalizeToolFailure(
        `Unsupported python action: ${request.action}`,
        ErrorCode.InvalidInput,
        false
      );
    }

    const code = asString(request.input["code"]);
    if (!code.trim()) {
      return normalizeToolFailure("Python tool requires non-empty code", ErrorCode.InvalidInput, false);
    }

    const filenameToken = sanitizeFileToken(asString(request.input["filename"], request.stepId));
    const filename = `${filenameToken || "script"}.py`;

    if (this.options.mode !== "live") {
      const taskDir = await this.workspaceManager.ensureTaskWorkspace(request.taskId);
      const sandboxDir = path.join(taskDir, "python", sanitizeFileToken(request.stepId || "step"));
      await fs.mkdir(sandboxDir, { recursive: true });
      const scriptPath = path.join(sandboxDir, filename);
      await fs.writeFile(scriptPath, code, "utf8");

      const requestedInputFiles =
        Array.isArray(request.inputFiles) && request.inputFiles.length > 0
          ? request.inputFiles.map(String)
          : [];
      const generatedFiles: string[] = [];
      const jsonPath = path.join(sandboxDir, "analysis.json");
      const markdownPath = path.join(sandboxDir, "summary.md");
      await fs.writeFile(
        jsonPath,
        JSON.stringify(
          {
            mode: "mock",
            taskId: request.taskId,
            stepId: request.stepId ?? "step",
            inputFiles: requestedInputFiles
          },
          null,
          2
        ),
        "utf8"
      );
      await fs.writeFile(
        markdownPath,
        [
          `# Mock Python Output`,
          ``,
          `- taskId: ${request.taskId}`,
          `- stepId: ${request.stepId ?? "step"}`,
          ...(requestedInputFiles.length > 0
            ? [`- inputFiles: ${requestedInputFiles.join(", ")}`]
            : [`- inputFiles: none`])
        ].join("\n"),
        "utf8"
      );
      generatedFiles.push(jsonPath, markdownPath);

      if (/brief\.pdf|\.pdf\b/i.test(code) || /pdf/i.test(filenameToken)) {
        const pdfPath = path.join(sandboxDir, "brief.pdf");
        await fs.writeFile(pdfPath, "Mock PDF artifact", "utf8");
        generatedFiles.push(pdfPath);
      }

      return {
        status: "success",
        summary: `Prepared mock python execution for ${filename}`,
        output: {
          scriptPath,
          stdout: "mock python execution",
          stderr: "",
          exitCode: 0,
          inputFiles: requestedInputFiles,
          generatedFiles
        },
        artifacts: [scriptPath, ...generatedFiles],
        metrics: {
          durationMs: 5
        }
      };
    }

    const taskDir = await this.workspaceManager.ensureTaskWorkspace(request.taskId);
    const sandboxDir = path.join(taskDir, "python", sanitizeFileToken(request.stepId || "step"));
    await fs.mkdir(sandboxDir, { recursive: true });

    const scriptPath = path.join(sandboxDir, filename);
    await fs.writeFile(scriptPath, code, "utf8");

    const inputFiles = asJsonObject(request.input["files"]);
    for (const [relativePath, contents] of Object.entries(inputFiles)) {
      if (typeof contents !== "string") {
        continue;
      }
      const safeRelativePath = sanitizeRelativePath(relativePath);
      if (!safeRelativePath) {
        continue;
      }
      const destination = path.join(sandboxDir, safeRelativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, contents, "utf8");
    }

    const externalInputFiles = Array.isArray(request.inputFiles)
      ? request.inputFiles
      : Array.isArray(request.input["inputFiles"])
        ? request.input["inputFiles"].map(String)
        : [];
    const copiedInputFiles: string[] = [];
    for (const sourceFile of externalInputFiles) {
      const resolvedSource = path.resolve(String(sourceFile));
      const fileName = sanitizeFilenamePreserveExtension(path.basename(resolvedSource), "input");
      const destination = path.join(sandboxDir, "inputs", fileName);
      try {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(resolvedSource, destination);
        copiedInputFiles.push(destination);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return normalizeToolFailure(
          `Python sandbox could not access input file ${resolvedSource}: ${message}`,
          ErrorCode.InvalidInput,
          false
        );
      }
    }

    const pythonExecutable =
      this.options.pythonExecutable ??
      process.env.OPENCLAW_PYTHON_EXECUTABLE ??
      "python3";
    const args = Array.isArray(request.input["args"])
      ? request.input["args"].map((item) => String(item))
      : [];

    const startedAt = Date.now();
    const beforeFiles = new Set(await collectFilesRecursive(sandboxDir));
    const disableUserSite =
      this.options.disableUserSite ?? process.env.OPENCLAW_PYTHON_DISABLE_USER_SITE === "1";

    const maxCpuSeconds =
      this.options.maxCpuSeconds ?? Number(process.env.OPENCLAW_PYTHON_MAX_CPU_SECONDS ?? 60);
    const maxMemoryMb =
      this.options.maxMemoryMb ?? Number(process.env.OPENCLAW_PYTHON_MAX_MEMORY_MB ?? 512);

    const isLinux = process.platform === "linux";
    const ulimitParts: string[] = [];
    if (maxCpuSeconds > 0) {
      ulimitParts.push(`ulimit -t ${maxCpuSeconds}`);
    }
    if (isLinux && maxMemoryMb > 0) {
      ulimitParts.push(`ulimit -v ${maxMemoryMb * 1024}`);
    }

    const useUlimitWrapper = ulimitParts.length > 0;
    const spawnCommand = useUlimitWrapper ? "/bin/bash" : pythonExecutable;
    const spawnArgs = useUlimitWrapper
      ? ["-c", `${ulimitParts.join(" && ")} && exec ${pythonExecutable} ${[scriptPath, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`]
      : [scriptPath, ...args];

    try {
      const result = await new Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(spawnCommand, spawnArgs, {
          cwd: sandboxDir,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            ...(disableUserSite ? { PYTHONNOUSERSITE: "1" } : {}),
            PYTHONDONTWRITEBYTECODE: "1"
          },
          stdio: ["ignore", "pipe", "pipe"]
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        const timeoutMs =
          request.timeoutMs ?? this.options.timeoutMs ?? Number(process.env.OPENCLAW_PYTHON_TIMEOUT_MS ?? 30_000);
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`Python execution timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout.on("data", (chunk: Buffer | string) => {
          stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
          stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timeout);
          resolve({
            exitCode: code ?? 0,
            stdout: trimText(
              Buffer.concat(stdoutChunks).toString("utf8"),
              this.options.maxStdoutChars ?? 12_000
            ),
            stderr: trimText(
              Buffer.concat(stderrChunks).toString("utf8"),
              this.options.maxStderrChars ?? 12_000
            ),
            });
        });
      });

      const afterFiles = await collectFilesRecursive(sandboxDir);
      const generatedFiles = afterFiles.filter((filePath) => !beforeFiles.has(filePath));
      const artifacts = [scriptPath, ...generatedFiles].filter((filePath) => !filePath.endsWith(".pyc"));

      if (result.exitCode !== 0) {
        return normalizeToolFailure(
          `Python sandbox exited with code ${result.exitCode}: ${result.stderr || result.stdout}`,
          ErrorCode.ToolUnavailable,
          true
        );
      }

      return {
        status: "success",
        summary: `Executed python script ${filename}`,
        output: {
          scriptPath,
          sandboxDir,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          generatedFiles,
          inputFiles: copiedInputFiles
        },
        artifacts,
        metrics: {
          durationMs: Date.now() - startedAt
        }
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const timeout = message.toLowerCase().includes("timed out");
      return normalizeToolFailure(
        `Python sandbox execution failed: ${message}`,
        timeout ? ErrorCode.Timeout : ErrorCode.ToolUnavailable,
        true
      );
    }
  }
}

export class FilesystemTool implements Tool {
  readonly name = ToolName.Filesystem;

  async execute(request: ToolRequest): Promise<ToolResponse> {
    if (request.action !== "write_file") {
      return normalizeToolFailure(
        `Unsupported filesystem action: ${request.action}`,
        ErrorCode.InvalidInput,
        false
      );
    }

    const filePath = String(request.input["filePath"]);
    const contents = String(request.input["contents"]);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents, "utf8");

    return {
      status: "success",
      summary: `Wrote file ${filePath}`,
      artifacts: [filePath],
      metrics: {
        durationMs: 5
      }
    };
  }
}

export interface DocumentToolOptions {
  llmClient?: OpenAIResponsesClient;
  mode?: ToolExecutionMode;
  headless?: boolean;
  channel?: string;
  executablePath?: string;
}

export class DocumentTool implements Tool {
  readonly name = ToolName.Document;

  constructor(
    private readonly workspaceManager: WorkspaceManager,
    private readonly options: DocumentToolOptions = {}
  ) {}

  async execute(request: ToolRequest): Promise<ToolResponse> {
    if (
      ![
        "render_markdown",
        "render_pdf",
        "render_docx",
        "render_pptx",
        "render_xlsx"
      ].includes(request.action)
    ) {
      return normalizeToolFailure(
        `Unsupported document action: ${request.action}`,
        ErrorCode.InvalidInput,
        false
      );
    }

    const filename = String(request.input["filename"] ?? "report.md");
    const title = String(request.input["title"] ?? "Task Output");
    const body = String(request.input["body"] ?? request.input["markdownBody"] ?? "");
    const generationPrompt = asString(request.input["generationPrompt"]);
    const useLlm =
      this.options.mode === "live" &&
      this.options.llmClient?.isConfigured() &&
      generationPrompt.length > 0;

    const renderedBody = useLlm
      ? await this.renderWithOpenAI(title, body, generationPrompt)
      : body;
    const sections = normalizeSections(request, renderedBody);
    const tables = normalizeTables(request);
    const preview = extractTextPreviewFromSections(title, sections, renderedBody);

    if (request.action === "render_pdf") {
      const outputFilename = sanitizeFilenamePreserveExtension(
        asString(request.input["outputFilename"], "report.pdf"),
        "report"
      );
      const template = asString(request.input["template"], "default");
      const html = buildPdfHtml(title, renderedBody, template);
      const filePath = await this.renderPdf(request.taskId, outputFilename, html);
      const artifactValidation = buildArtifactValidation(filePath, preview);

      return {
        status: "success",
        summary: `Rendered PDF document at ${filePath}`,
        artifacts: [filePath],
        output: {
          filePath,
          outputFilename,
          template,
          artifactValidation
        },
        metrics: {
          durationMs: 10
        }
      };
    }

    if (request.action === "render_docx") {
      const outputFilename = sanitizeFilenamePreserveExtension(
        asString(request.input["outputFilename"], "report.docx"),
        "report"
      );
      const filePath = await this.renderDocx(request.taskId, outputFilename, title, sections);
      const artifactValidation = buildArtifactValidation(filePath, preview);

      return {
        status: "success",
        summary: `Rendered DOCX document at ${filePath}`,
        artifacts: [filePath],
        output: {
          filePath,
          outputFilename,
          artifactValidation
        },
        metrics: {
          durationMs: 12
        }
      };
    }

    if (request.action === "render_pptx") {
      const outputFilename = sanitizeFilenamePreserveExtension(
        asString(request.input["outputFilename"], "brief.pptx"),
        "brief"
      );
      const filePath = await this.renderPptx(request.taskId, outputFilename, title, sections);
      const artifactValidation = buildArtifactValidation(filePath, preview);

      return {
        status: "success",
        summary: `Rendered PPTX presentation at ${filePath}`,
        artifacts: [filePath],
        output: {
          filePath,
          outputFilename,
          artifactValidation
        },
        metrics: {
          durationMs: 12
        }
      };
    }

    if (request.action === "render_xlsx") {
      const outputFilename = sanitizeFilenamePreserveExtension(
        asString(request.input["outputFilename"], "dataset.xlsx"),
        "dataset"
      );
      const filePath = await this.renderXlsx(
        request.taskId,
        outputFilename,
        title,
        sections,
        tables
      );
      const artifactValidation = buildArtifactValidation(filePath, preview);

      return {
        status: "success",
        summary: `Rendered XLSX workbook at ${filePath}`,
        artifacts: [filePath],
        output: {
          filePath,
          outputFilename,
          artifactValidation
        },
        metrics: {
          durationMs: 12
        }
      };
    }

    const rendered = `# ${title}\n\n${renderedBody}\n`;
    const filePath = await this.workspaceManager.writeTaskFile(request.taskId, filename, rendered);
    const artifactValidation = buildArtifactValidation(filePath, preview);

    return {
      status: "success",
      summary: `Rendered markdown document at ${filePath}`,
      artifacts: [filePath],
      output: {
        filePath,
        outputFilename: filename,
        artifactValidation
      },
      metrics: {
        durationMs: 10
      }
    };
  }

  private async renderWithOpenAI(
    title: string,
    body: string,
    generationPrompt: string
  ): Promise<string> {
    if (!this.options.llmClient) {
      return body;
    }

    const result = await this.options.llmClient.generateText({
      stage: "document",
      messages: [
        {
          role: "system",
          content:
            "You generate concise Markdown report bodies. Use only the supplied context. Do not emit a top-level title."
        },
        {
          role: "user",
          content: `Task title: ${title}\n\nInstructions:\n${generationPrompt}\n\nContext:\n${body}`
        }
      ],
      maxOutputTokens: 1_200
    });

    return result.outputText || body;
  }

  private async renderPdf(taskId: string, outputFilename: string, html: string): Promise<string> {
    const filePath = await this.workspaceManager.writeTaskBuffer(
      taskId,
      outputFilename,
      Buffer.from("%PDF-1.4\n% placeholder\n")
    );

    if (this.options.mode !== "live") {
      return filePath;
    }

    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: this.options.headless ?? true,
      ...(this.options.channel ? { channel: this.options.channel as "chrome" | "msedge" } : {}),
      ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {})
    });

    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "load" });
      await page.pdf({
        path: filePath,
        format: "A4",
        printBackground: true,
        margin: {
          top: "16mm",
          right: "12mm",
          bottom: "16mm",
          left: "12mm"
        }
      });
      return filePath;
    } finally {
      await browser.close();
    }
  }

  private async renderDocx(
    taskId: string,
    outputFilename: string,
    title: string,
    sections: NormalizedSection[]
  ): Promise<string> {
    const taskDir = await this.workspaceManager.ensureTaskWorkspace(taskId);
    const filePath = path.join(taskDir, outputFilename);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const children = [
      new Paragraph({
        text: title,
        heading: HeadingLevel.TITLE
      }),
      ...sections.flatMap((section) => {
        const paragraphs: Paragraph[] = [
          new Paragraph({
            text: section.heading,
            heading: HeadingLevel.HEADING_1
          })
        ];
        const bodyLines = section.body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        for (const line of bodyLines) {
          if (line.startsWith("- ") || line.startsWith("* ")) {
            paragraphs.push(
              new Paragraph({
                text: line.slice(2),
                bullet: { level: 0 }
              })
            );
          } else {
            paragraphs.push(
              new Paragraph({
                children: [new TextRun(line)]
              })
            );
          }
        }
        if (bodyLines.length === 0) {
          paragraphs.push(new Paragraph(""));
        }
        return paragraphs;
      })
    ];

    const document = new DocxDocument({
      sections: [
        {
          children
        }
      ]
    });
    const buffer = await Packer.toBuffer(document);
    await fs.writeFile(filePath, buffer);
    return filePath;
  }

  private async renderPptx(
    taskId: string,
    outputFilename: string,
    title: string,
    sections: NormalizedSection[]
  ): Promise<string> {
    const taskDir = await this.workspaceManager.ensureTaskWorkspace(taskId);
    const filePath = path.join(taskDir, outputFilename);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const presentation = new PptxGenJS();
    presentation.layout = "LAYOUT_WIDE";
    presentation.author = "OpenClaw Local Manus";
    presentation.subject = title;
    presentation.title = title;

    const titleSlide = presentation.addSlide();
    titleSlide.addText(title, {
      x: 0.5,
      y: 0.6,
      w: 12,
      h: 0.8,
      fontSize: 24,
      bold: true,
      color: "1f2933"
    });
    titleSlide.addText("Generated by OpenClaw Local Manus", {
      x: 0.5,
      y: 1.5,
      w: 6,
      h: 0.4,
      fontSize: 11,
      color: "52606d"
    });

    const normalizedSections = sections.length > 0 ? sections : [{ heading: "内容", body: "" }];
    for (const section of normalizedSections) {
      const slide = presentation.addSlide();
      slide.addText(section.heading, {
        x: 0.5,
        y: 0.4,
        w: 12,
        h: 0.6,
        fontSize: 20,
        bold: true,
        color: "102a43"
      });
      const bulletLines = section.body
        .split(/\r?\n/)
        .map((line) => line.replace(/^[-*]\s*/, "").trim())
        .filter(Boolean)
        .slice(0, 10);
      slide.addText(
        bulletLines.length > 0 ? bulletLines.map((line) => ({ text: line, options: { bullet: { indent: 18 } } })) : [{ text: "No additional content provided." }],
        {
          x: 0.8,
          y: 1.3,
          w: 11.2,
          h: 5.4,
          fontSize: 14,
          color: "243b53",
          breakLine: true,
          valign: "top",
          margin: 0.08
        }
      );
    }

    await presentation.writeFile({ fileName: filePath } as never);
    return filePath;
  }

  private async renderXlsx(
    taskId: string,
    outputFilename: string,
    title: string,
    sections: NormalizedSection[],
    tables: NormalizedTable[]
  ): Promise<string> {
    const taskDir = await this.workspaceManager.ensureTaskWorkspace(taskId);
    const filePath = path.join(taskDir, outputFilename);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "OpenClaw Local Manus";
    workbook.subject = title;
    workbook.title = title;

    if (tables.length > 0) {
      for (const table of tables) {
        const worksheet = workbook.addWorksheet(
          sanitizeFileToken(table.title).slice(0, 28) || "Table"
        );
        if (table.columns.length > 0) {
          worksheet.addRow(table.columns);
        }
        for (const row of table.rows) {
          worksheet.addRow(row);
        }
      }
    } else {
      const worksheet = workbook.addWorksheet("Report");
      worksheet.addRow([title]);
      worksheet.addRow([]);
      for (const section of sections) {
        worksheet.addRow([section.heading]);
        for (const line of section.body.split(/\r?\n/).filter(Boolean)) {
          worksheet.addRow([line.replace(/^[-*]\s*/, "").trim()]);
        }
        worksheet.addRow([]);
      }
    }

    const buffer = await workbook.xlsx.writeBuffer();
    await fs.writeFile(filePath, Buffer.from(buffer));
    return filePath;
  }
}

export class ActionTool implements Tool {
  readonly name = ToolName.Action;

  constructor(private readonly options: ActionToolOptions) {}

  async execute(request: ToolRequest): Promise<ToolResponse> {
    if (
      ![
        "post_webhook",
        "send_webhook",
        "send_email",
        "send_slack",
        "create_notion_page"
      ].includes(request.action)
    ) {
      return normalizeToolFailure(
        `Unsupported action tool action: ${request.action}`,
        ErrorCode.InvalidInput,
        false
      );
    }

    if (request.action === "send_email") {
      return this.sendEmail(request);
    }

    if (request.action === "send_slack") {
      return this.sendSlack(request);
    }

    if (request.action === "create_notion_page") {
      return this.createNotionPage(request);
    }

    return this.sendWebhook(request);
  }

  private async sendWebhook(request: ToolRequest): Promise<ToolResponse> {
    const url = asString(request.input["url"], this.options.defaultUrl ?? "");
    if (!url) {
      return normalizeToolFailure(
        "Action tool requires a webhook url",
        ErrorCode.InvalidInput,
        false
      );
    }

    const method = asString(request.input["method"], "POST").toUpperCase();
    const headers = normalizeHeaders(request.input["headers"], {
      "content-type": "application/json",
      ...(this.options.defaultHeaders ?? {})
    });
    const payload = request.input["payload"];

    if (this.options.mode !== "live" || request.input["dryRun"] === true) {
      return {
        status: "success",
        summary: `Prepared mock ${method} webhook call to ${url}`,
        output: {
          url,
          method,
          deliveryKind: "webhook",
          ...(payload === undefined ? {} : { payload })
        },
        metrics: {
          durationMs: 5
        }
      };
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);

    try {
      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal
      };
      if (payload !== undefined) {
        init.body = JSON.stringify(payload);
      }

      const response = await fetch(url, init);
      const responseText = trimText(await response.text(), 4_000);

      if (!response.ok) {
        return normalizeToolFailure(
          `Webhook returned HTTP ${response.status}: ${responseText}`,
          ErrorCode.NetworkError,
          true
        );
      }

      return {
        status: "success",
        summary: `Executed ${method} webhook call to ${url}`,
        output: {
          deliveryKind: "webhook",
          url,
          method,
          statusCode: response.status,
          responseBody: responseText
        },
        metrics: {
          durationMs: Date.now() - startedAt
        }
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout =
        error instanceof Error &&
        (error.name === "AbortError" || message.toLowerCase().includes("abort"));

      return normalizeToolFailure(
        `Action tool request failed: ${message}`,
        isTimeout ? ErrorCode.Timeout : ErrorCode.NetworkError,
        true
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async sendEmail(request: ToolRequest): Promise<ToolResponse> {
    const smtp = this.options.smtp ?? {};
    const to = asString(request.input["to"]);
    const subject = asString(request.input["subject"], "OpenClaw Local Manus notification");
    const text = asString(request.input["text"], asString(request.input["body"]));
    const html = asString(request.input["html"]);

    if (!to) {
      return normalizeToolFailure(
        "Action tool requires an email recipient",
        ErrorCode.InvalidInput,
        false
      );
    }

    if (this.options.mode !== "live" || request.input["dryRun"] === true) {
      return {
        status: "success",
        summary: `Prepared mock email to ${to}`,
        output: {
          deliveryKind: "email",
          to,
          subject
        },
        metrics: {
          durationMs: 5
        }
      };
    }

    if (!smtp.host || !smtp.port || !smtp.from) {
      return normalizeToolFailure(
        "SMTP configuration is incomplete for send_email",
        ErrorCode.InvalidInput,
        false
      );
    }

    try {
      const startedAt = Date.now();
      const transport = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure ?? false,
        ...(smtp.user && smtp.pass
          ? {
              auth: {
                user: smtp.user,
                pass: smtp.pass
              }
            }
          : {})
      });
      const receipt = await transport.sendMail({
        from: smtp.from,
        to,
        subject,
        text: text || stripMarkdownFormatting(html),
        ...(html ? { html } : {})
      });

      return {
        status: "success",
        summary: `Sent email to ${to}`,
        output: {
          deliveryKind: "email",
          to,
          subject,
          messageId: receipt.messageId,
          accepted: receipt.accepted.map((entry) =>
            typeof entry === "string" ? entry : entry.address ?? String(entry)
          )
        },
        metrics: {
          durationMs: Date.now() - startedAt
        }
      };
    } catch (error: unknown) {
      return normalizeToolFailure(
        `Email delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        ErrorCode.NetworkError,
        true
      );
    }
  }

  private async sendSlack(request: ToolRequest): Promise<ToolResponse> {
    const url = asString(request.input["url"], this.options.slackWebhookUrl ?? "");
    const text = asString(request.input["text"], asString(request.input["body"]));
    const blocks = request.input["blocks"];

    if (!url) {
      return normalizeToolFailure(
        "Slack webhook url is required",
        ErrorCode.InvalidInput,
        false
      );
    }

    if (this.options.mode !== "live" || request.input["dryRun"] === true) {
      return {
        status: "success",
        summary: `Prepared mock Slack notification`,
        output: {
          deliveryKind: "slack",
          url,
          text
        },
        metrics: {
          durationMs: 5
        }
      };
    }

    const startedAt = Date.now();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        text,
        ...(Array.isArray(blocks) ? { blocks } : {})
      })
    });
    const responseText = trimText(await response.text(), 4_000);
    if (!response.ok) {
      return normalizeToolFailure(
        `Slack webhook returned HTTP ${response.status}: ${responseText}`,
        ErrorCode.NetworkError,
        true
      );
    }

    return {
      status: "success",
      summary: "Sent Slack notification",
      output: {
        deliveryKind: "slack",
        statusCode: response.status,
        responseBody: responseText
      },
      metrics: {
        durationMs: Date.now() - startedAt
      }
    };
  }

  private async createNotionPage(request: ToolRequest): Promise<ToolResponse> {
    const notionToken = this.options.notionToken;
    const parentPageId = asString(
      request.input["parentPageId"],
      this.options.notionParentPageId ?? ""
    );
    const title = asString(request.input["title"], "OpenClaw Local Manus");
    const body = asString(request.input["body"], asString(request.input["text"]));

    if (!parentPageId) {
      return normalizeToolFailure(
        "Notion parent page id is required",
        ErrorCode.InvalidInput,
        false
      );
    }

    if (this.options.mode !== "live" || request.input["dryRun"] === true) {
      return {
        status: "success",
        summary: `Prepared mock Notion page creation`,
        output: {
          deliveryKind: "notion",
          parentPageId,
          title
        },
        metrics: {
          durationMs: 5
        }
      };
    }

    if (!notionToken) {
      return normalizeToolFailure(
        "Notion token is required",
        ErrorCode.InvalidInput,
        false
      );
    }

    const paragraphBlocks = splitMarkdownSections(body)
      .flatMap((section) => [section.heading, section.body].filter(Boolean))
      .map((content) => stripMarkdownFormatting(content))
      .filter(Boolean)
      .slice(0, 50)
      .map((content) => ({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            {
              type: "text",
              text: {
                content
              }
            }
          ]
        }
      }));

    const startedAt = Date.now();
    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${notionToken}`,
        "content-type": "application/json",
        "notion-version": "2022-06-28"
      },
      body: JSON.stringify({
        parent: {
          type: "page_id",
          page_id: parentPageId
        },
        properties: {
          title: {
            title: [
              {
                text: {
                  content: title
                }
              }
            ]
          }
        },
        children: paragraphBlocks
      })
    });

    const responseText = trimText(await response.text(), 4_000);
    if (!response.ok) {
      return normalizeToolFailure(
        `Notion API returned HTTP ${response.status}: ${responseText}`,
        ErrorCode.NetworkError,
        true
      );
    }

    const payload = JSON.parse(responseText) as Record<string, unknown>;
    return {
      status: "success",
      summary: `Created Notion page ${title}`,
      output: {
        deliveryKind: "notion",
        pageId: asString(payload["id"]),
        url: asString(payload["url"]),
        title
      },
      metrics: {
        durationMs: Date.now() - startedAt
      }
    };
  }
}

export class ToolRuntime {
  private readonly registry = new Map<ToolName, Tool>();

  constructor(
    tools: Tool[],
    private readonly policyService: ToolPolicyService,
    private readonly artifactRegistry: ArtifactRegistry,
    private readonly toolCallRepository: ToolCallRepository,
    private readonly taskEventRepository: TaskEventRepository,
    private readonly logger: Logger
  ) {
    for (const tool of tools) {
      this.registry.set(tool.name, tool);
    }
  }

  async execute(request: ToolRequest): Promise<ToolResponse> {
    if (!this.policyService.canUseTool(request.callerAgent, request.toolName)) {
      return normalizeToolFailure(
        `Agent ${request.callerAgent} cannot use tool ${request.toolName}`,
        ErrorCode.PermissionDenied,
        false
      );
    }

    const tool = this.registry.get(request.toolName);
    if (!tool) {
      return normalizeToolFailure(
        `Tool ${request.toolName} is not registered`,
        ErrorCode.ToolUnavailable,
        false
      );
    }

    const startedAt = Date.now();
    await this.taskEventRepository.create(
      createTaskEvent(
        request.taskId,
        TaskEventKind.Tool,
        `${request.toolName}.${request.action} started`,
        {
          toolName: request.toolName,
          action: request.action,
          callerAgent: request.callerAgent
        },
        {
          stepId: request.stepId
        }
      )
    );
    let response: ToolResponse;
    try {
      response = await tool.execute(request);
      if (response.artifacts && response.artifacts.length > 0) {
        await this.artifactRegistry.recordGeneratedArtifacts(
          request.taskId,
          request.stepId,
          response.artifacts,
          request.toolName
        );
      }
    } catch (error: unknown) {
      response = normalizeUnexpectedToolFailure(request, error);
    }
    const durationMs = response.metrics?.durationMs ?? Date.now() - startedAt;

    const toolCall: ToolCall = {
      id: createId("toolcall"),
      taskId: request.taskId,
      stepId: request.stepId,
      toolName: request.toolName,
      action: request.action,
      callerAgent: request.callerAgent,
      status: response.status,
      durationMs,
      createdAt: new Date().toISOString()
    };
    await this.toolCallRepository.save(toolCall);
    await this.taskEventRepository.create(
      createTaskEvent(
        request.taskId,
        TaskEventKind.Tool,
        `${request.toolName}.${request.action} ${response.status}`,
        {
          toolName: request.toolName,
          action: request.action,
          callerAgent: request.callerAgent,
          status: response.status,
          durationMs,
          ...(response.error
            ? {
                error: {
                  code: response.error.code,
                  message: response.error.message,
                  retryable: response.error.retryable
                }
              }
            : {})
        },
        {
          stepId: request.stepId,
          level: response.status === "success" ? "info" : "error"
        }
      )
    );

    this.logger.info("Tool executed", {
      taskId: request.taskId,
      stepId: request.stepId,
      toolName: request.toolName,
      action: request.action,
      status: response.status
    });

    return response;
  }
}
