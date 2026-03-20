# CLAUDE.md — AI Assistant Guide for openclaw-manus

This file provides context for AI assistants working on this codebase. Read it at the start of every session.

---

## Project Overview

**openclaw-manus** is a local-first, modular monolith scaffold for AI-powered task orchestration. It evolves OpenClaw into a Manus-grade task execution system with multi-agent workflows, browser automation, Python execution, and rich artifact generation.

- **Version:** 0.1.0 (private)
- **Node.js:** 22.0.0+ required
- **Language:** TypeScript 5.8.2 (strict mode, CommonJS output)

---

## Repository Layout

```
/
├── apps/
│   ├── api/          # REST API server (port 3000) — task submission & inspection
│   ├── worker/       # Async job queue worker (lease-based locking)
│   ├── gateway/      # CLI simulator for local testing
│   └── console/      # Web UI at http://127.0.0.1:3000/ui/
├── packages/
│   ├── agents/       # Agent implementations (Router, Planner, Research, Browser, etc.)
│   ├── core/         # Domain models, contracts, enums — source of truth
│   ├── db/           # Prisma repository layer (CRUD)
│   ├── tools/        # Tool runtime (Search, Browser, Python, Filesystem, Document, Action)
│   ├── orchestrator/ # Task orchestration engine + queue worker logic
│   ├── llm/          # LLM client abstraction & OpenAI model routing
│   ├── memory/       # Context builder & memory stores
│   ├── policy/       # Policy enforcement & quality gates
│   ├── artifacts/    # Artifact generation (Markdown, PDF, DOCX, PPTX, XLSX)
│   ├── recipes/      # Task workflow templates
│   ├── prompts/      # Prompt template library
│   ├── evals/        # Benchmark cases & evaluation framework
│   ├── observability/# Console logger
│   └── shared/       # Utilities: createId, nowIso, JsonObject types
├── plugins/
│   └── manus-bridge/ # OpenClaw plugin for task delegation
├── prisma/
│   └── schema.prisma # SQLite schema (17 tables)
├── scripts/          # Utility scripts (evals, service management)
├── docs/             # Documentation
└── .env.example      # Environment variable template
```

Each package exports a single barrel: `packages/*/src/index.ts`.

---

## Tech Stack

| Concern | Technology |
|---|---|
| Language | TypeScript 5.8.2 |
| Runtime | Node.js 22+ |
| Database | SQLite via Prisma ORM |
| LLM | OpenAI (structured outputs) |
| Browser automation | Playwright |
| Document generation | docx, exceljs, pptxgenjs |
| Email | nodemailer |
| Test runner | Node.js built-in `test` module |
| Script executor | tsx |

---

## Essential Commands

```bash
# Setup
npm install
npm run db:generate     # Generate Prisma client
npm run db:init         # Create/initialize SQLite DB
npm run build           # Compile TypeScript → dist/

# Development
npm run dev:api         # Start API server (hot reload via tsx)
npm run dev:worker      # Start worker (hot reload via tsx)
npm run dev:gateway -- "do a task"  # Submit task via CLI

# Type checking
npm run typecheck       # Check types without emitting

# Tests (always run in mock mode)
npm test

# Database management
npm run db:push         # Push Prisma schema changes

# Evaluation / benchmarks
npm run evals:smoke     # Smoke test suite
npm run evals           # Full benchmark suite

# macOS background services
npm run service:install
npm run service:start
npm run service:stop
npm run service:status
```

---

## Environment Modes

All runtime behaviour is controlled via environment variables (see `.env.example`).

| Variable | Values | Default | Description |
|---|---|---|---|
| `OPENCLAW_AGENT_MODE` | `mock` / `live` | `mock` | Use stub agents or real LLM |
| `OPENCLAW_DB_MODE` | `inmemory` / `prisma` | `inmemory` | In-memory store or SQLite |
| `OPENCLAW_TOOL_MODE` | `mock` / `live` | `mock` | Stub tools or real tool execution |
| `OPENCLAW_BROWSER_MODE` | `mock` / `live` | `mock` | Skip browser or use Playwright |
| `OPENAI_API_KEY` | string | — | Required for `live` agent mode |
| `DATABASE_URL` | path | `.data/openclaw-manus.db` | SQLite file location |
| `OPENCLAW_WORKSPACE_ROOT` | path | `.data/tasks` | Task workspace directory |

**Tests always run in mock mode.** Never change this.

