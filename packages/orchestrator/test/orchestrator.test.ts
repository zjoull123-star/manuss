import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDemoRuntime, TaskQueueWorker } from "../src";
import {
  AgentKind,
  ApprovalStatus,
  ArtifactType,
  createTaskFromPlan,
  createTaskJob,
  StepStatus,
  TaskEventKind,
  TaskJobKind,
  TaskJobStatus,
  TaskStatus
} from "../../core/src";
import { ConsoleLogger } from "../../observability/src";

test("demo runtime completes a multi-step task and produces an artifact", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-"));
  const runtime = buildDemoRuntime(workspaceRoot, new ConsoleLogger(false));

  const task = await runtime.orchestrator.handleGoal({
    userId: "user_demo",
    goal: "帮我调研迪拜新能源租车市场并做一个报告"
  });

  assert.equal(task.status, TaskStatus.Completed);
  assert.ok(task.finalArtifactUri);
  await fs.access(task.finalArtifactUri);

  const reportContents = await fs.readFile(task.finalArtifactUri, "utf8");
  assert.match(reportContents, /Key Findings/);
});

test("task origin is preserved when preparing a task", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-origin-"));
  const runtime = buildDemoRuntime(workspaceRoot, new ConsoleLogger(false));

  const task = await runtime.orchestrator.prepareTask({
    userId: "user_origin",
    goal: "帮我调研迪拜新能源租车市场并做一个报告",
    origin: {
      channelId: "whatsapp",
      accountId: "default",
      conversationId: "971500000000",
      senderId: "971500000000",
      sessionKey: "whatsapp:default:971500000000",
      threadId: "thread-1",
      replyMode: "auto_callback"
    }
  });

  assert.deepEqual(task.origin, {
    channelId: "whatsapp",
    accountId: "default",
    conversationId: "971500000000",
    senderId: "971500000000",
    sessionKey: "whatsapp:default:971500000000",
    threadId: "thread-1",
    replyMode: "auto_callback"
  });

  const persistedTask = await runtime.taskRepository.getById(task.id);
  assert.deepEqual(persistedTask?.origin, task.origin);
});

test("approval-gated action step pauses and resumes after approval", async () => {
  const previousWebhookUrl = process.env.OPENCLAW_ACTION_WEBHOOK_URL;
  process.env.OPENCLAW_ACTION_WEBHOOK_URL = "https://example.test/webhook";
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-approval-"));
  try {
    const runtime = buildDemoRuntime(workspaceRoot, new ConsoleLogger(false));

    const waitingTask = await runtime.orchestrator.handleGoal({
      userId: "user_approval",
      goal: "帮我调研迪拜新能源租车市场，生成报告后通过 webhook 通知我"
    });

    assert.equal(waitingTask.status, TaskStatus.WaitingApproval);
    const actionStep = waitingTask.steps.find((step) => step.agent === AgentKind.Action);
    assert.ok(actionStep);
    assert.equal(actionStep?.status, StepStatus.WaitingApproval);

    const approvals = await runtime.approvalRequestRepository.listPending();
    assert.equal(approvals.length, 1);
    const approval = approvals[0];
    assert.ok(approval);
    approval.status = ApprovalStatus.Approved;
    approval.decidedAt = new Date().toISOString();
    approval.decidedBy = "test_runner";
    approval.decisionNote = "approved for test";
    await runtime.approvalRequestRepository.update(approval);

    const completedTask = await runtime.orchestrator.resumeTask(waitingTask.id);
    assert.equal(completedTask.status, TaskStatus.Completed);

    const resumedActionStep = completedTask.steps.find((step) => step.agent === AgentKind.Action);
    assert.equal(resumedActionStep?.status, StepStatus.Completed);

    const executedApproval = await runtime.approvalRequestRepository.getById(approval.id);
    assert.equal(executedApproval?.status, ApprovalStatus.Executed);
  } finally {
    if (previousWebhookUrl === undefined) {
      delete process.env.OPENCLAW_ACTION_WEBHOOK_URL;
    } else {
      process.env.OPENCLAW_ACTION_WEBHOOK_URL = previousWebhookUrl;
    }
  }
});

