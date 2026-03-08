const state = {
  selectedTaskId: null,
  tasks: [],
  selectedBundle: null,
  recipes: [],
  qualityMetrics: null,
  benchmarkRuns: [],
  pollingHandle: null,
  eventStream: null,
  autoRefresh: true
};

const $ = (id) => document.getElementById(id);

const el = {
  runtimeMode: $("runtime-mode"),
  runtimeDetail: $("runtime-detail"),
  taskForm: $("task-form"),
  userId: $("user-id"),
  goal: $("goal"),
  recipeId: $("recipe-id"),
  createUploadInput: $("create-upload-input"),
  submitResult: $("submit-result"),
  refreshButton: $("refresh-button"),
  taskList: $("task-list"),
  taskCount: $("task-count"),
  qualityMetrics: $("quality-metrics"),
  benchmarkRuns: $("benchmark-runs"),
  runSmokeBenchmark: $("run-smoke-benchmark"),
  selectedTaskStatus: $("selected-task-status"),
  detailEmpty: $("detail-empty"),
  detailBody: $("detail-body"),
  detailTaskId: $("detail-task-id"),
  detailGoal: $("detail-goal"),
  taskControls: $("task-controls"),
  taskActionResult: $("task-action-result"),
  taskUploadInput: $("task-upload-input"),
  taskUploadButton: $("task-upload-button"),
  finalArtifactPanel: $("final-artifact-panel"),
  finalValidationPanel: $("final-validation-panel"),
  referenceList: $("reference-list"),
  stepList: $("step-list"),
  approvalList: $("approval-list"),
  jobList: $("job-list"),
  artifactList: $("artifact-list"),
  indexedArtifactList: $("indexed-artifact-list"),
  toolCallList: $("tool-call-list"),
  eventList: $("event-list"),
  artifactPreview: $("artifact-preview"),
  stepTimeline: $("step-timeline"),
  themeToggle: $("theme-toggle"),
  autoRefreshToggle: $("auto-refresh-toggle")
};

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const jsonFetch = async (url, options = {}) => {
  const response = await fetch(url, options);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
};

const setPreviewMessage = (message) => {
  el.artifactPreview.innerHTML = `<p class="muted">${escapeHtml(message)}</p>`;
};

const uploadSelectedFiles = async () => {
  if (!state.selectedTaskId) {
    throw new Error("请先选择任务。");
  }
  const files = Array.from(el.taskUploadInput.files || []);
  if (files.length === 0) {
    throw new Error("请先选择要上传的文件。");
  }

  const uploaded = [];
  for (const file of files) {
    const response = await fetch(
      `/tasks/${state.selectedTaskId}/uploads?filename=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream"
        },
        body: file
      }
    );
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(payload.error || `上传失败: ${response.status}`);
    }
    uploaded.push(payload.artifact?.uri || file.name);
  }

  el.taskUploadInput.value = "";
  return uploaded;
};

const uploadFilesForTask = async (taskId, files) => {
  const uploaded = [];
  for (const file of files) {
    const response = await fetch(`/tasks/${taskId}/uploads?filename=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: {
        "content-type": file.type || "application/octet-stream"
      },
      body: file
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(payload.error || `上传失败: ${response.status}`);
    }
    uploaded.push(payload.artifact?.uri || file.name);
  }
  return uploaded;
};

const renderStepTimeline = (steps) => {
  if (!steps || steps.length === 0) {
    return "";
  }
  return steps
    .map((step) => `<div class="step-timeline-bar" data-status="${escapeHtml(step.status)}" title="${escapeHtml(step.title)}"></div>`)
    .join("");
};

const renderRuntime = async () => {
  try {
    const runtime = await jsonFetch("/runtime");
    el.runtimeMode.textContent = `${runtime.agentMode}/${runtime.toolMode}`;
    el.runtimeDetail.textContent = `browser=${runtime.browserMode} db=${runtime.dbMode}`;
  } catch (error) {
    el.runtimeMode.textContent = "error";
    el.runtimeDetail.textContent = error.message;
  }
};

