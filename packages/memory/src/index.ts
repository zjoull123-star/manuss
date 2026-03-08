import { JsonObject } from "../../shared/src";
import { createId, nowIso } from "../../shared/src";
import {
  Artifact,
  ArtifactIndexRepository,
  MemoryRecord,
  MemoryRepository,
  Task,
  TaskClass,
  TaskReference,
  TaskReferenceRepository,
  TaskStep,
  TaskSummaryRepository,
  UserProfile
} from "../../core/src";

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
  constructor(
    private readonly memoryStore: MemoryStore,
    private readonly taskSummaryRepository?: TaskSummaryRepository,
    private readonly artifactIndexRepository?: ArtifactIndexRepository,
    private readonly taskReferenceRepository?: TaskReferenceRepository
  ) {}

  private tokenizeGoal(goal: string): string[] {
    return [...new Set(
      goal
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
    )];
  }

  private scoreKeywordOverlap(goal: string, keywords: string[]): number {
    const target = new Set(this.tokenizeGoal(goal));
    if (target.size === 0 || keywords.length === 0) {
      return 0;
    }
    let overlap = 0;
    for (const keyword of keywords) {
      if (target.has(keyword.toLowerCase())) {
        overlap += 1;
      }
    }
    return overlap;
  }

  async buildHistoricalContext(
    task: Pick<Task, "id" | "userId" | "goal" | "recipeId">,
    taskClass?: TaskClass
  ): Promise<{
    references: TaskReference[];
    planningContext: JsonObject;
  }> {
    if (!this.taskSummaryRepository || !this.artifactIndexRepository || !this.taskReferenceRepository) {
      return { references: [], planningContext: {} };
    }

    const recentSummaries = await this.taskSummaryRepository.listRecentByUser(task.userId, 12);
    const filteredSummaries = recentSummaries
      .filter((summary) => summary.taskId !== task.id)
      .map((summary) => ({
        summary,
        score: this.scoreKeywordOverlap(task.goal, summary.keywords)
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 4);

    const indexedArtifacts = await this.artifactIndexRepository.search({
      q: this.tokenizeGoal(task.goal).slice(0, 6).join(" "),
      ...(taskClass ? { taskClass } : {}),
      validatedOnly: true,
      limit: 8
    });
    const filteredArtifacts = indexedArtifacts
      .filter((artifact) => artifact.taskId !== task.id)
      .sort((left, right) => {
        const leftScore = this.scoreKeywordOverlap(task.goal, left.keywords);
        const rightScore = this.scoreKeywordOverlap(task.goal, right.keywords);
        return rightScore - leftScore;
      })
      .slice(0, 6);

    const existingReferences = await this.taskReferenceRepository.listByTask(task.id);
    const existingKeys = new Set(
      existingReferences.map(
        (reference) =>
          `${reference.reason}:${reference.sourceTaskId ?? ""}:${reference.sourceArtifactId ?? ""}`
      )
    );

    const references = await Promise.all([
      ...filteredSummaries.map(({ summary }) =>
        existingKeys.has(`similar_task_summary:${summary.taskId}:`)
          ? Promise.resolve(
              existingReferences.find(
                (reference) =>
                  reference.reason === "similar_task_summary" &&
                  reference.sourceTaskId === summary.taskId
              )!
            )
          : this.taskReferenceRepository!.save({
          id: createId("taskref"),
          taskId: task.id,
          sourceTaskId: summary.taskId,
          reason: "similar_task_summary",
          createdAt: nowIso(),
          metadata: {
            summary: summary.summary,
            taskClass: summary.taskClass ?? null,
            recipeId: summary.recipeId ?? null,
            keywords: summary.keywords
          }
        })
      ),
      ...filteredArtifacts.map((artifact) =>
        existingKeys.has(
          `validated_artifact_match:${artifact.taskId}:${artifact.artifactId}`
        )
          ? Promise.resolve(
              existingReferences.find(
                (reference) =>
                  reference.reason === "validated_artifact_match" &&
                  reference.sourceTaskId === artifact.taskId &&
                  reference.sourceArtifactId === artifact.artifactId
              )!
            )
          : this.taskReferenceRepository!.save({
          id: createId("taskref"),
          taskId: task.id,
          sourceTaskId: artifact.taskId,
          sourceArtifactId: artifact.artifactId,
          reason: "validated_artifact_match",
          createdAt: nowIso(),
          metadata: {
            artifactType: artifact.artifactType,
            title: artifact.title ?? null,
            summary: artifact.summary ?? null,
            uri: artifact.uri,
            taskClass: artifact.taskClass ?? null,
            recipeId: artifact.recipeId ?? null,
            keywords: artifact.keywords
          }
        })
      )
    ]);

    return {
      references,
      planningContext: {
        similarTaskSummaries: filteredSummaries.map(({ summary }) => ({
          taskId: summary.taskId,
          taskClass: summary.taskClass ?? null,
          recipeId: summary.recipeId ?? null,
          summary: summary.summary,
          keywords: summary.keywords
        })),
        validatedArtifactReferences: filteredArtifacts.map((artifact) => ({
          artifactId: artifact.artifactId,
          taskId: artifact.taskId,
          artifactType: artifact.artifactType,
          title: artifact.title ?? null,
          summary: artifact.summary ?? null,
          keywords: artifact.keywords,
          uri: artifact.uri
        }))
      }
    };
  }

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
    artifacts: Artifact[],
    historicalContext: JsonObject = {}
  ): JsonObject {
    const previousStructuredEvidence = task.steps
      .filter((candidate) => candidate.id !== step.id)
      .map((candidate) => {
        const structuredData =
          candidate.structuredData && typeof candidate.structuredData === "object"
            ? candidate.structuredData
            : {};
        return {
          stepId: candidate.id,
          title: candidate.title,
          agent: candidate.agent,
          summary: candidate.summary ?? null,
          taskClass: candidate.taskClass ?? null,
          sourceCount:
            typeof structuredData["sourceCount"] === "number"
              ? structuredData["sourceCount"]
              : null,
          sources: Array.isArray(structuredData["sources"])
            ? structuredData["sources"].slice(0, 8)
            : [],
          extractedFacts: Array.isArray(structuredData["extractedFacts"])
            ? structuredData["extractedFacts"].slice(0, 8)
            : [],
          findings: Array.isArray(structuredData["findings"])
            ? structuredData["findings"].slice(0, 8)
            : [],
          timelineEvents: Array.isArray(structuredData["timelineEvents"])
            ? structuredData["timelineEvents"].slice(0, 8)
            : [],
          generatedFiles: Array.isArray(structuredData["generatedFiles"])
            ? structuredData["generatedFiles"].slice(0, 8)
            : [],
          keySections: Array.isArray(structuredData["keySections"])
            ? structuredData["keySections"].slice(0, 12)
            : []
        };
      });

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
          const candidateUrls = candidate.structuredData["candidateSourceUrls"];
          const sourceUrls = candidate.structuredData["sourceUrls"];
          const sources = candidate.structuredData["sources"];
          const fromCandidateUrls = Array.isArray(candidateUrls)
            ? candidateUrls.filter((item): item is string => typeof item === "string")
            : [];
          const fromSourceUrls = Array.isArray(sourceUrls)
            ? sourceUrls.filter((item): item is string => typeof item === "string")
            : [];
          const fromSources = Array.isArray(sources)
            ? sources.flatMap((item) =>
                item &&
                typeof item === "object" &&
                typeof (item as Record<string, unknown>)["url"] === "string"
                  ? [String((item as Record<string, unknown>)["url"])]
                  : []
              )
            : [];
          return [...fromCandidateUrls, ...fromSourceUrls, ...fromSources];
        })
      )
    ];

    const uploadedArtifacts = artifacts.filter((artifact) => artifact.metadata["uploaded"] === true);
    const uploadedArtifactUris = artifacts
      .filter((artifact) => artifact.metadata["uploaded"] === true)
      .map((artifact) => artifact.uri);
    const uploadedArtifactSummaries = uploadedArtifacts.map((artifact) => ({
      uri: artifact.uri,
      type: artifact.type,
      ...(typeof artifact.metadata["originalFilename"] === "string"
        ? { originalFilename: artifact.metadata["originalFilename"] }
        : {})
    }));
    const currentStepContext: JsonObject = {
      id: step.id,
      title: step.title,
      objective: step.objective,
      ...(step.taskClass ? { taskClass: step.taskClass } : {}),
      ...(step.qualityProfile ? { qualityProfile: step.qualityProfile as JsonObject } : {}),
      ...(step.attemptStrategy ? { attemptStrategy: step.attemptStrategy } : {})
    };

    return {
      taskGoal: task.goal,
      currentStep: currentStepContext,
      userProfile: {
        language: userProfile.language,
        outputStyle: userProfile.outputStyle
      },
      previousStepSummaries,
      previousStepEvidence: previousStructuredEvidence,
      taskMemorySummaries: this.memoryStore.listStepSummaries(task.id),
      artifactUris: artifacts.map((artifact) => artifact.uri),
      ...(uploadedArtifactUris.length > 0 ? { uploadedArtifactUris } : {}),
      ...(uploadedArtifactSummaries.length > 0 ? { uploadedArtifactSummaries } : {}),
      ...(browserCandidateUrls.length > 0 ? { browserCandidateUrls } : {}),
      ...(topResultUrl ? { topResultUrl } : {}),
      ...historicalContext
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