**Live mode setup:**
```bash
export OPENAI_API_KEY="sk-..."
export OPENCLAW_AGENT_MODE=live
export OPENCLAW_TOOL_MODE=live
export OPENCLAW_BROWSER_MODE=live
export OPENCLAW_DB_MODE=prisma
npx playwright install chromium
```

---

## Core Domain Models (`packages/core/src/`)

All types used across the system originate here. Never duplicate them.

### Key Enums (`enums.ts`)

```typescript
TaskStatus:   CREATED → PLANNED → RUNNING → WAITING_TOOL | WAITING_APPROVAL
              → VERIFYING → RETRYING | REPLANNING → COMPLETED | FAILED | CANCELLED

StepStatus:   PENDING → RUNNING → VERIFYING → COMPLETED | FAILED | RETRYING
              | SKIPPED | WAITING_APPROVAL

AgentKind:    Router | Planner | Replanner | Research | Browser
              | Coding | Document | Action | Verifier

TaskClass:    research_browser | wide_research | coding_python
              | document_export | action_execution

ToolName:     search | browser | python | filesystem | document | action

ArtifactType: plan | json | markdown | pdf | document | presentation
              | spreadsheet | text | screenshot | report | generic

DeliveryKind: markdown | pdf | docx | pptx | xlsx | json | text
              | webhook | email | slack | notion
```

### Key Interfaces (`domain.ts`, `contracts.ts`)

- `Task` — root task entity (userId, goal, status, plan, artifacts)
- `TaskStep` — single execution step within a plan
- `Plan` — ordered collection of steps with dependency graph
- `Artifact` — output deliverable with type and content
- `ApprovalRequest` — human-in-the-loop approval gate
- `ToolCall` — tool invocation audit record
- `Checkpoint` — plan snapshot for recovery/replay

---

## Agent System (`packages/agents/`)

### Agent Roster

| Agent | Role |
|---|---|
| `RouterAgent` | Routes to task_execution or chat |
| `PlannerAgent` | Generates multi-step execution plans |
| `ReplannerAgent` | Adjusts plans on step failure |
| `ResearchAgent` | Synthesises web search results |
| `BrowserAgent` | Automates browser interactions |
| `CodingAgent` | Executes Python code analysis |
| `DocumentAgent` | Generates formatted deliverables |
| `ActionAgent` | Side-effects (webhooks, emails) with approval gating |
| `VerifierAgent` | Quality gates, pass/fail/retry decisions |

In **mock mode**, agents return deterministic stubs — no LLM calls made.
In **live mode**, agents use OpenAI structured outputs.

---

## Tool System (`packages/tools/`)

| Tool | Mock | Live |
|---|---|---|
| `SearchTool` | Stub results | OpenAI Responses API |
| `BrowserTool` | Stub page/screenshots | Playwright (Chromium) |
| `PythonTool` | Stub output | Subprocess execution |
| `FileSystemTool` | In-memory | Real file I/O in workspace |
| `DocumentTool` | Stub file | docx/pptx/xlsx/PDF generation |
| `ActionTool` | Stub response | Webhook/email/Slack (approval-gated) |

**ActionTool always requires an ApprovalRequest** before executing in live mode.

---

## Task Execution Flow

```
1. POST /tasks  →  RouterAgent  →  task_execution | chat
2. PlannerAgent generates Plan (ordered steps)
3. Orchestrator executes steps respecting dependency order
4. Each step dispatched to appropriate Agent
5. Agent invokes Tool(s) as needed
6. ActionAgent gates side-effects via ApprovalRequest
7. VerifierAgent validates step output → pass | fail | retry
8. On failure: ReplannerAgent adjusts remaining plan
9. Checkpoints persisted at each plan change
10. Final artifact returned via GET /tasks/<id>
```

---

## Database Schema (`prisma/schema.prisma`)

SQLite with 17 tables. Key tables:

| Table | Purpose |
|---|---|
| `TaskRecord` | Root task entity |
| `TaskStepRecord` | Individual steps |
| `CheckpointRecord` | Plan version snapshots |
| `ArtifactRecord` | Output files/content |
| `ToolCallRecord` | Tool invocation audit |
| `ApprovalRequestRecord` | Approval gates |
| `TaskJobRecord` | Async job queue (lease-based) |
| `TaskEventRecord` | Event stream |
| `MemoryRecordModel` | Long-term context memory |
| `BrowserSessionRecord` | Persistent browser state |
| `BenchmarkRunRecord` | Eval tracking |