const renderTaskList = () => {
  el.taskCount.textContent = String(state.tasks.length);
  if (state.tasks.length === 0) {
    el.taskList.innerHTML = `<div class="task-card"><p class="muted">还没有任务。</p></div>`;
    return;
  }

  el.taskList.innerHTML = state.tasks
    .map(
      (task) => `
        <article class="task-card ${task.id === state.selectedTaskId ? "active" : ""}" data-task-id="${task.id}">
          <div class="card-title">${escapeHtml(task.goal || task.id)}</div>
          <div class="card-meta">
            <span class="status-${String(task.status).toLowerCase()}">${escapeHtml(task.status)}</span>
            <span>${escapeHtml(task.updatedAt || task.createdAt || "-")}</span>
          </div>
        </article>
      `
    )
    .join("");

  el.taskList.querySelectorAll("[data-task-id]").forEach((node) => {
    node.addEventListener("click", () => {
      state.selectedTaskId = node.getAttribute("data-task-id");
      void refreshSelectedTask();
      renderTaskList();
    });
  });
};

const renderRecipeOptions = () => {
  const options = [
    `<option value="">自动匹配</option>`,
    ...state.recipes.map(
      (recipe) => `<option value="${escapeHtml(recipe.id)}">${escapeHtml(recipe.title)}</option>`
    )
  ];
  el.recipeId.innerHTML = options.join("");
};

const renderQualityMetrics = () => {
  const metrics = state.qualityMetrics;
  if (!metrics || !metrics.taskClasses) {
    el.qualityMetrics.innerHTML = `<div class="event-card"><p class="muted">暂无质量指标。</p></div>`;
    return;
  }

  const entries = Object.entries(metrics.taskClasses);
  if (entries.length === 0) {
    el.qualityMetrics.innerHTML = `<div class="event-card"><p class="muted">暂无质量指标。</p></div>`;
    return;
  }

  el.qualityMetrics.innerHTML = entries
    .map(([taskClass, entry]) => {
      const total = Number(entry.total || 0);
      const completed = Number(entry.completed || 0);
      const failed = Number(entry.failed || 0);
      const fallbackUsed = Number(entry.fallbackUsed || 0);
      const completionRate = total > 0 ? `${Math.round((completed / total) * 100)}%` : "0%";
      return `
        <article class="event-card">
          <div class="card-title">${escapeHtml(taskClass)}</div>
          <div class="card-meta">
            <span>steps=${escapeHtml(total)}</span>
            <span>complete=${escapeHtml(completionRate)}</span>
          </div>
          <p>completed=${escapeHtml(completed)} failed=${escapeHtml(failed)} fallback=${escapeHtml(fallbackUsed)}</p>
        </article>
      `;
    })
    .join("");
};

const renderBenchmarkRuns = () => {
  if (!state.benchmarkRuns.length) {
    el.benchmarkRuns.innerHTML = `<div class="event-card"><p class="muted">暂无 benchmark 运行。</p></div>`;
    return;
  }

  el.benchmarkRuns.innerHTML = state.benchmarkRuns
    .map(
      (run) => `
        <article class="event-card">
          <div class="card-title">${escapeHtml(run.name)}</div>
          <div class="card-meta">
            <span>${escapeHtml(run.suite)}</span>
            <span class="status-${String(run.status).toLowerCase()}">${escapeHtml(run.status)}</span>
          </div>
          <p>items=${escapeHtml(run.items?.length || 0)} started=${escapeHtml(run.startedAt || "-")}</p>
        </article>
      `
    )
    .join("");
};

