# OpenClaw Manus Skeleton

This repository is the first-pass code scaffold for turning OpenClaw into a Manus-grade task execution system.

## What is included

- Modular monolith layout under `apps/` and `packages/`
- Core task, step, plan, checkpoint, and artifact types
- OpenAI model routing config
- Agent, tool runtime, memory, policy, and orchestrator skeletons
- Real SQLite persistence through Prisma repositories
- A queued worker flow using mock or live tools
- Approval-gated `ActionAgent` flow with resume support and minimal approval APIs
- SQLite-backed task job queue for API -> worker execution
- Gateway task submission flow that routes messages and enqueues work through the API

## What is intentionally not included yet

- Durable distributed coordination beyond the current lease-based SQLite queue
- External message channels beyond the current local CLI-style gateway stub

## Commands

```bash
npm install
npm run db:generate
npm run db:init
npm run build
npm test
npm run dev:api
npm run dev:worker
npm run dev:gateway -- "帮我调研迪拜新能源租车市场并做一个报告"
```

Once the API is running, open the local console at:

```bash
open http://127.0.0.1:3000/ui/
```

The console lets you:

- submit new tasks locally
- inspect steps, jobs, approvals, artifacts, and tool calls
- preview generated markdown and screenshots

## Launchd service mode

On macOS you can keep the Manus API and worker running as user launch agents:

```bash
npm run service:install
npm run service:status
```

This installs two services under `~/Library/LaunchAgents/`:

- `ai.openclaw.manus.api`
- `ai.openclaw.manus.worker`

Logs are written to:

- `~/.openclaw/logs/manus-api.log`
- `~/.openclaw/logs/manus-api.err.log`
- `~/.openclaw/logs/manus-worker.log`
- `~/.openclaw/logs/manus-worker.err.log`

Service management commands:

```bash
npm run service:restart
npm run service:stop
npm run service:status
npm run service:uninstall
```

The launch agents load configuration from a local `.env` file in the repository root when present.
This keeps secrets such as `OPENAI_API_KEY` out of the plist files.

When the API is still running in mock mode, OpenClaw-origin tasks are rejected by default with
HTTP `503` instead of being marked complete with synthetic placeholder content. You can inspect the
current runtime mode via:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/runtime
```

## Live mode

By default the scaffold runs in `mock` mode even if `OPENAI_API_KEY` is present. This keeps local tests deterministic.

To enable the real execution chain:

```bash
export OPENAI_API_KEY=...
export OPENCLAW_AGENT_MODE=live
export OPENCLAW_DB_MODE=prisma
export OPENCLAW_TOOL_MODE=live
export OPENCLAW_BROWSER_MODE=live
export OPENCLAW_ACTION_WEBHOOK_URL=https://example.com/webhook
export OPENCLAW_API_BASE_URL=http://localhost:3000
npm run db:init
npx playwright install chromium
npm run dev:api
npm run dev:worker
npm run dev:gateway -- "帮我调研迪拜新能源租车市场并做一个报告"
```

In live mode:

- `RouterAgent`, `PlannerAgent`, and `VerifierAgent` use OpenAI structured outputs
- `ResearchAgent`, `BrowserAgent`, and `DocumentAgent` use OpenAI to synthesize tool results into step outputs
- `ActionAgent` pauses on side effects, creates an approval request, and resumes only after approval
- `TaskRepository`, `CheckpointRepository`, `ArtifactRepository`, `UserProfileRepository`, `ToolCallRepository`, and `ApprovalRequestRepository` persist to SQLite through Prisma
- `SearchTool` uses the OpenAI Responses API with the built-in web search tool
- `BrowserTool` uses Playwright Chromium for page extraction and screenshots
- `DocumentTool` writes the final Markdown artifact produced by the document step
- `PythonTool` executes local Python scripts inside each task workspace under `python/<stepId>/`
- `ActionTool` can execute approved webhook calls when `OPENCLAW_ACTION_WEBHOOK_URL` is set

For a local Python-sandbox smoke test without live LLM planning, you can keep the agents in `mock`
mode but enable live tools:

```bash
OPENCLAW_DB_MODE=inmemory \
OPENCLAW_AGENT_MODE=mock \
OPENCLAW_TOOL_MODE=live \
OPENCLAW_BROWSER_MODE=mock \
npm run build
OPENCLAW_DB_MODE=inmemory \
OPENCLAW_AGENT_MODE=mock \
OPENCLAW_TOOL_MODE=live \
OPENCLAW_BROWSER_MODE=mock \
node - <<'EOF'
const { buildDemoRuntime } = require('./dist/packages/orchestrator/src');
const { ConsoleLogger } = require('./dist/packages/observability/src');
(async () => {
  const runtime = buildDemoRuntime('.data/tasks-smoke', new ConsoleLogger(false));
  const task = await runtime.orchestrator.handleGoal({
    userId: 'smoke_user',
    goal: '用 Python 分析 12, 18, 25, 40 这四个数字并输出 JSON 和 markdown 摘要'
  });
  console.log(task.status, task.finalArtifactUri);
})();
EOF
```

## Approval API

The HTTP API now exposes task submission, queue inspection, approval, and resume endpoints:

```bash
npm run dev:api
curl -X POST http://localhost:3000/tasks \
  -H 'content-type: application/json' \
  -d '{"userId":"demo_user","goal":"帮我调研迪拜新能源租车市场并做一个报告"}'