test("queue worker consumes execute and resume jobs end-to-end", async () => {
  const previousWebhookUrl = process.env.OPENCLAW_ACTION_WEBHOOK_URL;
  process.env.OPENCLAW_ACTION_WEBHOOK_URL = "https://example.test/webhook";
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-queue-"));
  try {
    const runtime = buildDemoRuntime(workspaceRoot, new ConsoleLogger(false));
    const worker = new TaskQueueWorker(
      runtime.orchestrator,
      runtime.taskJobRepository,
      runtime.taskEventRepository,
      new ConsoleLogger(false),
      "worker_test"
    );

    const task = await runtime.orchestrator.prepareTask({
      userId: "user_queue",
      goal: "帮我调研迪拜新能源租车市场，生成报告后通过 webhook 通知我"
    });
    const executeJob = await runtime.taskJobRepository.enqueue(
      createTaskJob(task.id, TaskJobKind.ExecuteTask)
    );

    const ranExecuteJob = await worker.runNextJob();
    assert.equal(ranExecuteJob, true);

    const waitingTask = await runtime.taskRepository.getById(task.id);
    assert.ok(waitingTask);
    assert.equal(waitingTask.status, TaskStatus.WaitingApproval);

    const completedExecuteJob = await runtime.taskJobRepository.getById(executeJob.id);
    assert.equal(completedExecuteJob?.status, TaskJobStatus.Completed);

    const approval = (await runtime.approvalRequestRepository.listPending())[0];
    assert.ok(approval);
    approval.status = ApprovalStatus.Approved;
    approval.decidedAt = new Date().toISOString();
    approval.decidedBy = "queue_test";
    await runtime.approvalRequestRepository.update(approval);

    const resumeJob = await runtime.taskJobRepository.enqueue(
      createTaskJob(task.id, TaskJobKind.ResumeTask)
    );
    const ranResumeJob = await worker.runNextJob();
    assert.equal(ranResumeJob, true);

    const completedTask = await runtime.taskRepository.getById(task.id);
    assert.ok(completedTask);
    assert.equal(completedTask.status, TaskStatus.Completed);

    const completedResumeJob = await runtime.taskJobRepository.getById(resumeJob.id);
    assert.equal(completedResumeJob?.status, TaskJobStatus.Completed);
  } finally {
    if (previousWebhookUrl === undefined) {
      delete process.env.OPENCLAW_ACTION_WEBHOOK_URL;
    } else {
      process.env.OPENCLAW_ACTION_WEBHOOK_URL = previousWebhookUrl;
    }
  }
});

test("prepare job creates a plan and enqueues execute work", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-prepare-"));
  const runtime = buildDemoRuntime(workspaceRoot, new ConsoleLogger(false));
  const worker = new TaskQueueWorker(
    runtime.orchestrator,
    runtime.taskJobRepository,
    runtime.taskEventRepository,
    new ConsoleLogger(false),
    "worker_prepare_test"
  );

  const task = await runtime.orchestrator.createDraftTask({
    userId: "user_prepare",
    goal: "帮我调研迪拜新能源租车市场并做一个报告"
  });
  assert.equal(task.status, TaskStatus.Created);

  const prepareJob = await runtime.taskJobRepository.enqueue(
    createTaskJob(task.id, TaskJobKind.PrepareTask)
  );

  const ranPrepareJob = await worker.runNextJob();
  assert.equal(ranPrepareJob, true);

  const preparedTask = await runtime.taskRepository.getById(task.id);
  assert.ok(preparedTask);
  assert.equal(preparedTask.status, TaskStatus.Planned);
  assert.ok(preparedTask.steps.length > 0);

  const completedPrepareJob = await runtime.taskJobRepository.getById(prepareJob.id);
  assert.equal(completedPrepareJob?.status, TaskJobStatus.Completed);

  const followUpJobs = await runtime.taskJobRepository.listByTask(task.id);
  assert.equal(followUpJobs.some((job) => job.kind === TaskJobKind.ExecuteTask), true);
});

