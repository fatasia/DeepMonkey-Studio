import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentCheckpoint, AgentCheckpointStore } from "@bim-studio/industrial-agent-orchestrator";

interface CheckpointDocument {
  schemaVersion: 1;
  runs: AgentCheckpoint[];
}

/** Agent checkpoint 使用独立原子文件，避免把运行态塞进项目主文档并放大每次元数据写入。 */
export class IndustrialAgentCheckpointStore implements AgentCheckpointStore {
  private readonly filePath: string;
  private document: CheckpointDocument = { schemaVersion: 1, runs: [] };
  private writes = Promise.resolve();
  private sequence = 0;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "industrial-agent-checkpoints.json");
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      this.document = normalize(JSON.parse(await readFile(this.filePath, "utf8")) as Partial<CheckpointDocument>);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  async get(id: string): Promise<AgentCheckpoint | undefined> {
    const checkpoint = this.document.runs.find((item) => item.id === id);
    return checkpoint ? structuredClone(checkpoint) : undefined;
  }

  async save(checkpoint: AgentCheckpoint): Promise<void> {
    const snapshot = structuredClone(checkpoint);
    const operation = this.writes.then(async () => {
      const runs = [...this.document.runs];
      const index = runs.findIndex((item) => item.id === snapshot.id);
      if (index >= 0) runs[index] = snapshot;
      else runs.unshift(snapshot);
      const next: CheckpointDocument = { schemaVersion: 1, runs: this.prune(runs) };
      // 读侧只暴露已落盘状态；失败后继续保存也不能带入上次未提交的运行。
      await this.persist(next);
      this.document = next;
    });
    this.writes = operation.then(() => undefined, () => undefined);
    await operation;
  }

  private prune(runs: AgentCheckpoint[]): AgentCheckpoint[] {
    if (runs.length <= 1_000) return runs;
    const active = runs.filter((run) => ["running", "awaiting-approval", "awaiting-input"].includes(run.status));
    const terminal = runs.filter((run) => !active.includes(run)).slice(0, Math.max(0, 1_000 - active.length));
    return [...active, ...terminal];
  }

  private async persist(document = this.document): Promise<void> {
    this.sequence += 1;
    const temporary = `${this.filePath}.${process.pid}.${this.sequence}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(document, null, 2), "utf8");
      await rename(temporary, this.filePath);
    }
    catch (error) { await rm(temporary, { force: true }); throw error; }
  }
}

function normalize(value: Partial<CheckpointDocument>): CheckpointDocument {
  if (value.schemaVersion !== 1 || !Array.isArray(value.runs)) throw new Error("工业 Agent checkpoint 文件结构无效");
  return { schemaVersion: 1, runs: value.runs.filter(isCheckpoint) };
}

function isCheckpoint(value: unknown): value is AgentCheckpoint {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<AgentCheckpoint>;
  return source.schemaVersion === 1 && typeof source.id === "string" && typeof source.projectId === "string" && typeof source.status === "string";
}
