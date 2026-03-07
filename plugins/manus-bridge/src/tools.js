import { buildOriginFromToolContext } from "./origin.js";

function toTextContent(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    details: payload
  };
}

function assertString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

export function createSubmitTaskTool(client, store) {
  return (toolContext = {}) => ({
    name: "manus_submit_task",
    description: "Queue a long-running task in the openclaw-manus runtime.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        goal: { type: "string" },
        userId: { type: "string" },
        origin: { type: "object" }
      },
      required: ["goal"]
    },
    async execute(_id, params) {
      const inferredOrigin = buildOriginFromToolContext(toolContext);
      const origin =
        params.origin && typeof params.origin === "object"
          ? { ...inferredOrigin, ...params.origin }
          : inferredOrigin;
      const result = await client.submitTask({
        goal: assertString(params.goal, "goal"),
        userId:
          typeof params.userId === "string" && params.userId.trim()
            ? params.userId.trim()
            : toolContext.requesterSenderId ?? "openclaw_agent",
        ...(origin.channelId ? { origin } : {})
      });

      if (result.task?.id && origin.channelId) {
        await store.trackTask(result.task.id, origin);
      }

      return toTextContent(result);
    }
  });
}

export function createTaskStatusTool(client) {
  return {
    name: "manus_task_status",
    description: "Fetch the latest status for a queued openclaw-manus task.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string" }
      },
      required: ["taskId"]
    },
    async execute(_id, params) {
      const result = await client.getTask(assertString(params.taskId, "taskId"));
      return toTextContent(result);
    }
  };
}

export function createApproveTaskTool(client) {
  return {
    name: "manus_approve_task",
    description: "Approve a pending openclaw-manus approval request.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        approvalId: { type: "string" },
        decisionNote: { type: "string" }
      },
      required: ["approvalId"]
    },
    async execute(_id, params) {
      const result = await client.approveTask(
        assertString(params.approvalId, "approvalId"),
        typeof params.decisionNote === "string" ? params.decisionNote : undefined
      );
      return toTextContent(result);
    }
  };
}
