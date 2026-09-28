import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CheckpointStore, SubscriptionCheckpoint } from "./subscriptionRuntime.js";

/** 仅持久化 T24 的源位置，不存事件；宿主必须以受控 dataDir 显式注入。 */
export class FileSubscriptionCheckpointStore implements CheckpointStore {
  private readonly directory: string;
  private readonly pending = new Map<string, Promise<void>>();

  constructor(dataDir: string) {
    this.directory = path.join(dataDir, "subscription-checkpoints");
  }

  async load(connectionId: string): Promise<SubscriptionCheckpoint | null> {
    await this.pending.get(connectionId);
    let content: string;
    try {
      content = await readFile(this.fileFor(connectionId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`订阅 ${connectionId} 检查点文件损坏，拒绝从未知位置恢复；请修复或显式清除后重订阅`);
    }
    if (!validCheckpoint(parsed) || parsed.connectionId !== connectionId) {
      throw new Error(`订阅 ${connectionId} 检查点结构或归属无效，拒绝从未知位置恢复；请修复或显式清除后重订阅`);
    }
    return parsed;
  }

  save(checkpoint: SubscriptionCheckpoint): Promise<void> {
    if (!validCheckpoint(checkpoint)) return Promise.reject(new Error("订阅检查点位置无效，拒绝写入"));
    return this.enqueue(checkpoint.connectionId, async () => {
      await mkdir(this.directory, { recursive: true });
      const target = this.fileFor(checkpoint.connectionId);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(checkpoint), { flag: "wx", mode: 0o600 });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  clear(connectionId: string): Promise<void> {
    return this.enqueue(connectionId, async () => {
      await rm(this.fileFor(connectionId), { force: true });
    });
  }

  private fileFor(connectionId: string): string {
    if (!connectionId) throw new Error("订阅连接 id 不能为空");
    return path.join(this.directory, `${createHash("sha256").update(connectionId).digest("hex")}.json`);
  }

  private enqueue(connectionId: string, operation: () => Promise<void>): Promise<void> {
    const prior = this.pending.get(connectionId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    this.pending.set(connectionId, next);
    void next.finally(() => {
      if (this.pending.get(connectionId) === next) this.pending.delete(connectionId);
    }).catch(() => undefined);
    return next;
  }
}

function validCheckpoint(value: unknown): value is SubscriptionCheckpoint {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SubscriptionCheckpoint>;
  return typeof item.connectionId === "string" && item.connectionId.length > 0
    && Number.isSafeInteger(item.generation) && (item.generation ?? -1) >= 0
    && (item.lastSequence === null || (Number.isSafeInteger(item.lastSequence) && (item.lastSequence ?? -1) >= 0))
    && (item.lastTimestamp === null || validTime(item.lastTimestamp))
    && validTime(item.updatedAt);
}

function validTime(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