Workspace files stored at `.data/tasks-{api,worker}/<taskId>/`.

---

## REST API (`apps/api/`)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/tasks` | Submit task (`{ goal: string }`) |
| `GET` | `/tasks/:id` | Get task status + steps + artifacts |
| `GET` | `/jobs` | List queue jobs |
| `GET` | `/approvals` | List pending approvals |
| `POST` | `/approvals/:id/approve` | Approve an action |
| `POST` | `/approvals/:id/reject` | Reject an action |
| `GET` | `/health` | Health check |
| `GET` | `/runtime` | Runtime configuration dump |
| `GET` | `/ui/` | Web console UI |

---

## Test Conventions

- **Framework:** Node.js built-in `node:test`
- **Location:** `packages/*/test/*.test.ts`, `apps/gateway/test/*.test.ts`
- **Environment:** All tests run with all `OPENCLAW_*_MODE=mock`
- **Run:** `npm test` (builds first, then runs)
- **Never** write tests that require live API keys or network access

Test files:
```
packages/agents/test/agents.test.ts
packages/tools/test/tools.test.ts
packages/policy/test/policy.test.ts
packages/orchestrator/test/orchestrator.test.ts
packages/recipes/test/recipes.test.ts
packages/evals/test/evals.test.ts
apps/gateway/test/gateway.test.ts
```

---

## TypeScript Conventions

- **Strict mode** — all strict flags enabled
- `noImplicitOverride` — always use `override` keyword
- `noUncheckedIndexedAccess` — index operations can return `undefined`, handle it
- `exactOptionalPropertyTypes` — don't assign `undefined` to optional props
- Target: `ES2022`, module: `CommonJS`, output: `dist/`
- One barrel export per package: `packages/*/src/index.ts`

### Naming Conventions

| Pattern | Example |
|---|---|
| Agents | `RouterAgent`, `PlannerAgent` |
| Repositories | `TaskRepository`, `CheckpointRepository` |
| Tools | `SearchTool`, `BrowserTool` |
| DB records | `TaskRecord`, `TaskStepRecord` |
| Enums | `TaskStatus`, `AgentKind` (PascalCase) |
| Utilities | `createId()`, `nowIso()` (camelCase) |

---

## OpenClaw Bridge Plugin (`plugins/manus-bridge/`)

Allows OpenClaw to delegate long-running tasks to this runtime:
- Install the plugin inside OpenClaw
- Configure `MANUS_API_URL` to point at the running API
- Supports auto-callback via WhatsApp, Telegram, or Slack

See `plugins/manus-bridge/README.md` for full setup.

---

## Evaluation Framework (`packages/evals/`)

- Benchmark cases defined in `packages/evals/src/`
- Smoke suite: fast subset for CI-like checks
- Full suite: comprehensive coverage with quality scoring
- Baselines tracked in `docs/evals-baseline.md`
- Run with: `npm run evals:smoke` or `npm run evals`
- Write new baselines with: `npm run evals:baseline:smoke`

---

## Key Gotchas

1. **Always run `npm run db:generate` after schema changes** — the Prisma client must be regenerated before building.
2. **`noUncheckedIndexedAccess` is enabled** — `arr[0]` is `T | undefined`. Guard accordingly.
3. **Mock mode is the default** — tests and local dev work without API keys.
4. **ActionTool requires approval in live mode** — side-effect actions are gated; don't bypass.
5. **Workspace files are NOT auto-cleaned** — `.data/tasks/` grows indefinitely; clean manually.
6. **Service scripts are macOS-only** — `npm run service:*` uses launchd and won't work on Linux/Windows.
7. **`tsx` is used for dev, `node dist/` for production** — don't use `ts-node`.

---

## Development Workflow

1. Make changes in `packages/*/src/` or `apps/*/src/`
2. Run `npm run typecheck` to catch type errors early
3. Run `npm run build` to compile
4. Run `npm test` to verify in mock mode
5. For live testing: set env vars, run `npm run dev:api` + `npm run dev:worker` in separate terminals, then `npm run dev:gateway -- "your goal"`

---

## Session Start Checklist

- [ ] Review `tasks/lessons.md` for relevant patterns
- [ ] Read `tasks/todo.md` for in-progress work
- [ ] Run `npm run typecheck` to confirm clean baseline
- [ ] Confirm which mode you need: mock vs live