const renderSteps = (steps) =>
  steps
    .map(
      (step) => `
        <article class="step-card" data-step-id="${escapeHtml(step.id)}">
          <div class="step-title">${escapeHtml(step.title)}</div>
          <div class="step-meta">
            <span>${escapeHtml(step.agent)}</span>
            <span class="status-${String(step.status).toLowerCase()}">${escapeHtml(step.status)}</span>
            <span>retry=${escapeHtml(step.retryCount)}</span>
            ${step.taskClass ? `<span>class=${escapeHtml(step.taskClass)}</span>` : ""}
            ${typeof step.qualityScore === "number" ? `<span>quality=${escapeHtml(step.qualityScore)}</span>` : ""}
            ${
              step.structuredData?.llmFallbackUsed
                ? `<span>fallback=${escapeHtml(step.structuredData.llmFallbackCategory || "local")}</span>`
                : ""
            }
            ${
              step.attemptStrategy?.strategy
                ? `<span>strategy=${escapeHtml(step.attemptStrategy.strategy)}</span>`
                : ""
            }
          </div>
          <p>${escapeHtml(step.objective)}</p>
          ${step.summary ? `<p><strong>Summary:</strong> ${escapeHtml(step.summary)}</p>` : ""}
          ${
            Array.isArray(step.qualityDefects) && step.qualityDefects.length > 0
              ? `<p><strong>Defects:</strong> ${escapeHtml(step.qualityDefects.join("; "))}</p>`
              : ""
          }
          ${
            Array.isArray(step.missingEvidence) && step.missingEvidence.length > 0
              ? `<p><strong>Missing Evidence:</strong> ${escapeHtml(step.missingEvidence.join("; "))}</p>`
              : ""
          }
          ${
            typeof step.sourceCoverageScore === "number"
              ? `<p><strong>Source Coverage:</strong> ${escapeHtml(step.sourceCoverageScore)}</p>`
              : ""
          }
          ${
            step.formatCompliance
              ? `<p><strong>Format:</strong> ${escapeHtml(step.formatCompliance)}</p>`
              : ""
          }
          ${
            step.structuredData?.artifactValidation
              ? `<p><strong>Artifact Validation:</strong> ${escapeHtml(JSON.stringify(step.structuredData.artifactValidation))}</p>`
              : ""
          }
          ${
            step.error
              ? `
                <p class="error-toggle" data-error-toggle>▸ Error: ${escapeHtml(step.error.message || step.error.code)}</p>
                <div class="error-detail">
                  code: ${escapeHtml(step.error.code || "-")}<br>
                  message: ${escapeHtml(step.error.message || "-")}<br>
                  stage: ${escapeHtml(step.error.stage || "-")}<br>
                  category: ${escapeHtml(step.error.category || "-")}<br>
                  retryable: ${escapeHtml(String(Boolean(step.error.retryable)))}<br>
                  fallback: ${escapeHtml(step.error.fallbackKind || "-")}
                </div>
              `
              : ""
          }
        </article>
      `
    )
    .join("");

const renderTaskControls = (task) => {
  if (!task) {
    return "";
  }

  const controls = [];
  if (task.status === "CREATED") {
    controls.push(`<button data-start-task="${task.id}">开始任务</button>`);
  }
  if (task.status === "WAITING_APPROVAL") {
    controls.push(`<button data-resume-task="${task.id}">手动 resume</button>`);
  }
  if (task.status === "FAILED" || task.status === "CANCELLED") {
    controls.push(`<button data-retry-task="${task.id}">重试任务</button>`);
  }
  if (
    ["CREATED", "PLANNED", "RUNNING", "RETRYING", "VERIFYING", "WAITING_APPROVAL"].includes(
      task.status
    ) &&
    !task.cancelRequestedAt
  ) {
    controls.push(`<button class="ghost" data-cancel-task="${task.id}">取消任务</button>`);
  }

  if (task.cancelRequestedAt) {
    controls.push(`<span class="pill status-cancelled">取消请求中</span>`);
  }

  return controls.length > 0 ? controls.join("") : `<p class="muted">当前任务暂无可执行操作。</p>`;
};

