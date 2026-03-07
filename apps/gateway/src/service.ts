import { RouteDecision, TaskOrigin, UserProfile } from "../../../packages/core/src";
import {
  buildPrefixedTaskRoute,
  hasTaskPrefix,
  RouterAgent
} from "../../../packages/agents/src";

export interface GatewayQueuedResult {
  mode: "queued";
  route: RouteDecision;
  task: Record<string, unknown>;
  job: Record<string, unknown>;
}

export interface GatewayDirectResult {
  mode: "direct";
  route: RouteDecision;
  response: string;
}

export type GatewayResult = GatewayQueuedResult | GatewayDirectResult;

export interface SubmitMessageInput {
  userId: string;
  message: string;
  routerAgent: RouterAgent;
  apiBaseUrl: string;
  userProfile?: UserProfile;
  origin?: TaskOrigin;
  fetchImpl?: typeof fetch;
}

const normalizeApiBaseUrl = (value: string): string => value.replace(/\/+$/, "");

const isExecutableRoute = (route: RouteDecision["route"]): boolean =>
  route === "single_step" || route === "multi_step" || route === "approval_required";

export const submitGatewayMessage = async (
  input: SubmitMessageInput
): Promise<GatewayResult> => {
  const initialRoute = await input.routerAgent.route(input.message, input.userProfile);
  const route =
    hasTaskPrefix(input.message) && !isExecutableRoute(initialRoute.route)
      ? buildPrefixedTaskRoute(input.message, "gateway", initialRoute)
      : initialRoute;

  if (!isExecutableRoute(route.route)) {
    return {
      mode: "direct",
      route,
      response:
        route.route === "ask_clarification"
          ? "任务信息还不够完整，需要补充后再提交。"
          : "当前消息被判定为普通对话，没有创建执行任务。"
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${normalizeApiBaseUrl(input.apiBaseUrl)}/tasks`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      userId: input.userId,
      goal: input.message,
      ...(input.origin ? { origin: input.origin } : {})
    })
  });

  if (!response.ok) {
    throw new Error(`Gateway failed to enqueue task: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    task: Record<string, unknown>;
    job: Record<string, unknown>;
  };

  return {
    mode: "queued",
    route,
    task: payload.task,
    job: payload.job
  };
};
