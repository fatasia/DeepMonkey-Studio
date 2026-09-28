import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AssetCompatibilityProfile,
  DeepAssetBlobDescriptor,
  DeepAssetImporterProvenance,
  DeepAssetPackage,
  DeepAssetResource,
  DeepAssetResourceKind,
  DeepAssetSourceProvenance,
} from "@bim-studio/deep-engine";

/** 由磁盘字节寻址的 blob 来源；存储 adapter 在 staging 时从这里读取并复算 SHA-256。 */
export type DeepAssetBlobOrigin =
  | { readonly kind: "file"; readonly hash: string; readonly filePath: string }
  | { readonly kind: "inline"; readonly hash: string; readonly bytes: Buffer };

export interface DeepAssetPackageFileInput {
  /** 稳定资源 id，如 "geometry:main"；必须为小写规范 id 且在包内唯一。 */
  readonly id: string;
  readonly kind: DeepAssetResourceKind;
  readonly logicalPath: string;
  readonly fileName: string;
  readonly mediaType: string;
}

export interface BuildModelDeepAssetPackageInput {
  readonly packageId: string;
  readonly source: DeepAssetSourceProvenance;
  readonly importer: DeepAssetImporterProvenance;
  readonly compatibility: AssetCompatibilityProfile;
  /** 至少一个产物文件；入口 scene 资源自动生成并依赖全部文件资源。 */
  readonly files: readonly DeepAssetPackageFileInput[];
  readonly outputDir: string;
}

export interface BuiltDeepAssetPackage {
  readonly packageValue: DeepAssetPackage;
  readonly blobOrigins: readonly DeepAssetBlobOrigin[];
}

export class DeepAssetPackageBuildError extends Error {}

const STABLE_ID = /^[a-z0-9][a-z0-9._:/-]{0,255}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127}$/;

/**
 * 把转换产物（GLB 与可选 sidecar）组装为确定性 Deep Asset Package：
 * 资源按 id 排序、blob 按哈希排序、入口 scene 依赖全部文件资源，满足 validateDeepAssetPackage。
 */
export async function buildModelDeepAssetPackage(
  input: BuildModelDeepAssetPackageInput,
): Promise<BuiltDeepAssetPackage> {
  if (!STABLE_ID.test(input.packageId)) {
    throw new DeepAssetPackageBuildError(`packageId 必须为小写规范 id：${input.packageId}`);
  }
  if (input.files.length === 0) {
    throw new DeepAssetPackageBuildError("至少需要一个产物文件资源");
  }
  const seenIds = new Set<string>(), seenPaths = new Set<string>();
  for (const file of input.files) {
    if (!STABLE_ID.test(file.id)) throw new DeepAssetPackageBuildError(`资源 id 必须为小写规范 id：${file.id}`);
    if (seenIds.has(file.id)) throw new DeepAssetPackageBuildError(`资源 id 重复：${file.id}`);
    if (seenPaths.has(file.logicalPath)) throw new DeepAssetPackageBuildError(`logicalPath 重复：${file.logicalPath}`);
    if (!MEDIA_TYPE.test(file.mediaType)) throw new DeepAssetPackageBuildError(`mediaType 不合法：${file.mediaType}`);
    if (file.fileName.includes("..") || path.isAbsolute(file.fileName)) {
      throw new DeepAssetPackageBuildError(`fileName 必须是 output 目录内的相对名：${file.fileName}`);
    }
    seenIds.add(file.id); seenPaths.add(file.logicalPath);
  }
  const fileResources: DeepAssetResource[] = [];
  const descriptors: DeepAssetBlobDescriptor[] = [];
  const origins: DeepAssetBlobOrigin[] = [];
  for (const file of input.files) {
    const filePath = path.join(input.outputDir, file.fileName);
    const bytes = await readFile(filePath);
    const hash = createHash("sha256").update(bytes).digest("hex");
    descriptors.push({ hash, byteLength: bytes.byteLength, mediaType: file.mediaType });
    origins.push({ kind: "file", hash, filePath });
    fileResources.push({ id: file.id, kind: file.kind, logicalPath: file.logicalPath, blobHash: hash, dependencies: [] });
  }
  // scene.json 自身也是一个 blob：它记录入口组合关系，几何或 sidecar 变化都会使它失效并随包重新发布。
  const sceneResourceIds = fileResources.map((resource) => resource.id).sort();
  const sceneBytes = deepAssetSceneBlobBytes(sceneResourceIds);
  const sceneHash = createHash("sha256").update(sceneBytes).digest("hex");
  descriptors.push({ hash: sceneHash, byteLength: sceneBytes.byteLength, mediaType: "application/json" });
  const sceneResource: DeepAssetResource = {
    id: "scene:main", kind: "scene", logicalPath: "scene/main.json",
    blobHash: sceneHash, dependencies: sceneResourceIds,
  };
  const packageValue: DeepAssetPackage = {
    schemaVersion: 1,
    manifest: {
      schemaVersion: 1,
      packageId: input.packageId,
      source: input.source,
      importer: input.importer,
      compatibility: input.compatibility,
      resources: [...fileResources, sceneResource].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      entryScene: "scene:main",
    },
    blobs: descriptors.sort((left, right) => left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0),
  };
  origins.push({ kind: "inline", hash: sceneHash, bytes: sceneBytes });
  return { packageValue, blobOrigins: origins.sort((left, right) => left.hash < right.hash ? -1 : 1) };
}

/** scene 资源的字节不入盘；存储 adapter 通过该工厂在 staging 时即时生成。 */
export function deepAssetSceneBlobBytes(resourceIds: readonly string[]): Buffer {
  return Buffer.from(JSON.stringify({ resources: [...resourceIds].sort() }, null, 2), "utf8");
}