test("prepareTaskById prefixes legacy draft goals before routing", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-legacy-prefix-"));
  const runtime = buildDemoRuntime(workspaceRoot, new ConsoleLogger(false));
  let routedGoal = "";

  (
    runtime.orchestrator as unknown as {
      routerAgent: {
        route: (goal: string) => Promise<{
          route: "single_step";
          intent: string;
          reason: string;
          confidence: number;
          missingInfo: string[];
          riskFlags: string[];
        }>;
      };
    }
  ).routerAgent = {
    route: async (goal: string) => {
      routedGoal = goal;
      return {
        route: "single_step",
        intent: "task_execution",
        reason: "test route",
        confidence: 0.91,
        missingInfo: [],
        riskFlags: []
      };
    }
  };

  const task = await runtime.orchestrator.createDraftTask({
    userId: "user_legacy_prepare",
    goal: "Create a short markdown note about the outage"
  });

  const preparedTask = await runtime.orchestrator.prepareTaskById(task.id);
  assert.equal(routedGoal, "TASK: Create a short markdown note about the outage");
  assert.equal(preparedTask.goal, "TASK: Create a short markdown note about the outage");
  assert.equal(preparedTask.status, TaskStatus.Planned);
});

test("prepare job forces TASK-prefixed goals through planning even if router asks for clarification", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-task-prefix-"));
  const runtime = buildDemoRuntime(workspaceRoot, new ConsoleLogger(false));
  const worker = new TaskQueueWorker(
    runtime.orchestrator,
    runtime.taskJobRepository,
    runtime.taskEventRepository,
    new ConsoleLogger(false),
    "worker_task_prefix_test"
  );

  (
    runtime.orchestrator as unknown as {
      routerAgent: {
        route: () => Promise<{
          route: "ask_clarification";
          intent: string;
          reason: string;
          confidence: number;
          missingInfo: string[];
          riskFlags: string[];
        }>;
      };
    }
  ).routerAgent = {
    route: async () => ({
      route: "ask_clarification",
      intent: "clarify",
      reason: "legacy router requested more details",
      confidence: 0.21,
      missingInfo: ["goal details"],
      riskFlags: []
    })
  };

  const task = await runtime.orchestrator.createDraftTask({
    userId: "user_task_prefix_prepare",
    goal: "   TASK: summarize the attached notes"
  });
  const prepareJob = await runtime.taskJobRepository.enqueue(
    createTaskJob(task.id, TaskJobKind.PrepareTask)
  );

  const ranPrepareJob = await worker.runNextJob();
  assert.equal(ranPrepareJob, true);

  const preparedTask = await runtime.taskRepository.getById(task.id);
  assert.ok(preparedTask);
  assert.equal(preparedTask.status, TaskStatus.Planned);
  assert.ok(preparedTask.steps.length > 0);

  const completedPrepareJob = await runtime.taskJobRepository.getById(prepareJob.id);
  assert.equal(completedPrepareJob?.status, TaskJobStatus.Completed);
});

test("cancel immediately terminalizes created tasks and records cancel events", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-cancel-created-"));
  const runtime = buildDemoRuntime(workspaceRoot, new ConsoleLogger(false));

  const task = await runtime.orchestrator.createDraftTask({
    userId: "user_cancel_created",
    goal: "TASK: 写一段简短摘要"
  });

  const cancelledTask = await runtime.orchestrator.requestCancel(task.id);
  assert.equal(cancelledTask.status, TaskStatus.Cancelled);
  assert.ok(cancelledTask.cancelRequestedAt);

  const events = await runtime.taskEventRepository.listByTask(task.id);
  assert.equal(
    events.some(
      (event) => event.kind === TaskEventKind.TaskStatusChanged && event.message === "Task cancelled"
    ),
    true
  );
});

test("cancel on running tasks is cooperative and records cancelRequestedAt", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-cancel-running-"));
  const runtime = buildDemoRuntime(workspaceRoot, new ConsoleLogger(false));

  const task = await runtime.orchestrator.prepareTask({
    userId: "user_cancel_running",
    goal: "TASK: 写一段简短摘要"
  });
  task.status = TaskStatus.Running;
  task.steps[0]!.status = StepStatus.Running;
  await runtime.taskRepository.update(task);

  const cancelRequestedTask = await runtime.orchestrator.requestCancel(task.id);
  assert.equal(cancelRequestedTask.status, TaskStatus.Running);
  assert.ok(cancelRequestedTask.cancelRequestedAt);

  const events = await runtime.taskEventRepository.listByTask(task.id);
  assert.equal(
    events.some(
      (event) =>
        event.kind === TaskEventKind.TaskStatusChanged && event.message === "Cancellation requested"
    ),
    true
  );
});

