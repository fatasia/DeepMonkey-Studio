import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import {
  mkdir, readFile, rename, rm, writeFile,
} from "node:fs/promises";
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  DeepAssetPackageStoreExecutor,
  type DeepAssetBlobDescriptor, type DeepAssetPackage,
  type DeepAssetPackageStoreAdapter,
  type DeepAssetStagedBlob, type DeepAssetStoreCommitRequest,
  type DeepAssetStoreSnapshot,
} from "@bim-studio/deep-engine";
import type { DeepAssetBlobOrigin } from "./deepAssetPackageBuilder.js";

const INITIAL_SNAPSHOT: DeepAssetStoreSnapshot = { revision: 0, active: null, blobHashes: [] };

export interface ActiveDeepAssetPackage {
  readonly revision: number;
  readonly packageValue: DeepAssetPackage;
}

export interface FileSystemDeepAssetPackageStore {
  readonly rootDir: string;
  readonly adapter: DeepAssetPackageStoreAdapter<string>;
  /**
   * 每次发布绑定自己的 blob 字节来源，避免并发转换互相覆盖解析闭包；
   * 未绑定时退回构造时的全局解析器。
   */
  createExecutor(origins?: readonly DeepAssetBlobOrigin[]): DeepAssetPackageStoreExecutor<string>;
  readActivePackage(): Promise<ActiveDeepAssetPackage | null>;
  readSnapshot(): Promise<DeepAssetStoreSnapshot>;
}

/**
 * Deep Asset Package 存储的本地文件实现：
 * 内容寻址 blob + 单调修订号快照，commit 在同一同步临界区内核对 revision 并原子发布，
 * 满足执行器对 adapter 的 CAS 合同（staging 失败自清理、发布前不暴露任何内容）。
 */
export function createFileSystemDeepAssetPackageStore(
  rootDir: string,
  resolveBlobOrigin: (hash: string) => Promise<DeepAssetBlobOrigin | undefined>,
): FileSystemDeepAssetPackageStore {
  const snapshotPath = path.join(rootDir, "snapshot.json");
  const packagesDir = path.join(rootDir, "packages");
  const blobsDir = path.join(rootDir, "blobs");
  const tmpDir = path.join(rootDir, "tmp");

  const readSnapshotOrInitial = async (): Promise<DeepAssetStoreSnapshot> => {
    try {
      return JSON.parse(await readFile(snapshotPath, "utf8")) as DeepAssetStoreSnapshot;
    } catch {
      return INITIAL_SNAPSHOT;
    }
  };

  const createAdapter = (
    resolve: (hash: string) => Promise<DeepAssetBlobOrigin | undefined>,
  ): DeepAssetPackageStoreAdapter<string> => ({
    async readSnapshot(signal) {
      if (signal.aborted) throw abortError(signal);
      return readSnapshotOrInitial();
    },

    async stageBlob(descriptor, _packageValue, signal) {
      if (signal.aborted) throw abortError(signal);
      const origin = await resolve(descriptor.hash);
      if (!origin) throw new Error(`找不到 blob ${descriptor.hash} 的来源字节`);
      const bytes = origin.kind === "file" ? await readFile(origin.filePath) : origin.bytes;
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      if (contentHash !== descriptor.hash || bytes.byteLength !== descriptor.byteLength) {
        throw new Error(`blob ${descriptor.hash} 的实际字节与声明不符（SHA-256 复算不通过）`);
      }
      await mkdir(tmpDir, { recursive: true });
      const stagedPath = path.join(tmpDir, `${descriptor.hash.slice(0, 16)}-${randomBytes(8).toString("hex")}.part`);
      try {
        await writeFile(stagedPath, bytes, { flag: "wx" });
      } catch (error) {
        await rm(stagedPath, { force: true }).catch(() => undefined);
        throw error;
      }
      const staged: DeepAssetStagedBlob<string> = {
        descriptor,
        handle: stagedPath,
        verification: { authority: "adapter-sha256", algorithm: "sha256", contentHash, byteLength: bytes.byteLength, verified: true },
      };
      return staged;
    },

    commit(request) {
      // 同步临界区：任何失败都必须滚回 staged 文件，绝不暴露部分发布。
      if (!request.isCurrent()) { cleanupStaged(request.stagedBlobs); return "superseded"; }
      let snapshot: DeepAssetStoreSnapshot;
      try {
        snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as DeepAssetStoreSnapshot;
      } catch {
        snapshot = INITIAL_SNAPSHOT;
      }
      if (snapshot.revision !== request.commit.expectedRevision) {
        cleanupStaged(request.stagedBlobs);
        return "revision-conflict";
      }
      try {
        mkdirSync(blobsDir, { recursive: true });
        mkdirSync(packagesDir, { recursive: true });
        for (const staged of request.stagedBlobs) {
          const target = path.join(blobsDir, staged.descriptor.hash);
          if (existsSync(target)) rmSync(staged.handle, { force: true });
          else renameSync(staged.handle, target);
        }
        const packageFile = path.join(packagesDir, packageFileName(request.packageValue.manifest.packageId));
        writeAtomicSync(packageFile, JSON.stringify({
          revision: request.commit.nextRevision,
          packageValue: request.packageValue,
        }, null, 2));
        const blobHashes = [...new Set([...snapshot.blobHashes, ...request.packageValue.blobs.map((blob) => blob.hash)])].sort();
        writeAtomicSync(snapshotPath, JSON.stringify({
          revision: request.commit.nextRevision,
          active: request.commit.nextActive,
          blobHashes,
        }, null, 2));
      } catch (error) {
        cleanupStaged(request.stagedBlobs);
        throw error;
      }
      return "committed";
    },

    async releaseBlob(staged, _disposition) {
      // committed 后 staged 文件已被改名进 blobs；rolled-back 时按句柄清理。
      await rm(staged.handle, { force: true }).catch(() => undefined);
    },
  });

  const adapter = createAdapter(resolveBlobOrigin);

  return {
    rootDir,
    adapter,
    createExecutor: (origins) => {
      if (!origins) return new DeepAssetPackageStoreExecutor(adapter);
      const index = new Map(origins.map((origin) => [origin.hash, origin] as const));
      return new DeepAssetPackageStoreExecutor(createAdapter((hash) => Promise.resolve(index.get(hash))));
    },
    readActivePackage: async () => {
      const snapshot = await readSnapshotOrInitial();
      if (!snapshot.active) return null;
      try {
        const raw = JSON.parse(await readFile(
          path.join(packagesDir, packageFileName(snapshot.active.packageId)), "utf8")) as ActiveDeepAssetPackage;
        return raw;
      } catch {
        return null;
      }
    },
    readSnapshot: readSnapshotOrInitial,
  };
}

function cleanupStaged(staged: readonly DeepAssetStagedBlob<string>[]): void {
  for (const item of staged) {
    try { rmSync(item.handle, { force: true }); } catch { /* 尽力清理，不掩盖 CAS 结论 */ }
  }
}

function writeAtomicSync(target: string, content: string): void {
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, content, "utf8");
  renameSync(temp, target);
}

/** packageId 允许 ":" 等字符，但 Windows 文件名不允许；仅用于派生文件名，不改变身份。 */
function packageFileName(packageId: string): string {
  return `${packageId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("操作已中止");
}