const renderFinalArtifact = (task, artifacts) => {
  if (!task?.finalArtifactUri) {
    return `<div class="artifact-card"><p class="muted">最终交付物尚未生成。</p></div>`;
  }

  const artifact = artifacts.find((candidate) => candidate.uri === task.finalArtifactUri);
  const contentUrl = artifact?.contentUrl;
  const label = artifact?.type || "final";
  const displayName = artifact?.name || task.finalArtifactUri;

  return `
    <article class="artifact-card final-artifact-card">
      <div class="card-title">${escapeHtml(displayName)}</div>
      <div class="card-meta">
        <span>${escapeHtml(label)}</span>
        <span>final</span>
      </div>
      <div class="task-actions">
        ${
          contentUrl
            ? `<button data-preview="${contentUrl}" data-uri="${task.finalArtifactUri}">预览</button>`
            : ""
        }
        ${
          contentUrl
            ? `<a href="${contentUrl}" download rel="noreferrer"><button type="button">下载</button></a>`
            : ""
        }
        ${
          contentUrl
            ? `<a href="${contentUrl}" target="_blank" rel="noreferrer"><button type="button" class="ghost">打开</button></a>`
            : ""
        }
      </div>
    </article>
  `;
};

const renderFinalValidation = (validation) => {
  if (!validation) {
    return `<div class="artifact-card"><p class="muted">最终交付物尚未完成校验。</p></div>`;
  }

  return `
    <article class="artifact-card">
      <div class="card-title">${validation.validated ? "validated" : "needs review"}</div>
      <div class="card-meta">
        ${validation.artifactType ? `<span>${escapeHtml(validation.artifactType)}</span>` : ""}
        ${validation.deliveryKind ? `<span>${escapeHtml(validation.deliveryKind)}</span>` : ""}
        ${
          typeof validation.pageCount === "number"
            ? `<span>pages=${escapeHtml(validation.pageCount)}</span>`
            : ""
        }
      </div>
      ${
        Array.isArray(validation.issues) && validation.issues.length > 0
          ? `<p>${escapeHtml(validation.issues.join("; "))}</p>`
          : `<p class="muted">未发现阻断问题。</p>`
      }
    </article>
  `;
};

const renderReferences = (references) => {
  if (!references || references.length === 0) {
    return `<div class="artifact-card"><p class="muted">当前任务暂无历史引用。</p></div>`;
  }

  return references
    .map(
      (reference) => `
        <article class="artifact-card">
          <div class="card-title">${escapeHtml(reference.reason)}</div>
          <div class="card-meta">
            ${reference.sourceTaskId ? `<span>task=${escapeHtml(reference.sourceTaskId)}</span>` : ""}
            ${reference.sourceArtifactId ? `<span>artifact=${escapeHtml(reference.sourceArtifactId)}</span>` : ""}
          </div>
        </article>
      `
    )
    .join("");
};

const renderIndexedArtifacts = (indexedArtifacts) => {
  if (!indexedArtifacts || indexedArtifacts.length === 0) {
    return `<div class="tool-call-card"><p class="muted">暂无已索引产物。</p></div>`;
  }

  return indexedArtifacts
    .map(
      (artifact) => `
        <article class="tool-call-card">
          <div class="card-title">${escapeHtml(artifact.title || artifact.artifactType)}</div>
          <div class="tool-call-meta">
            <span>${escapeHtml(artifact.artifactType)}</span>
            <span>${artifact.validated ? "validated" : "unvalidated"}</span>
            ${artifact.taskClass ? `<span>${escapeHtml(artifact.taskClass)}</span>` : ""}
          </div>
          ${artifact.summary ? `<p>${escapeHtml(artifact.summary)}</p>` : ""}
        </article>
      `
    )
    .join("");
};

