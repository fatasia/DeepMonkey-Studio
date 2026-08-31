import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseDocument } from "@bim-studio/contracts";

/** 单机 JSON 元数据的原子写入与单步回滚边界。 */
export class JsonFilePersistence {
  private writeChain = Promise.resolve();
  private sequence = 0;
  readonly previousPath: string;

  constructor(readonly databasePath: string) {
    this.previousPath = `${databasePath}.previous`;
  }

  async load(): Promise<DatabaseDocument | undefined> {
    await mkdir(path.dirname(this.databasePath), { recursive: true });
    try {
      return parseDocument(await readFile(this.databasePath, "utf8"), this.databasePath);
    } catch (currentError) {
      try {
        const previousText = await readFile(this.previousPath, "utf8");
        const previous = parseDocument(previousText, this.previousPath);
        await this.restore(previousText);
        return previous;
      } catch (previousError) {
        if (isMissing(currentError) && isMissing(previousError)) return undefined;
        throw new Error(`元数据主文件与回滚副本均不可用：${message(currentError)}；${message(previousError)}`);
      }
    }
  }

  async write(document: DatabaseDocument): Promise<void> {
    const operation = async () => this.atomicWrite(JSON.stringify(document, null, 2));
    this.writeChain = this.writeChain.then(operation, operation);
    await this.writeChain;
  }

  private async atomicWrite(payload: string): Promise<void> {
    const temporaryPath = this.temporaryPath("next");
    await writeFile(temporaryPath, payload, "utf8");
    let currentMoved = false;
    try {
      // 先保留当前成功版本；若进程在两次 rename 之间退出，启动时会从 previous 恢复。
      await rm(this.previousPath, { force: true });
      try {
        await rename(this.databasePath, this.previousPath);
        currentMoved = true;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await rename(temporaryPath, this.databasePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      if (currentMoved) await rename(this.previousPath, this.databasePath).catch(() => undefined);
      throw error;
    }
  }

  private async restore(payload: string): Promise<void> {
    const temporaryPath = this.temporaryPath("restore");
    await writeFile(temporaryPath, payload, "utf8");
    try {
      try {
        await rename(this.databasePath, `${this.databasePath}.corrupt-${Date.now()}`);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await rename(temporaryPath, this.databasePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private temporaryPath(purpose: string): string {
    this.sequence += 1;
    return `${this.databasePath}.${process.pid}.${this.sequence}.${purpose}.tmp`;
  }
}

function parseDocument(text: string, source: string): DatabaseDocument {
  const value = JSON.parse(text) as Partial<DatabaseDocument>;
  if (!value || !Array.isArray(value.projects) || !Array.isArray(value.scenes)) {
    throw new Error(`${source} 缺少 projects/scenes 数组`);
  }
  return value as DatabaseDocument;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
