import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ArtifactRegistry, WorkspaceManager } from "../../artifacts/src";
import { createInMemoryRepositories } from "../../db/src";
import { AgentKind, ToolName } from "../../core/src";
import { ConsoleLogger } from "../../observability/src";
import { ToolPolicyService } from "../../policy/src";
import { BrowserTool, DocumentTool, PythonTool, ToolRuntime, type Tool } from "../src";

test("python tool executes a local script and captures generated files", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-python-"));
  const tool = new PythonTool(new WorkspaceManager(workspaceRoot), {
    mode: "live",
    timeoutMs: 10_000
  });

  const response = await tool.execute({
    taskId: "task_python",
    stepId: "s1",
    toolName: ToolName.Python,
    action: "run_script",
    callerAgent: AgentKind.Coding,
    input: {
      filename: "numbers",
      code: [
        "from pathlib import Path",
        "Path('result.json').write_text('{\"sum\": 10}', encoding='utf-8')",
        "print('python sandbox ok')"
      ].join("\n")
    }
  });

  assert.equal(response.status, "success");
  assert.match(String(response.output?.stdout ?? ""), /python sandbox ok/);
  const artifacts = response.artifacts ?? [];
  assert.equal(artifacts.some((artifact) => artifact.endsWith("numbers.py")), true);
  const resultFile = artifacts.find((artifact) => artifact.endsWith("result.json"));
  assert.ok(resultFile);
  const contents = await fs.readFile(resultFile, "utf8");
  assert.match(contents, /"sum": 10/);
});

test("python tool resolves a relative workspace root before executing", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-python-relative-"));
  const previousCwd = process.cwd();
  process.chdir(tempRoot);

  try {
    const tool = new PythonTool(new WorkspaceManager(".data/tasks"), {
      mode: "live",
      timeoutMs: 10_000
    });

    const response = await tool.execute({
      taskId: "task_relative_root",
      stepId: "s1",
      toolName: ToolName.Python,
      action: "run_script",
      callerAgent: AgentKind.Coding,
      input: {
        filename: "numbers",
        code: [
          "from pathlib import Path",
          "Path('result.json').write_text('{\"sum\": 6}', encoding='utf-8')",
          "print('relative workspace ok')"
        ].join("\n")
      }
    });

    assert.equal(response.status, "success");
    assert.match(String(response.output?.stdout ?? ""), /relative workspace ok/);
    const resolvedTempRoot = await fs.realpath(tempRoot);
    assert.equal(
      String(response.output?.scriptPath ?? "").startsWith(
        path.join(resolvedTempRoot, ".data", "tasks")
      ),
      true
    );
    const artifacts = response.artifacts ?? [];
    const resultFile = artifacts.find((artifact) => artifact.endsWith("result.json"));
    assert.ok(resultFile);
    const contents = await fs.readFile(resultFile, "utf8");
    assert.match(contents, /"sum": 6/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("python tool keeps user site enabled by default in live mode", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-python-usersite-"));
  const tool = new PythonTool(new WorkspaceManager(workspaceRoot), {
    mode: "live",
    timeoutMs: 10_000
  });

  const response = await tool.execute({
    taskId: "task_python_user_site",
    stepId: "s1",
    toolName: ToolName.Python,
    action: "run_script",
    callerAgent: AgentKind.Coding,
    input: {
      filename: "env-check",
      code: [
        "import os",
        "print(os.environ.get('PYTHONNOUSERSITE', ''))"
      ].join("\n")
    }
  });

  assert.equal(response.status, "success");
  assert.equal(String(response.output?.stdout ?? "").trim(), "");
});

test("python tool copies uploaded input files into the sandbox", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-python-inputs-"));
  const inputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-uploaded-"));
  const sourceCsv = path.join(inputRoot, "numbers.csv");
  await fs.writeFile(sourceCsv, "value\n12\n18\n25\n40\n", "utf8");

  const tool = new PythonTool(new WorkspaceManager(workspaceRoot), {
    mode: "live",
    timeoutMs: 10_000
  });

  const response = await tool.execute({
    taskId: "task_python_input_files",
    stepId: "s1",
    toolName: ToolName.Python,
    action: "run_script",
    callerAgent: AgentKind.Coding,
    inputFiles: [sourceCsv],
    input: {
      filename: "read-upload",
      code: [
        "from pathlib import Path",
        "inputs = Path('inputs')",
        "csv_path = next(inputs.glob('*.csv'))",
        "print(csv_path.read_text(encoding='utf-8').strip())"
      ].join("\n")
    }
  });

  assert.equal(response.status, "success");
  assert.match(String(response.output?.stdout ?? ""), /value/);
  const copiedInputs = Array.isArray(response.output?.inputFiles) ? response.output.inputFiles : [];
  assert.equal(copiedInputs.length, 1);
});

test("document tool renders markdown to a real pdf in live mode", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-document-pdf-"));
  const tool = new DocumentTool(new WorkspaceManager(workspaceRoot), {
    mode: "live"
  });

  const response = await tool.execute({
    taskId: "task_document_pdf",
    stepId: "s1",
    toolName: ToolName.Document,
    action: "render_pdf",
    callerAgent: AgentKind.Document,
    input: {
      title: "测试简报",
      body: ["## 摘要", "", "- 第一条", "- 第二条"].join("\n"),
      outputFilename: "brief.pdf",
      template: "brief"
    }
  });

  assert.equal(response.status, "success");
  const pdfPath = response.artifacts?.find((artifact) => artifact.endsWith(".pdf"));
  assert.ok(pdfPath);
  const header = await fs.readFile(pdfPath, "utf8");
  assert.match(header.slice(0, 8), /%PDF/);
});