const renderApprovals = (approvals) => {
  if (!approvals.length) {
    return `<div class="approval-card"><p class="muted">无审批节点。</p></div>`;
  }

  return approvals
    .map(
      (approval) => `
        <article class="approval-card">
          <div class="card-title">${escapeHtml(approval.action)}</div>
          <div class="card-meta">
            <span>${escapeHtml(approval.toolName)}</span>
            <span class="status-${String(approval.status).toLowerCase()}">${escapeHtml(approval.status)}</span>
          </div>
          <p>${escapeHtml(approval.reason)}</p>
          ${
            approval.status === "PENDING"
              ? `
                <div class="approval-actions">
                  <button data-approve="${approval.id}">批准</button>
                  <button class="ghost" data-reject="${approval.id}">拒绝</button>
                </div>
              `
              : ""
          }
        </article>
      `
    )
    .join("");
};

const renderJobs = (jobs) => {
  if (!jobs.length) {
    return `<div class="job-card"><p class="muted">暂无作业。</p></div>`;
  }

  return jobs
    .map(
      (job) => `
        <article class="job-card">
          <div class="card-title">${escapeHtml(job.kind)}</div>
          <div class="card-meta">
            <span class="status-${String(job.status).toLowerCase()}">${escapeHtml(job.status)}</span>
            <span>attempts=${escapeHtml(job.attempts)}</span>
          </div>
          ${job.lastError ? `<p>${escapeHtml(job.lastError)}</p>` : ""}
        </article>
      `
    )
    .join("");
};

const renderArtifacts = (artifacts, finalArtifactUri) => {
  if (!artifacts.length) {
    return `<div class="artifact-card"><p class="muted">暂无产物。</p></div>`;
  }

  return artifacts
    .map(
      (artifact) => `
        <article class="artifact-card">
          <div class="card-title">${escapeHtml(artifact.name || artifact.type)}</div>
          <div class="card-meta">
            <span>${escapeHtml(artifact.type)}</span>
            ${artifact.uploaded ? `<span>uploaded</span>` : ""}
            ${artifact.uri === finalArtifactUri ? `<span>final</span>` : ""}
          </div>
          <p class="muted">${escapeHtml(artifact.uri)}</p>
          <div class="task-actions">
            <button data-preview="${artifact.contentUrl}" data-uri="${artifact.uri}">预览</button>
            <a href="${artifact.contentUrl}" download rel="noreferrer"><button type="button">下载</button></a>
            <a href="${artifact.contentUrl}" target="_blank" rel="noreferrer"><button type="button" class="ghost">打开</button></a>
          </div>
        </article>
      `
    )
    .join("");
};

const renderToolCalls = (toolCalls) => {
  if (!toolCalls.length) {
    return `<div class="tool-call-card"><p class="muted">暂无工具调用。</p></div>`;
  }

  return toolCalls
    .map(
      (call) => `
        <article class="tool-call-card">
          <div class="card-title">${escapeHtml(call.toolName)} / ${escapeHtml(call.action)}</div>
          <div class="tool-call-meta">
            <span>${escapeHtml(call.callerAgent)}</span>
            <span>${escapeHtml(call.status)}</span>
            <span>${escapeHtml(call.durationMs)}ms</span>
          </div>
        </article>
      `
    )
    .join("");
};

const renderEvents = (events) => {
  if (!events.length) {
    return `<div class="event-card"><p class="muted">暂无事件。</p></div>`;
  }

  return events
    .map(
      (event) => `
        <article class="event-card">
          <div class="card-title">${escapeHtml(event.kind)}</div>
          <div class="card-meta">
            <span class="status-${String(event.level).toLowerCase()}">${escapeHtml(event.level)}</span>
            <span>${escapeHtml(event.createdAt)}</span>
            ${event.stepId ? `<button type="button" class="ghost" data-focus-step="${escapeHtml(event.stepId)}">定位步骤</button>` : ""}
          </div>
          <p>${escapeHtml(event.message)}</p>
        </article>
      `
    )
    .join("");
};

const focusStep = (stepId) => {
  const target = el.stepList.querySelector(`[data-step-id="${CSS.escape(stepId)}"]`);
  if (!target) {
    return;
  }
  target.classList.add("flash");
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  window.setTimeout(() => target.classList.remove("flash"), 1800);
};

