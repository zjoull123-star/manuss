import path from "node:path";
import { buildOriginFromCommandContext } from "./origin.js";

function renderTaskSummary(task) {
  const lines = [`任务 ${task.id}`, `状态: ${task.status}`];
  if (task.stageLabel) {
    lines.push(`阶段: ${task.stageLabel}`);
  }
  if (task.stageSummary) {
    lines.push(`摘要: ${task.stageSummary}`);
  }
  if (task.failureCategory) {
    lines.push(`失败类别: ${task.failureCategory}`);
  }
  if (task.finalArtifactUri) {
    lines.push(`产物: ${path.basename(task.finalArtifactUri)}`);
  }
  return lines.join("\n");
}

export function createTaskCommand(api, client, store) {
  return {
    name: "task",
    description: "Queue a long-running task in openclaw-manus.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const goal = ctx.args?.trim();
      if (!goal) {
        return { text: "用法: /task <任务描述>" };
      }

      const origin = buildOriginFromCommandContext(ctx);
      const result = await client.submitTask({
        userId: ctx.senderId ?? ctx.from ?? "openclaw_user",
        goal,
        origin
      });
      if (result.task?.id) {
        await store.trackTask(result.task.id, origin);
      }

      return {
        text: [
          "任务已入队。",
          result.task?.id ? `任务ID: ${result.task.id}` : undefined,
          result.job?.id ? `作业ID: ${result.job.id}` : undefined,
          "使用 /task-status 查看进度。"
        ]
          .filter(Boolean)
          .join("\n")
      };
    }
  };
}

export function createTaskStatusCommand(_api, client, store) {
  return {
    name: "task-status",
    description: "Check the latest status of a openclaw-manus task.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const explicitTaskId = ctx.args?.trim();
      let taskId = explicitTaskId;
      if (!taskId) {
        const origin = buildOriginFromCommandContext(ctx);
        taskId = await store.getLatestTaskIdForConversation(origin);
      }

      if (!taskId) {
        return { text: "没有找到最近任务。用法: /task-status <taskId>" };
      }

      const result = await client.getTask(taskId);
      return { text: renderTaskSummary(result.task) };
    }
  };
}

export function createApproveTaskCommand(client) {
  return {
    name: "approve-task",
    description: "Approve a pending openclaw-manus approval request.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const approvalId = ctx.args?.trim();
      if (!approvalId) {
        return { text: "用法: /approve-task <approvalId>" };
      }

      const result = await client.approveTask(approvalId, "approved from OpenClaw command");
      return {
        text: [
          `审批 ${approvalId} 已批准。`,
          result.task?.id ? `任务ID: ${result.task.id}` : undefined,
          result.job?.id ? `恢复作业ID: ${result.job.id}` : undefined
        ]
          .filter(Boolean)
          .join("\n")
      };
    }
  };
}
