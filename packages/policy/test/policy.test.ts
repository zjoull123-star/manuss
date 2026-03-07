import test from "node:test";
import assert from "node:assert/strict";
import { AgentKind, ToolName } from "../../core/src";
import { ToolPolicyService } from "../src";

test("browser agent can use search for candidate bootstrap", () => {
  const policy = new ToolPolicyService();
  assert.equal(policy.canUseTool(AgentKind.Browser, ToolName.Search), true);
});
