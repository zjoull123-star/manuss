import path from "node:path";

function buildProgressMessage(task) {
  switch (task.status) {
    case "CREATED":
      return `任务 ${task.id} 已接收，正在进入规划队列。`;
    case "PLANNED":
      return `任务 ${task.id} 规划完成，准备开始执行。`;
    case "RUNNING":
    case "RETRYING":
    case "VERIFYING":
      return `任务 ${task.id} 正在执行中。`;
    case "WAITING_APPROVAL":
      return `任务 ${task.id} 正在等待审批。`;
    case "FAILED":
      return `任务 ${task.id} 执行失败。请在本地控制台查看失败类别、质量缺陷和重试建议。`;
    case "COMPLETED":
      return `任务 ${task.id} 已完成。`;
    case "CANCELLED":
      return `任务 ${task.id} 已取消。`;
    default:
      return null;
  }
}

function buildCompletionMessage(task) {
  const lines = [`任务 ${task.id} 已${task.status === "COMPLETED" ? "完成" : "结束"}.`, `状态: ${task.status}`];
  if (task.finalArtifactUri) {
    lines.push(`产物: ${path.basename(task.finalArtifactUri)}`);
    lines.push("请在本地控制台或 API 中查看和下载最终交付物。");
  }
  return lines.join("\n");
}

function buildApprovalMessage(taskId, approval) {
  return [
    `任务 ${taskId} 等待审批。`,
    `审批ID: ${approval.id}`,
    `动作: ${approval.toolName}.${approval.action}`,
    `原因: ${approval.reason}`,
    `执行: /approve-task ${approval.id}`
  ].join("\n");
}

async function sendOriginMessage(runtime, logger, origin, text) {
  const target = origin.conversationId ?? origin.senderId;
  if (!target) {
    logger.warn?.("manus-bridge: missing target conversation for callback");
    return false;
  }

  switch (origin.channelId) {
    case "whatsapp":
      await runtime.channel.whatsapp.sendMessageWhatsApp(target, text, {
        verbose: false,
        ...(origin.accountId ? { accountId: origin.accountId } : {})
      });
      return true;
    case "telegram":
      await runtime.channel.telegram.sendMessageTelegram(target, text, {
        verbose: false,
        ...(origin.accountId ? { accountId: origin.accountId } : {}),
        ...(typeof origin.threadId === "number" ? { messageThreadId: origin.threadId } : {})
      });
      return true;
    case "slack":
      await runtime.channel.slack.sendMessageSlack(target, text, {
        ...(origin.accountId ? { accountId: origin.accountId } : {}),
        ...(typeof origin.threadId === "string" ? { threadTs: origin.threadId } : {})
      });
      return true;
    default:
      logger.warn?.(`manus-bridge: auto callback not implemented for channel ${origin.channelId}`);
      return false;
  }
}

export function createManusPollerService(api, client, store, config) {
  let timer = null;
  let isRunning = false;

  const pollOnce = async () => {
    if (isRunning) {
      return;
    }

    isRunning = true;
    try {
      const trackedTasks = await store.listTrackedTasks();
      for (const trackedTask of trackedTasks) {
        const taskPayload = await client.getTask(trackedTask.taskId);
        const task = taskPayload.task;
        const origin = task.origin ?? trackedTask.origin;

        await store.updateTrackedTask(trackedTask.taskId, {
          lastStatus: task.status,
          ...(origin ? { origin } : {})
        });

        if (!origin || origin.replyMode !== "auto_callback") {
          continue;
        }

        const progressMessage = buildProgressMessage(task);
        if (
          progressMessage &&
          trackedTask.lastProgressStatus !== task.status &&
          !["COMPLETED", "FAILED", "CANCELLED", "WAITING_APPROVAL"].includes(task.status)
        ) {
          const sent = await sendOriginMessage(api.runtime, api.logger, origin, progressMessage);
          if (sent) {
            await store.updateTrackedTask(trackedTask.taskId, {
              lastProgressStatus: task.status
            });
          }
        }

        if (task.status === "WAITING_APPROVAL") {
          const approvalPayload = await client.listApprovals(trackedTask.taskId);
          const pendingApproval = Array.isArray(approvalPayload.approvals)
            ? approvalPayload.approvals.find((approval) => approval.status === "PENDING")
            : undefined;
          if (pendingApproval && trackedTask.lastApprovalId !== pendingApproval.id) {
            const sent = await sendOriginMessage(
              api.runtime,
              api.logger,
              origin,
              buildApprovalMessage(task.id, pendingApproval)
            );
            if (sent) {
              await store.updateTrackedTask(trackedTask.taskId, {
                lastApprovalId: pendingApproval.id,
                lastProgressStatus: task.status
              });
            }
          }
          continue;
        }

        if (!config.autoReplyOnCompletion) {
          continue;
        }

        if (
          (task.status === "COMPLETED" || task.status === "FAILED" || task.status === "CANCELLED") &&
          !trackedTask.terminalNotifiedAt
        ) {
          const sent = await sendOriginMessage(
            api.runtime,
            api.logger,
            origin,
            buildCompletionMessage(task)
          );
          if (sent) {
            await store.updateTrackedTask(trackedTask.taskId, {
              terminalNotifiedAt: new Date().toISOString()
            });
          }
        }
      }
    } catch (error) {
      api.logger.warn?.(
        `manus-bridge: poll cycle failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      isRunning = false;
    }
  };

  return {
    id: "manus-bridge-poller",
    start: async (ctx) => {
      store.configure(ctx.stateDir);
      await pollOnce();
      timer = setInterval(() => {
        void pollOnce();
      }, config.pollIntervalMs);
    },
    stop: async () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
}