curl http://localhost:3000/jobs
curl http://localhost:3000/approvals
curl http://localhost:3000/tasks/<taskId>
curl http://localhost:3000/jobs?taskId=<taskId>
curl -X POST http://localhost:3000/approvals/<approvalId>/approve \
  -H 'content-type: application/json' \
  -d '{"decidedBy":"operator","decisionNote":"approved"}'
curl -X POST http://localhost:3000/approvals/<approvalId>/reject \
  -H 'content-type: application/json' \
  -d '{"decidedBy":"operator","decisionNote":"rejected"}'
```

To preserve the original OpenClaw conversation for callback delivery, task creation also accepts an
optional `origin` payload:

```bash
curl -X POST http://localhost:3000/tasks \
  -H 'content-type: application/json' \
  -d '{
    "userId":"demo_user",
    "goal":"帮我调研迪拜新能源租车市场并做一个报告",
    "origin":{
      "channelId":"whatsapp",
      "accountId":"default",
      "conversationId":"971500000000",
      "senderId":"971500000000",
      "sessionKey":"whatsapp:default:971500000000",
      "replyMode":"auto_callback"
    }
  }'
```

The worker consumes queue jobs asynchronously:

```bash
npm run dev:worker
OPENCLAW_WORKER_LEASE_MS=30000 OPENCLAW_WORKER_HEARTBEAT_MS=10000 npm run dev:worker
OPENCLAW_WORKER_ONCE=1 npm run dev:worker
```

Queue leasing details:

- workers claim jobs with a lease timestamp
- running jobs send periodic heartbeats
- stale `RUNNING` jobs can be reclaimed after the lease expires

The gateway now submits executable tasks through the API:

```bash
npm run dev:gateway -- "帮我调研迪拜新能源租车市场并做一个报告"
OPENCLAW_API_BASE_URL=http://localhost:3000 npm run dev:gateway -- "今天天气怎么样"
```

## OpenClaw bridge plugin

The repository now includes a first-pass OpenClaw plugin skeleton under
`plugins/manus-bridge`. It is designed to let the OpenClaw
gateway delegate long-running tasks to this runtime without patching OpenClaw core.

Install it into OpenClaw with a linked local plugin:

```bash
openclaw plugins install -l /absolute/path/to/openclaw-manus/plugins/manus-bridge
openclaw plugins enable manus-bridge
```

If you clone this repository elsewhere, replace the plugin path with your local checkout path.

## Repository hygiene

This repository is intended to store source code and minimal checked-in configuration only.

The following local files and runtime artifacts must stay out of version control:

- `.env`
- `.data/`
- `dist/`
- `node_modules/`
- `prisma/dev.db`
- temporary uploads and smoke-test files

Before creating the first commit or pushing to GitHub, run:

```bash
npm test
npm run build
git status --short
git ls-files
```

Verify that no secrets, databases, logs, screenshots, or runtime artifacts are listed.

The plugin currently provides:

- `/task`, `/task-status`, `/approve-task`
- optional tools: `manus_submit_task`, `manus_task_status`, `manus_approve_task`
- gateway RPC methods: `manus.submit`, `manus.status`, `manus.approve`
- a poller service that can send approval/completion callbacks back to the original conversation

## Layout

```text
apps/
  api/
  gateway/
  worker/
packages/
  agents/
  artifacts/
  core/
  db/
  llm/
  memory/
  observability/
  orchestrator/
  policy/
  prompts/
  shared/
  tools/
```