const stopEventStream = () => {
  if (state.eventStream) {
    state.eventStream.close();
    state.eventStream = null;
  }
};

const startEventStream = () => {
  stopEventStream();
  if (!state.selectedTaskId) {
    return;
  }

  const stream = new EventSource(`/tasks/${state.selectedTaskId}/logs/stream?limit=200`);
  stream.addEventListener("task_event", (event) => {
    const payload = JSON.parse(event.data);
    const currentEvents = Array.isArray(state.selectedBundle?.events) ? state.selectedBundle.events : [];
    if (currentEvents.some((candidate) => candidate.id === payload.id)) {
      return;
    }

    if (state.selectedBundle) {
      state.selectedBundle.events = [...currentEvents, payload].slice(-200);
      el.eventList.innerHTML = renderEvents(state.selectedBundle.events);
      bindEventInteractions();
    }
  });
  stream.addEventListener("error", () => {
    stream.close();
    state.eventStream = null;
  });
  state.eventStream = stream;
};

const bindEventInteractions = () => {
  el.eventList.querySelectorAll("[data-focus-step]").forEach((button) => {
    button.addEventListener("click", () => {
      focusStep(button.getAttribute("data-focus-step"));
    });
  });
};

const renderSelectedTask = () => {
  const bundle = state.selectedBundle;
  if (!bundle) {
    el.detailEmpty.classList.remove("hidden");
    el.detailBody.classList.add("hidden");
    el.selectedTaskStatus.textContent = "未选择";
    el.taskControls.innerHTML = "";
    el.taskActionResult.textContent = "等待操作。";
    el.eventList.innerHTML = "";
    el.finalValidationPanel.innerHTML = "";
    el.referenceList.innerHTML = "";
    el.indexedArtifactList.innerHTML = "";
    return;
  }

  el.detailEmpty.classList.add("hidden");
  el.detailBody.classList.remove("hidden");
  el.selectedTaskStatus.textContent = bundle.task.status;
  el.detailTaskId.textContent = bundle.task.id;
  el.detailGoal.textContent = bundle.task.goal;
  el.taskControls.innerHTML = renderTaskControls(bundle.task);
  el.finalArtifactPanel.innerHTML = renderFinalArtifact(bundle.task, bundle.artifacts || []);
  el.finalValidationPanel.innerHTML = renderFinalValidation(bundle.finalArtifactValidation);
  el.referenceList.innerHTML = renderReferences(bundle.references || []);
  el.stepTimeline.innerHTML = renderStepTimeline(bundle.task.steps || []);
  el.stepList.innerHTML = renderSteps(bundle.task.steps || []);
  el.approvalList.innerHTML = renderApprovals(bundle.approvals || []);
  el.jobList.innerHTML = renderJobs(bundle.jobs || []);
  el.artifactList.innerHTML = renderArtifacts(bundle.artifacts || [], bundle.task.finalArtifactUri);
  el.indexedArtifactList.innerHTML = renderIndexedArtifacts(bundle.indexedArtifacts || []);
  el.toolCallList.innerHTML = renderToolCalls(bundle.toolCalls || []);
  el.eventList.innerHTML = renderEvents(bundle.events || []);
  bindEventInteractions();

  el.stepList.querySelectorAll("[data-error-toggle]").forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const detail = toggle.nextElementSibling;
      if (detail && detail.classList.contains("error-detail")) {
        detail.classList.toggle("open");
        toggle.textContent = detail.classList.contains("open")
          ? toggle.textContent.replace("▸", "▾")
          : toggle.textContent.replace("▾", "▸");
      }
    });
  });

  el.taskControls.querySelectorAll("[data-start-task]").forEach((button) => {
    button.addEventListener("click", async () => {
      const taskId = button.getAttribute("data-start-task");
      const payload = await jsonFetch(`/tasks/${taskId}/start`, { method: "POST" });
      el.taskActionResult.textContent = `已提交启动作业 ${payload.job.id}`;
      await refreshTasks();
      await refreshSelectedTask();
    });
  });

  el.taskControls.querySelectorAll("[data-resume-task]").forEach((button) => {
    button.addEventListener("click", async () => {
      const taskId = button.getAttribute("data-resume-task");
      const payload = await jsonFetch(`/tasks/${taskId}/resume`, { method: "POST" });
      el.taskActionResult.textContent = `已提交 resume 作业 ${payload.job.id}`;
      await refreshTasks();
      await refreshSelectedTask();
    });
  });

  el.taskControls.querySelectorAll("[data-retry-task]").forEach((button) => {
    button.addEventListener("click", async () => {
      const taskId = button.getAttribute("data-retry-task");
      const payload = await jsonFetch(`/tasks/${taskId}/retry`, { method: "POST" });
      el.taskActionResult.textContent = `已创建 rerun 任务 ${payload.task.id}`;
      state.selectedTaskId = payload.task.id;
      await refreshTasks();
      await refreshSelectedTask();
    });
  });

  el.taskControls.querySelectorAll("[data-cancel-task]").forEach((button) => {
    button.addEventListener("click", async () => {
      const taskId = button.getAttribute("data-cancel-task");
      const payload = await jsonFetch(`/tasks/${taskId}/cancel`, { method: "POST" });
      el.taskActionResult.textContent = payload.task.cancelRequestedAt
        ? "已提交取消请求"
        : "任务已取消";
      await refreshTasks();
      await refreshSelectedTask();
    });
  });

  el.taskUploadButton.onclick = async () => {
    try {
      el.taskActionResult.textContent = "上传中...";
      const uploaded = await uploadSelectedFiles();
      el.taskActionResult.textContent = `已上传 ${uploaded.length} 个文件`;
      await refreshSelectedTask();
    } catch (error) {
      el.taskActionResult.textContent = error.message;
    }
  };

  el.approvalList.querySelectorAll("[data-approve]").forEach((button) => {
    button.addEventListener("click", async () => {
      await jsonFetch(`/approvals/${button.getAttribute("data-approve")}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decidedBy: "local_console", decisionNote: "approved in console" })
      });
      await refreshSelectedTask();
    });
  });

  el.approvalList.querySelectorAll("[data-reject]").forEach((button) => {
    button.addEventListener("click", async () => {
      await jsonFetch(`/approvals/${button.getAttribute("data-reject")}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decidedBy: "local_console", decisionNote: "rejected in console" })
      });
      await refreshSelectedTask();
    });
  });

  el.artifactList.querySelectorAll("[data-preview]").forEach((button) => {
    button.addEventListener("click", async () => {
      const contentUrl = button.getAttribute("data-preview");
      const uri = button.getAttribute("data-uri") || "";
      if (!contentUrl) {
        return;
      }

      if (/\.(png|jpg|jpeg|svg)$/i.test(uri)) {
        el.artifactPreview.innerHTML = `<img alt="artifact preview" src="${contentUrl}" />`;
        return;
      }

      if (/\.pdf$/i.test(uri)) {
        el.artifactPreview.innerHTML = `<iframe title="artifact preview" src="${contentUrl}"></iframe>`;
        return;
      }

      const response = await fetch(contentUrl);
      const text = await response.text();
      if (/\.md$/i.test(uri) && typeof marked !== "undefined") {
        el.artifactPreview.innerHTML = `<div class="md-preview">${marked.parse(text)}</div>`;
      } else {
        el.artifactPreview.innerHTML = `<pre>${escapeHtml(text)}</pre>`;
      }
    });
  });
};

