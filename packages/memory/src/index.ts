import { JsonObject } from "../../shared/src";
import { createId, nowIso } from "../../shared/src";
import { Artifact, MemoryRecord, MemoryRepository, Task, TaskStep, UserProfile } from "../../core/src";

export interface MemoryStore {
  recordStepSummary(taskId: string, summary: string, stepId?: string): void;
  listStepSummaries(taskId: string): string[];
  hydrate(taskId: string): Promise<void>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly taskSummaries = new Map<string, string[]>();

  recordStepSummary(taskId: string, summary: string): void {
    const existing = this.taskSummaries.get(taskId) ?? [];
    existing.push(summary);
    this.taskSummaries.set(taskId, existing);
  }

  listStepSummaries(taskId: string): string[] {
    return [...(this.taskSummaries.get(taskId) ?? [])];
  }

  async hydrate(): Promise<void> {
    // no-op for in-memory store
  }
}

export class PersistentMemoryStore implements MemoryStore {
  private readonly cache = new Map<string, string[]>();

  constructor(private readonly memoryRepository: MemoryRepository) {}

  recordStepSummary(taskId: string, summary: string, stepId?: string): void {
    const existing = this.cache.get(taskId) ?? [];
    existing.push(summary);
    this.cache.set(taskId, existing);

    const record: MemoryRecord = {
      id: createId("mem"),
      taskId,
      ...(stepId ? { stepId } : {}),
      summary,
      createdAt: nowIso()
    };

    this.memoryRepository.save(record).catch(() => {
      // async persist — failure is non-fatal
    });
  }

  listStepSummaries(taskId: string): string[] {
    return [...(this.cache.get(taskId) ?? [])];
  }

  async hydrate(taskId: string): Promise<void> {
    const records = await this.memoryRepository.listByTask(taskId);
    if (records.length > 0) {
      this.cache.set(
        taskId,
        records.map((r) => r.summary)
      );
    }
  }
}

export class ContextBuilder {
  constructor(private readonly memoryStore: MemoryStore) {}

  buildPlanningContext(goal: string, userProfile: UserProfile): JsonObject {
    return {
      goal,
      userProfile: {
        language: userProfile.language,
        outputStyle: userProfile.outputStyle,
        riskPolicy: userProfile.riskPolicy
      }
    };
  }

  buildStepContext(
    task: Task,
    step: TaskStep,
    userProfile: UserProfile,
    artifacts: Artifact[]
  ): JsonObject {
    const previousStepSummaries = task.steps
      .filter((candidate) => candidate.id !== step.id && candidate.summary)
      .map((candidate) => candidate.summary as string);

    const topResultUrl = task.steps
      .flatMap((candidate) => {
        const value = candidate.structuredData["topResultUrl"];
        return typeof value === "string" ? [value] : [];
      })
      .at(0);

    const browserCandidateUrls = [
      ...new Set(
        task.steps.flatMap((candidate) => {
          const value = candidate.structuredData["candidateSourceUrls"];
          return Array.isArray(value)
            ? value.filter((item): item is string => typeof item === "string")
            : [];
        })
      )
    ];

    const uploadedArtifactUris = artifacts
      .filter((artifact) => artifact.metadata["uploaded"] === true)
      .map((artifact) => artifact.uri);

    return {
      taskGoal: task.goal,
      currentStep: {
        id: step.id,
        title: step.title,
        objective: step.objective
      },
      userProfile: {
        language: userProfile.language,
        outputStyle: userProfile.outputStyle
      },
      previousStepSummaries,
      taskMemorySummaries: this.memoryStore.listStepSummaries(task.id),
      artifactUris: artifacts.map((artifact) => artifact.uri),
      ...(uploadedArtifactUris.length > 0 ? { uploadedArtifactUris } : {}),
      ...(browserCandidateUrls.length > 0 ? { browserCandidateUrls } : {}),
      ...(topResultUrl ? { topResultUrl } : {})
    };
  }
}

export class MemoryWriter {
  constructor(private readonly memoryStore: MemoryStore) {}

  recordStepResult(task: Task, step: TaskStep): void {
    if (!step.summary) {
      return;
    }

    this.memoryStore.recordStepSummary(task.id, `${step.id}: ${step.summary}`, step.id);
  }
}
