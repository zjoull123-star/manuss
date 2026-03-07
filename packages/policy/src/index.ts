import { AgentKind, ToolName } from "../../core/src";

const DEFAULT_TOOL_PERMISSION_MATRIX: Record<AgentKind, ToolName[]> = {
  [AgentKind.Router]: [],
  [AgentKind.Planner]: [],
  [AgentKind.Replanner]: [],
  [AgentKind.Research]: [ToolName.Search, ToolName.Browser],
  [AgentKind.Browser]: [ToolName.Search, ToolName.Browser, ToolName.Filesystem],
  [AgentKind.Coding]: [ToolName.Python, ToolName.Filesystem, ToolName.Document],
  [AgentKind.Document]: [ToolName.Document, ToolName.Filesystem],
  [AgentKind.Action]: [ToolName.Action],
  [AgentKind.Verifier]: []
};

export class ToolPolicyService {
  canUseTool(agentKind: AgentKind, toolName: ToolName): boolean {
    return DEFAULT_TOOL_PERMISSION_MATRIX[agentKind].includes(toolName);
  }

  requiresApproval(toolName: ToolName, action: string): boolean {
    if (toolName === ToolName.Action) {
      return true;
    }

    if (toolName === ToolName.Browser && action !== "extract") {
      return true;
    }

    return false;
  }
}