test("retry creates a rerun task with retryOfTaskId and enqueues prepare work", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-retry-task-"));
  const runtime = buildDemoRuntime(workspaceRoot, new ConsoleLogger(false));

  const sourceTask = await runtime.orchestrator.createDraftTask({
    userId: "user_retry",
    goal: "TASK: 写一段简短摘要"
  });
  await runtime.orchestrator.requestCancel(sourceTask.id);

  const result = await runtime.orchestrator.createRetryTask(sourceTask.id);
  assert.equal(result.sourceTask.status, TaskStatus.Cancelled);
  assert.equal(result.retryTask.status, TaskStatus.Created);
  assert.equal(result.retryTask.retryOfTaskId, sourceTask.id);
  assert.equal(result.job.kind, TaskJobKind.PrepareTask);

  const retryJobs = await runtime.taskJobRepository.listByTask(result.retryTask.id);
  assert.equal(retryJobs.some((job) => job.kind === TaskJobKind.PrepareTask), true);

  const retryEvents = await runtime.taskEventRepository.listByTask(result.retryTask.id);
  assert.equal(
    retryEvents.some(
      (event) =>
        event.kind === TaskEventKind.TaskStatusChanged &&
        event.message === `Retry task created from ${sourceTask.id}`
    ),
    true
  );
  assert.equal(
    retryEvents.some(
      (event) => event.kind === TaskEventKind.Job && event.message === "PREPARE_TASK enqueued"
    ),
    true
  );
});

test("retry clones uploaded artifacts into the rerun task workspace", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-retry-upload-"));
  const runtime = buildDemoRuntime(workspaceRoot, new ConsoleLogger(false));

  const sourceTask = await runtime.orchestrator.createDraftTask({
    userId: "user_retry_upload",
    goal: "TASK: 分析上传的 csv 并生成报告"
  });
  const sourceUploadPath = path.join(workspaceRoot, sourceTask.id, "uploads", "numbers.csv");
  await fs.mkdir(path.dirname(sourceUploadPath), { recursive: true });
  await fs.writeFile(sourceUploadPath, "value\n12\n18\n", "utf8");
  await runtime.artifactRepository.save({
    id: "artifact_upload_source",
    taskId: sourceTask.id,
    type: ArtifactType.Spreadsheet,
    uri: sourceUploadPath,
    metadata: {
      uploaded: true,
      originalFilename: "numbers.csv"
    },
    createdAt: new Date().toISOString()
  });
  await runtime.orchestrator.requestCancel(sourceTask.id);

  const result = await runtime.orchestrator.createRetryTask(sourceTask.id);
  const retryArtifacts = await runtime.artifactRepository.listByTask(result.retryTask.id);
  const clonedUpload = retryArtifacts.find((artifact) => artifact.metadata["uploaded"] === true);
  assert.ok(clonedUpload);
  assert.notEqual(clonedUpload?.uri, sourceUploadPath);
  assert.equal(clonedUpload?.uri.startsWith(path.join(workspaceRoot, result.retryTask.id, "uploads")), true);
  const contents = await fs.readFile(String(clonedUpload?.uri), "utf8");
  assert.match(contents, /12/);
});

