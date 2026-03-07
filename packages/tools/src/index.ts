import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
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
    if (!["open", "extract", "click", "type", "wait_for", "download", "screenshot"].includes(action)) {
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
    try {
      const taskDir = await this.workspaceManager.ensureTaskWorkspace(request.taskId);
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

      const persistentContext = await chromium.launchPersistentContext(profileDir, {
        headless: this.options.headless ?? true,
        acceptDownloads: true,
        ...(this.options.channel ? { channel: this.options.channel as "chrome" | "msedge" } : {}),
        ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {})
      });

      try {
        const page = persistentContext.pages()[0] ?? (await persistentContext.newPage());
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: this.options.navigationTimeoutMs ?? 30_000
        });

        if (action === "open") {
          return {
            status: "success",
            summary: `Opened ${url}`,
            output: {
              currentUrl: page.url(),
              pageTitle: await page.title(),
              browserProfileId: profileId,
              profileDir
            },
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
          await page.click(selector, {
            timeout: request.timeoutMs ?? this.options.navigationTimeoutMs ?? 30_000
          });
          return {
            status: "success",
            summary: `Clicked ${selector} on ${url}`,
            output: {
              currentUrl: page.url(),
              pageTitle: await page.title(),
              browserProfileId: profileId,
              profileDir
            },
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
          await page.fill(selector, text, {
            timeout: request.timeoutMs ?? this.options.navigationTimeoutMs ?? 30_000
          });
          return {
            status: "success",
            summary: `Typed into ${selector} on ${url}`,
            output: {
              currentUrl: page.url(),
              pageTitle: await page.title(),
              browserProfileId: profileId,
              profileDir
            },
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
          await page.waitForSelector(selector, {
            timeout: request.timeoutMs ?? this.options.navigationTimeoutMs ?? 30_000
          });
          return {
            status: "success",
            summary: `Waited for ${selector} on ${url}`,
            output: {
              currentUrl: page.url(),
              pageTitle: await page.title(),
              browserProfileId: profileId,
              profileDir
            },
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
          const downloadPromise = page.waitForEvent("download", {
            timeout: request.timeoutMs ?? this.options.navigationTimeoutMs ?? 30_000
          });
          await page.click(selector, {
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
            output: {
              currentUrl: page.url(),
              pageTitle: await page.title(),
              browserProfileId: profileId,
              profileDir,
              downloadDir,
              downloadedFile: savedPath
            },
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
          await page.screenshot({
            path: screenshotPath,
            fullPage: true
          });
        }

        if (action === "screenshot") {
          return {
            status: "success",
            summary: `Captured screenshot for ${url}`,
            output: {
              currentUrl: page.url(),
              pageTitle: await page.title(),
              browserProfileId: profileId,
              profileDir
            },
            ...(screenshotPath ? { artifacts: [screenshotPath] } : {}),
            metrics: {
              durationMs: Date.now() - startedAt
            }
          };
        }

        const selector = asString(request.input["selector"], "body");
        const locator = page.locator(selector);
        const rawText =
          (await locator
            .innerText({
              timeout: 5_000
            })
            .catch(async () => (await page.locator("body").textContent()) ?? "")) ?? "";
        const extractedText = trimText(
          rawText,
          typeof request.input["maxChars"] === "number"
            ? Number(request.input["maxChars"])
            : this.options.maxExtractedChars ?? 12_000
        );

        const output: JsonObject = {
          currentUrl: page.url(),
          pageTitle: await page.title(),
          extractedText,
          browserProfileId: profileId,
          profileDir,
          downloadDir
        };

        return {
          status: "success",
          summary: `Extracted browser content from ${url}`,
          output,
          ...(screenshotPath ? { artifacts: [screenshotPath] } : {}),
          metrics: {
            durationMs: Date.now() - startedAt
          }
        };
      } finally {
        await persistentContext.close();
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return normalizeToolFailure(
        `Playwright browser execution failed: ${message}`,
        ErrorCode.ToolUnavailable,
        true
      );
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
      return {
        status: "success",
        summary: `Prepared mock python execution for ${filename}`,
        output: {
          scriptPath: `/mock/${request.taskId}/${filename}`,
          stdout: "mock python execution",
          stderr: "",
          exitCode: 0,
          generatedFiles: []
        },
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
    if (request.action !== "render_markdown" && request.action !== "render_pdf") {
      return normalizeToolFailure(
        `Unsupported document action: ${request.action}`,
        ErrorCode.InvalidInput,
        false
      );
    }

    const filename = String(request.input["filename"] ?? "report.md");
    const title = String(request.input["title"] ?? "Task Output");
    const body = String(request.input["body"] ?? "");
    const generationPrompt = asString(request.input["generationPrompt"]);
    const useLlm =
      this.options.mode === "live" &&
      this.options.llmClient?.isConfigured() &&
      generationPrompt.length > 0;

    const renderedBody = useLlm
      ? await this.renderWithOpenAI(title, body, generationPrompt)
      : body;

    if (request.action === "render_pdf") {
      const outputFilename = sanitizeFilenamePreserveExtension(
        asString(request.input["outputFilename"], "report.pdf"),
        "report"
      );
      const template = asString(request.input["template"], "default");
      const html = buildPdfHtml(title, renderedBody, template);
      const filePath = await this.renderPdf(request.taskId, outputFilename, html);

      return {
        status: "success",
        summary: `Rendered PDF document at ${filePath}`,
        artifacts: [filePath],
        output: {
          filePath,
          outputFilename,
          template
        },
        metrics: {
          durationMs: 10
        }
      };
    }

    const rendered = `# ${title}\n\n${renderedBody}\n`;
    const filePath = await this.workspaceManager.writeTaskFile(request.taskId, filename, rendered);

    return {
      status: "success",
      summary: `Rendered markdown document at ${filePath}`,
      artifacts: [filePath],
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
}

export class ActionTool implements Tool {
  readonly name = ToolName.Action;

  constructor(private readonly options: ActionToolOptions) {}

  async execute(request: ToolRequest): Promise<ToolResponse> {
    if (request.action !== "post_webhook") {
      return normalizeToolFailure(
        `Unsupported action tool action: ${request.action}`,
        ErrorCode.InvalidInput,
        false
      );
    }

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
