import { promises as fs } from "node:fs";
import path from "node:path";
import {
  Artifact,
  ArtifactRepository,
  ArtifactType,
  ToolName
} from "../../core/src";
import { createId } from "../../shared/src";

const isPathInside = (rootDir: string, candidatePath: string): boolean => {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const inferArtifactType = (uri: string): ArtifactType => {
  const extension = path.extname(uri).toLowerCase();

  if (extension === ".md") {
    return ArtifactType.Markdown;
  }

  if (extension === ".json") {
    return ArtifactType.Json;
  }

  if (extension === ".pdf") {
    return ArtifactType.Pdf;
  }

  if (extension === ".csv" || extension === ".tsv" || extension === ".xlsx" || extension === ".xls") {
    return ArtifactType.Spreadsheet;
  }

  if (extension === ".txt" || extension === ".log" || extension === ".py") {
    return ArtifactType.Text;
  }

  if (extension === ".png") {
    return ArtifactType.Screenshot;
  }

  return ArtifactType.Generic;
};

export class WorkspaceManager {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  getRootDir(): string {
    return this.rootDir;
  }

  getTaskWorkspacePath(taskId: string): string {
    return path.join(this.rootDir, taskId);
  }

  isWithinWorkspace(candidatePath: string): boolean {
    return isPathInside(this.rootDir, candidatePath);
  }

  isWithinTaskWorkspace(taskId: string, candidatePath: string): boolean {
    return isPathInside(this.getTaskWorkspacePath(taskId), candidatePath);
  }

  async ensureTaskWorkspace(taskId: string): Promise<string> {
    const taskDir = this.getTaskWorkspacePath(taskId);
    await fs.mkdir(taskDir, { recursive: true });
    return taskDir;
  }

  async writeTaskFile(
    taskId: string,
    relativePath: string,
    contents: string
  ): Promise<string> {
    const taskDir = await this.ensureTaskWorkspace(taskId);
    const filePath = path.join(taskDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents, "utf8");
    return filePath;
  }

  async writeTaskBuffer(
    taskId: string,
    relativePath: string,
    contents: Buffer
  ): Promise<string> {
    const taskDir = await this.ensureTaskWorkspace(taskId);
    const filePath = path.join(taskDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
    return filePath;
  }

  async copyFileIntoTaskWorkspace(
    taskId: string,
    sourcePath: string,
    relativePath: string
  ): Promise<string> {
    const taskDir = await this.ensureTaskWorkspace(taskId);
    const filePath = path.join(taskDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.copyFile(sourcePath, filePath);
    return filePath;
  }
}

export class ArtifactRegistry {
  constructor(
    private readonly artifactRepository: ArtifactRepository,
    private readonly workspaceManager: WorkspaceManager
  ) {}

  async recordGeneratedArtifacts(
    taskId: string,
    stepId: string,
    uris: string[],
    createdBy: ToolName
  ): Promise<Artifact[]> {
    const saved: Artifact[] = [];

    for (const uri of uris) {
      if (!this.workspaceManager.isWithinWorkspace(uri)) {
        throw new Error(`Artifact path is outside workspace root: ${uri}`);
      }
      const artifact: Artifact = {
        id: createId("artifact"),
        taskId,
        stepId,
        type: inferArtifactType(uri),
        uri,
        metadata: { createdBy },
        createdAt: new Date().toISOString()
      };
      saved.push(await this.artifactRepository.save(artifact));
    }

    return saved;
  }
}
