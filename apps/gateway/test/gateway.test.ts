import test from "node:test";
import assert from "node:assert/strict";
import { ModelRouter } from "../../../packages/llm/src";
import { RouterAgent } from "../../../packages/agents/src";
import { submitGatewayMessage } from "../src/service";

test("gateway keeps chat messages local", async () => {
  const routerAgent = new RouterAgent(new ModelRouter());

  const result = await submitGatewayMessage({
    userId: "gateway_chat_user",
    message: "今天天气怎么样",
    routerAgent,
    apiBaseUrl: "http://localhost:3000",
    fetchImpl: async () => {
      throw new Error("fetch should not be called for chat routes");
    }
  });

  assert.equal(result.mode, "direct");
  assert.equal(result.route.route, "chat");
});

test("gateway submits executable tasks to the API", async () => {
  const routerAgent = new RouterAgent(new ModelRouter());
  let called = false;

  const result = await submitGatewayMessage({
    userId: "gateway_task_user",
    message: "帮我调研迪拜新能源租车市场并做一个报告",
    routerAgent,
    apiBaseUrl: "http://localhost:3000/",
    fetchImpl: async (input, init) => {
      called = true;
      assert.equal(String(input), "http://localhost:3000/tasks");
      assert.equal(init?.method, "POST");
      assert.equal(init?.headers && "content-type" in init.headers ? init.headers["content-type"] : "application/json", "application/json");

      const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      assert.equal(payload["userId"], "gateway_task_user");
      assert.equal(payload["goal"], "帮我调研迪拜新能源租车市场并做一个报告");

      return new Response(
        JSON.stringify({
          task: {
            id: "task_gateway",
            status: "CREATED"
          },
          job: {
            id: "job_gateway",
            status: "PENDING"
          }
        }),
        {
          status: 202,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }
  });

  assert.equal(called, true);
  assert.equal(result.mode, "queued");
  if (result.mode === "queued") {
    assert.equal(result.task["id"], "task_gateway");
    assert.equal(result.job["id"], "job_gateway");
  }
});

test("gateway forces TASK-prefixed messages to queue even with a stale chat route", async () => {
  let called = false;

  const result = await submitGatewayMessage({
    userId: "gateway_task_prefix_user",
    message: "   TASK: summarize the attached notes",
    routerAgent: ({
      route: async () => ({
        route: "chat",
        intent: "smalltalk",
        reason: "legacy router fallback",
        confidence: 0.12,
        missingInfo: [],
        riskFlags: []
      })
    } as unknown) as RouterAgent,
    apiBaseUrl: "http://localhost:3000",
    fetchImpl: async () => {
      called = true;
      return new Response(
        JSON.stringify({
          task: {
            id: "task_gateway_prefixed",
            status: "CREATED"
          },
          job: {
            id: "job_gateway_prefixed",
            status: "PENDING"
          }
        }),
        {
          status: 202,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }
  });

  assert.equal(called, true);
  assert.equal(result.mode, "queued");
  assert.equal(result.route.route, "single_step");
});
