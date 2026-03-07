import { ModelRouter } from "../../../packages/llm/src";
import { RouterAgent } from "../../../packages/agents/src";
import { submitGatewayMessage } from "./service";

const apiBaseUrl = process.env.OPENCLAW_API_BASE_URL ?? "http://localhost:3000";
const userId = process.env.OPENCLAW_GATEWAY_USER_ID ?? "gateway_demo_user";

async function main(): Promise<void> {
  const routerAgent = new RouterAgent(new ModelRouter());
  const message =
    process.argv.slice(2).join(" ") ||
    "帮我调研迪拜新能源租车市场并做一个报告";
  const result = await submitGatewayMessage({
    userId,
    message,
    routerAgent,
    apiBaseUrl
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error("Gateway simulation failed", error);
  process.exitCode = 1;
});