test("retryable prepare job failures are requeued and reset draft tasks", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-job-retry-"));
  const runtime = buildDemoRuntime(workspaceRoot, new ConsoleLogger(false));
  const worker = new TaskQueueWorker(
    runtime.orchestrator,
    runtime.taskJobRepository,
    runtime.taskEventRepository,
    new ConsoleLogger(false),
    "worker_retry_test"
  );

  const task = await runtime.orchestrator.createDraftTask({
    userId: "user_job_retry",
    goal: "TASK: 生成一个简短 markdown 报告"
  });
  const job = await runtime.taskJobRepository.enqueue(
    createTaskJob(task.id, TaskJobKind.PrepareTask)
  );

  const originalPrepareTaskById = runtime.orchestrator.prepareTaskById.bind(runtime.orchestrator);
  let attempts = 0;
  runtime.orchestrator.prepareTaskById = async (taskId: string) => {
    attempts += 1;
    if (attempts === 1) {
      const failedTask = await runtime.taskRepository.getById(taskId);
      assert.ok(failedTask);
      failedTask.status = TaskStatus.Failed;
      failedTask.updatedAt = new Date().toISOString();
      await runtime.taskRepository.update(failedTask);
      throw new Error("network timeout while planning");
    }
    return originalPrepareTaskById(taskId);
  };

  const firstRun = await worker.runNextJob();
  assert.equal(firstRun, true);

  const requeuedJob = await runtime.taskJobRepository.getById(job.id);
  assert.equal(requeuedJob?.status, TaskJobStatus.Pending);

  const resetTask = await runtime.taskRepository.getById(task.id);
  assert.equal(resetTask?.status, TaskStatus.Created);

  const secondRun = await worker.runNextJob();
  assert.equal(secondRun, true);

  const finalJob = await runtime.taskJobRepository.getById(job.id);
  assert.equal(finalJob?.status, TaskJobStatus.Completed);

  const preparedTask = await runtime.taskRepository.getById(task.id);
  assert.ok(preparedTask);
  assert.equal(preparedTask.status, TaskStatus.Planned);
});

test("stale running jobs can be reclaimed after lease expiry", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-lease-"));
  const runtime = buildDemoRuntime(workspaceRoot, new ConsoleLogger(false));
  const task = await runtime.orchestrator.prepareTask({
    userId: "user_lease",
    goal: "帮我调研迪拜新能源租车市场并做一个报告"
  });
  const job = await runtime.taskJobRepository.enqueue(
    createTaskJob(task.id, TaskJobKind.ExecuteTask)
  );

  const firstClaim = await runtime.taskJobRepository.claimNext("worker_a", 1_000);
  assert.ok(firstClaim);
  assert.equal(firstClaim.id, job.id);
  assert.equal(firstClaim.lockedBy, "worker_a");
  assert.equal(firstClaim.status, TaskJobStatus.Running);

  const heartbeatOk = await runtime.taskJobRepository.heartbeat(job.id, "worker_a");
  assert.equal(heartbeatOk, true);

  const notYetReclaimed = await runtime.taskJobRepository.claimNext("worker_b", 1_000);
  assert.equal(notYetReclaimed, undefined);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const reclaimed = await runtime.taskJobRepository.claimNext("worker_b", 1);
  assert.ok(reclaimed);
  assert.equal(reclaimed.id, job.id);
  assert.equal(reclaimed.lockedBy, "worker_b");
  assert.equal(reclaimed.status, TaskJobStatus.Running);
  assert.equal(reclaimed.attempts, 2);
});

test("completed task prefers real deliverables over debug artifacts as final artifact", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manus-final-artifact-"));
  const runtime = buildDemoRuntime(workspaceRoot, new ConsoleLogger(false));
  const task = createTaskFromPlan("user_pdf", "TASK: 导出一份 PDF 简报", {
    goal: "TASK: 导出一份 PDF 简报",
    assumptions: [],
    steps: [
      {
        id: "s1",
        title: "撰写简报",
        agent: AgentKind.Document,
        objective: "生成 markdown 简报",
        dependsOn: [],
        inputs: [],
        expectedOutput: "report.md",
        successCriteria: ["输出 markdown"]
      },
      {
        id: "s2",
        title: "导出 PDF",
        agent: AgentKind.Coding,
        objective: "将 markdown 导出为 PDF",
        dependsOn: ["s1"],
        inputs: [],
        expectedOutput: "brief.pdf",
        successCriteria: ["输出 pdf"]
      }
    ],
    taskSuccessCriteria: ["交付 pdf"]
  });

  task.steps[0]!.status = StepStatus.Completed;
  task.steps[0]!.outputArtifacts = [
    path.join(workspaceRoot, task.id, "report.md")
  ];
  task.steps[1]!.status = StepStatus.Completed;
  task.steps[1]!.outputArtifacts = [
    path.join(workspaceRoot, task.id, "pdf-export.json"),
    path.join(workspaceRoot, task.id, "brief.pdf")
  ];

  await runtime.taskRepository.create(task);

  const completedTask = await runtime.orchestrator.runTaskById(task.id);
  assert.equal(completedTask.status, TaskStatus.Completed);
  assert.equal(
    completedTask.finalArtifactUri,
    path.join(workspaceRoot, task.id, "brief.pdf")
  );
});