test("browser tool downloads files with a persistent profile directory", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-browser-download-"));
  const profileRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-browser-profile-"));
  const server = http.createServer((request, response) => {
    if (request.url === "/download") {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="sample.txt"'
      });
      response.end("browser download ok");
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end('<html><body><a id="dl" href="/download">download</a></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const pageUrl = `http://127.0.0.1:${address.port}/`;

  try {
    const tool = new BrowserTool(new WorkspaceManager(workspaceRoot), {
      mode: "live",
      headless: true,
      profileRootDir: profileRoot
    });

    const response = await tool.execute({
      taskId: "task_browser_download",
      stepId: "s1",
      toolName: ToolName.Browser,
      action: "download",
      callerAgent: AgentKind.Browser,
      browserProfileId: "download-profile",
      input: {
        url: pageUrl,
        selector: "#dl",
        outputFilename: "downloaded.txt"
      }
    });

    assert.equal(response.status, "success");
    const downloadedFile = response.artifacts?.find((artifact) => artifact.endsWith(".txt"));
    assert.ok(downloadedFile);
    const contents = await fs.readFile(downloadedFile, "utf8");
    assert.match(contents, /browser download ok/);
    await fs.access(path.join(profileRoot, "download-profile"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("tool runtime converts thrown tool errors into structured failures", async () => {
  const repositories = createInMemoryRepositories();
  const runtime = new ToolRuntime(
    [
      {
        name: ToolName.Document,
        execute: async () => {
          throw new Error("playwright render timed out");
        }
      } satisfies Tool
    ],
    new ToolPolicyService(),
    new ArtifactRegistry(repositories.artifactRepository, new WorkspaceManager(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-tool-runtime-")))),
    repositories.toolCallRepository,
    repositories.taskEventRepository,
    new ConsoleLogger(false)
  );

  const response = await runtime.execute({
    taskId: "task_tool_throw",
    stepId: "s1",
    toolName: ToolName.Document,
    action: "render_pdf",
    callerAgent: AgentKind.Document,
    input: {}
  });

  assert.equal(response.status, "failed");
  assert.equal(response.error?.stage, "tool_runtime");
  assert.equal(response.error?.category, "unhandled_tool_exception");
  assert.equal(response.error?.retryable, true);

  const toolCalls = await repositories.toolCallRepository.listByTask("task_tool_throw");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]?.status, "failed");

  const events = await repositories.taskEventRepository.listByTask("task_tool_throw");
  assert.equal(
    events.some(
      (event) =>
        event.kind === "tool_call" &&
        event.message === "document.render_pdf failed"
    ),
    true
  );
});

test("artifact registry rejects generated artifacts outside the workspace root", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-artifact-root-"));
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-artifact-outside-"));
  const outsideFile = path.join(outsideRoot, "outside.pdf");
  await fs.writeFile(outsideFile, "outside", "utf8");
  const repositories = createInMemoryRepositories();
  const runtime = new ToolRuntime(
    [
      {
        name: ToolName.Document,
        execute: async () => ({
          status: "success",
          summary: "Generated a PDF",
          artifacts: [outsideFile]
        })
      } satisfies Tool
    ],
    new ToolPolicyService(),
    new ArtifactRegistry(repositories.artifactRepository, new WorkspaceManager(workspaceRoot)),
    repositories.toolCallRepository,
    repositories.taskEventRepository,
    new ConsoleLogger(false)
  );

  const response = await runtime.execute({
    taskId: "task_artifact_outside",
    stepId: "s1",
    toolName: ToolName.Document,
    action: "render_pdf",
    callerAgent: AgentKind.Document,
    input: {}
  });

  assert.equal(response.status, "failed");
  assert.equal(response.error?.stage, "tool_runtime");
  assert.match(String(response.error?.message ?? ""), /outside workspace root/);
  const artifacts = await repositories.artifactRepository.listByTask("task_artifact_outside");
  assert.equal(artifacts.length, 0);
});
