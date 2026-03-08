import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_STATE = {
  tasks: {},
  conversations: {}
};

export function buildConversationKey(origin) {
  return [
    origin.channelId,
    origin.accountId ?? "default",
    origin.conversationId ?? origin.senderId ?? "unknown",
    origin.threadId ?? "root"
  ].join(":");
}

export class ManusBridgeStore {
  constructor() {
    this.stateFile = path.resolve(process.cwd(), ".openclaw-manus-bridge-state.json");
  }

  configure(stateDir) {
    this.stateFile = path.join(stateDir, "manus-bridge-state.json");
  }

  async listTrackedTasks() {
    const state = await this.loadState();
    return Object.values(state.tasks);
  }

  async trackTask(taskId, origin) {
    const state = await this.loadState();
    const conversationKey = buildConversationKey(origin);
    const existing = state.tasks[taskId] ?? {};
    state.tasks[taskId] = {
      ...existing,
      taskId,
      origin,
      conversationKey,
      lastStatus: existing.lastStatus ?? null,
      lastProgressStatus: existing.lastProgressStatus ?? null,
      lastApprovalId: existing.lastApprovalId ?? null,
      terminalNotifiedAt: existing.terminalNotifiedAt ?? null
    };

    const conversation = state.conversations[conversationKey] ?? {
      latestTaskId: taskId,
      taskIds: []
    };
    if (!conversation.taskIds.includes(taskId)) {
      conversation.taskIds.push(taskId);
    }
    conversation.latestTaskId = taskId;
    state.conversations[conversationKey] = conversation;

    await this.saveState(state);
    return state.tasks[taskId];
  }

  async getLatestTaskIdForConversation(origin) {
    const state = await this.loadState();
    const key = buildConversationKey(origin);
    return state.conversations[key]?.latestTaskId;
  }

  async updateTrackedTask(taskId, updates) {
    const state = await this.loadState();
    const existing = state.tasks[taskId];
    if (!existing) {
      return undefined;
    }

    state.tasks[taskId] = {
      ...existing,
      ...updates
    };
    await this.saveState(state);
    return state.tasks[taskId];
  }

  async loadState() {
    try {
      const raw = await fs.readFile(this.stateFile, "utf8");
      return {
        tasks: {},
        conversations: {},
        ...JSON.parse(raw)
      };
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        return structuredClone(DEFAULT_STATE);
      }
      throw error;
    }
  }

  async saveState(state) {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    await fs.writeFile(this.stateFile, JSON.stringify(state, null, 2), "utf8");
  }
}
