import { createApproveTaskCommand, createTaskCommand, createTaskStatusCommand } from "./src/commands.js";
import { resolvePluginConfig } from "./src/config.js";
import { createManusClient } from "./src/client.js";
import {
  createApproveGatewayMethod,
  createStatusGatewayMethod,
  createSubmitGatewayMethod
} from "./src/gateway-methods.js";
import { createManusPollerService } from "./src/service.js";
import { ManusBridgeStore } from "./src/store.js";
import {
  createApproveTaskTool,
  createSubmitTaskTool,
  createTaskStatusTool
} from "./src/tools.js";

export default function register(api) {
  const config = resolvePluginConfig(api.pluginConfig);
  const client = createManusClient(config.apiBaseUrl);
  const store = new ManusBridgeStore();

  api.registerTool(createSubmitTaskTool(client, store), { optional: true });
  api.registerTool(createTaskStatusTool(client), { optional: true });
  api.registerTool(createApproveTaskTool(client), { optional: true });

  if (config.enableCommands) {
    api.registerCommand(createTaskCommand(api, client, store));
    api.registerCommand(createTaskStatusCommand(api, client, store));
    api.registerCommand(createApproveTaskCommand(client));
  }

  api.registerGatewayMethod("manus.submit", createSubmitGatewayMethod(client, store));
  api.registerGatewayMethod("manus.status", createStatusGatewayMethod(client));
  api.registerGatewayMethod("manus.approve", createApproveGatewayMethod(client));

  api.registerService(createManusPollerService(api, client, store, config));
}