const refreshTasks = async () => {
  const payload = await jsonFetch("/tasks?limit=30");
  state.tasks = payload.tasks || [];
  if (!state.selectedTaskId && state.tasks[0]) {
    state.selectedTaskId = state.tasks[0].id;
  }
  renderTaskList();
};

const refreshRecipes = async () => {
  const payload = await jsonFetch("/recipes");
  state.recipes = payload.recipes || [];
  renderRecipeOptions();
};

const refreshQualityMetrics = async () => {
  const payload = await jsonFetch("/metrics/quality");
  state.qualityMetrics = payload.metrics || null;
  renderQualityMetrics();
};

const refreshBenchmarkRuns = async () => {
  const payload = await jsonFetch("/benchmarks/runs?limit=12");
  state.benchmarkRuns = payload.runs || [];
  renderBenchmarkRuns();
};

const refreshSelectedTask = async () => {
  if (!state.selectedTaskId) {
    stopEventStream();
    state.selectedBundle = null;
    renderSelectedTask();
    return;
  }

  const bundle = await jsonFetch(`/tasks/${state.selectedTaskId}/detail`);
  state.selectedBundle = bundle;
  renderSelectedTask();
  startEventStream();
};

const submitTask = async (event) => {
  event.preventDefault();
  el.submitResult.textContent = "提交中...";

  try {
    const createFiles = Array.from(el.createUploadInput.files || []);
    const payload = await jsonFetch("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: el.userId.value.trim() || "local_console_user",
        goal: el.goal.value.trim(),
        recipeId: el.recipeId.value || undefined,
        deferStart: createFiles.length > 0
      })
    });
    let finalPayload = payload;

    if (createFiles.length > 0) {
      el.submitResult.textContent = `任务 ${payload.task.id} 已创建，正在上传附件...`;
      await uploadFilesForTask(payload.task.id, createFiles);
      finalPayload = await jsonFetch(`/tasks/${payload.task.id}/start`, {
        method: "POST"
      });
      el.createUploadInput.value = "";
    }

    el.submitResult.textContent = createFiles.length > 0
      ? `已接收任务 ${payload.task.id}，附件上传完成并已启动`
      : `已接收任务 ${payload.task.id}，当前状态 ${payload.task.status}`;
    el.taskActionResult.textContent = "等待操作。";
    state.selectedTaskId = payload.task.id;
    setPreviewMessage("任务已创建，等待产物生成。");
    await refreshTasks();
    await refreshSelectedTask();
  } catch (error) {
    el.submitResult.textContent = error.message;
  }
};

