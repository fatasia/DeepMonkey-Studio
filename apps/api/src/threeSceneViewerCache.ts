import { lstat, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const threeSceneViewerCacheDirectory = fileURLToPath(new URL("../../../.cache/three-scene-viewer-v1", import.meta.url));

/** 构建、读取和清理共用队列，避免删除构建中或正在读取的缓存。 */
export class ThreeSceneViewerCache {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  inspect() { return this.exclusive(() => this.scan(false)); }
  clear() { return this.exclusive(() => this.scan(true)); }

  private async validateDirectory(): Promise<boolean> {
    const expected = path.resolve(this.directory);
    if (path.basename(expected) !== "three-scene-viewer-v1" || path.basename(path.dirname(expected)) !== ".cache") {
      throw new Error("打包缓存目录不符合约定");
    }
    for (const directory of [path.dirname(expected), expected]) {
      try {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await realpath(directory)).toLowerCase() !== directory.toLowerCase()) {
          throw new Error("打包缓存目录包含链接，已停止清理");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }
    return true;
  }

  private async scan(remove: boolean) {
    const result = { entries: 0, bytes: 0, removedEntries: 0, removedBytes: 0, skippedEntries: 0 };
    if (!await this.validateDirectory()) return result;
    for (const name of await readdir(this.directory)) {
      // 固定一级目录及内容摘要命名；不遍历子目录，不清临时文件或冻结发布资源。
      if (!/^[a-f0-9]{64}\.exe$/.test(name)) { result.skippedEntries += 1; continue; }
      const file = path.resolve(this.directory, name);
      if (path.dirname(file) !== path.resolve(this.directory)) throw new Error("打包缓存路径越界");
      try {
        const before = await lstat(file);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) { result.skippedEntries += 1; continue; }
        if (remove) {
          await this.validateDirectory();
          const current = await lstat(file);
          if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
            || current.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs) {
            result.skippedEntries += 1; continue;
          }
          await unlink(file);
          result.removedEntries += 1;
          result.removedBytes += before.size;
        } else { result.entries += 1; result.bytes += before.size; }
      } catch (error) {
        if (["ENOENT", "EBUSY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          result.skippedEntries += 1;
        } else throw error;
      }
    }
    return result;
  }
}

export const threeSceneViewerCache = new ThreeSceneViewerCache(threeSceneViewerCacheDirectory);
