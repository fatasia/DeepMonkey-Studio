import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PprBopVersion, PprBopVersionDraft } from "@bim-studio/contracts";
import {
  analyzePprBopVersion,
  comparePprBopVersions,
  type PprAnalysis,
  type PprVersionComparison,
} from "@bim-studio/ppr-lite-engine";

interface PprBopDocument {
  schemaVersion: 1;
  projects: Record<string, PprBopVersion[]>;
}

/** 版本只追加，避免工艺快照被页面保存操作静默覆盖。 */
export class PprBopService {
  private readonly filePath: string;
  private document: PprBopDocument = { schemaVersion: 1, projects: {} };
  private writeChain = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "ppr-bop-versions.json");
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<PprBopDocument>;
      this.document = { schemaVersion: 1, projects: parsed.projects ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  list(projectId: string): PprBopVersion[] {
    return structuredClone(this.project(projectId));
  }

  async create(projectId: string, draft: PprBopVersionDraft): Promise<PprBopVersion> {
    return this.mutate(projectId, (versions) => {
      const planId = requiredText(draft.planId, "计划 ID");
      const name = requiredText(draft.name, "计划名称");
      const planVersions = versions.filter((version) => version.planId === planId);
      const version = draft.version?.trim() || `v${planVersions.length + 1}`;
      if (planVersions.some((item) => item.version === version)) {
        throw new Error(`计划 ${planId} 已存在版本 ${version}，版本不可覆盖`);
      }
      if (draft.basedOnVersionId && !planVersions.some((item) => item.id === draft.basedOnVersionId)) {
        throw new Error("基线版本不存在，或不属于当前工艺计划");
      }

      const record: PprBopVersion = {
        ...structuredClone(draft),
        id: randomUUID(),
        planId,
        name,
        version,
        createdAt: new Date().toISOString(),
      };
      versions.push(record);
      return record;
    });
  }

  analyze(projectId: string, versionId: string): PprAnalysis {
    return analyzePprBopVersion(this.requireVersion(projectId, versionId));
  }

  compare(projectId: string, beforeVersionId: string, afterVersionId: string): PprVersionComparison {
    const before = this.requireVersion(projectId, beforeVersionId);
    const after = this.requireVersion(projectId, afterVersionId);
    if (before.planId !== after.planId) throw new Error("只能比较同一工艺计划的两个版本");
    return comparePprBopVersions(before, after);
  }

  private project(projectId: string): PprBopVersion[] {
    return this.document.projects[projectId] ??= [];
  }

  private requireVersion(projectId: string, versionId: string): PprBopVersion {
    const version = this.project(projectId).find((item) => item.id === versionId);
    if (!version) throw new Error("工艺计划版本不存在");
    return version;
  }

  private async mutate<T>(projectId: string, action: (versions: PprBopVersion[]) => T): Promise<T> {
    let result!: T;
    const operation = this.writeChain.then(async () => {
      result = action(this.project(projectId));
      await this.persist();
    });
    this.writeChain = operation.then(() => undefined, () => undefined);
    await operation;
    return structuredClone(result);
  }

  private async persist(): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.document, null, 2));
    await rename(temporary, this.filePath);
  }
}

function requiredText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}