const refreshAll = async () => {
  await renderRuntime();
  await refreshRecipes();
  await refreshQualityMetrics();
  await refreshBenchmarkRuns();
  await refreshTasks();
  await refreshSelectedTask();
};

el.taskForm.addEventListener("submit", (event) => {
  void submitTask(event);
});

el.refreshButton.addEventListener("click", () => {
  void refreshAll();
});

el.runSmokeBenchmark.addEventListener("click", async () => {
  el.submitResult.textContent = "正在启动 smoke benchmark...";
  try {
    const payload = await jsonFetch("/benchmarks/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `smoke benchmark ${new Date().toISOString()}`,
        suite: "smoke"
      })
    });
    el.submitResult.textContent = `已启动 benchmark ${payload.run.id}`;
    await refreshBenchmarkRuns();
  } catch (error) {
    el.submitResult.textContent = error.message;
  }
});

const savedTheme = localStorage.getItem("openclaw-theme") || "light";
document.documentElement.setAttribute("data-theme", savedTheme);

el.themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("openclaw-theme", next);
});

el.autoRefreshToggle.checked = true;
el.autoRefreshToggle.addEventListener("change", () => {
  state.autoRefresh = el.autoRefreshToggle.checked;
  if (state.autoRefresh && !state.pollingHandle) {
    state.pollingHandle = window.setInterval(pollingTick, 4000);
  } else if (!state.autoRefresh && state.pollingHandle) {
    window.clearInterval(state.pollingHandle);
    state.pollingHandle = null;
  }
});

const pollingTick = () => {
  void refreshTasks();
  void refreshSelectedTask();
  void renderRuntime();
  void refreshQualityMetrics();
  void refreshBenchmarkRuns();
};

setPreviewMessage("点击产物进行预览。");
void refreshAll();
state.pollingHandle = window.setInterval(pollingTick, 4000);
