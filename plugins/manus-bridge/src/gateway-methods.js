function respondOk(respond, payload) {
  respond(true, payload);
}

function respondError(respond, error) {
  respond(false, undefined, {
    code: "manus_bridge_error",
    message: error instanceof Error ? error.message : String(error)
  });
}

export function createSubmitGatewayMethod(client, store) {
  return async ({ params, respond }) => {
    try {
      const goal =
        typeof params.goal === "string" && params.goal.trim() ? params.goal.trim() : undefined;
      if (!goal) {
        throw new Error("goal is required");
      }

      const result = await client.submitTask({
        goal,
        userId:
          typeof params.userId === "string" && params.userId.trim()
            ? params.userId.trim()
            : "gateway_user",
        ...(params.origin && typeof params.origin === "object" ? { origin: params.origin } : {})
      });
      if (
        result.task?.id &&
        params.origin &&
        typeof params.origin === "object" &&
        typeof params.origin.channelId === "string"
      ) {
        await store.trackTask(result.task.id, params.origin);
      }
      respondOk(respond, result);
    } catch (error) {
      respondError(respond, error);
    }
  };
}

export function createStatusGatewayMethod(client) {
  return async ({ params, respond }) => {
    try {
      if (typeof params.taskId !== "string" || params.taskId.trim().length === 0) {
        throw new Error("taskId is required");
      }
      respondOk(respond, await client.getTask(params.taskId.trim()));
    } catch (error) {
      respondError(respond, error);
    }
  };
}

export function createApproveGatewayMethod(client) {
  return async ({ params, respond }) => {
    try {
      if (typeof params.approvalId !== "string" || params.approvalId.trim().length === 0) {
        throw new Error("approvalId is required");
      }
      respondOk(
        respond,
        await client.approveTask(
          params.approvalId.trim(),
          typeof params.decisionNote === "string" ? params.decisionNote : undefined
        )
      );
    } catch (error) {
      respondError(respond, error);
    }
  };
}
