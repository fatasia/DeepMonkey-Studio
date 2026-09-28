import { createHash } from "node:crypto";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AssetCompatibilityProfile, AssetFacetEvidence, DeepAssetImporterProvenance, DeepAssetPackageIssue,
} from "@bim-studio/deep-engine";
import type {
  ConversionQualityTier, DeepAssetPackageReference, ModelFormat, ModelRecord,
  PhysicsColliderEvidence, PhysicsReadinessDeclaration,
} from "@bim-studio/contracts";
import { sha256File } from "./conversionQualityDraft.js";
import {
  buildModelDeepAssetPackage, type DeepAssetBlobOrigin, type DeepAssetPackageFileInput,
} from "./deepAssetPackageBuilder.js";
import { prepareHlodSidecars } from "./hlodPackagePublish.js";
import type { FileSystemDeepAssetPackageStore } from "./deepAssetPackageStore.js";

export interface PublishModelDeepAssetPackageInput {
  readonly store: FileSystemDeepAssetPackageStore;
  readonly model: Pick<ModelRecord, "id" | "projectId" | "name" | "format">;
  readonly sourcePath: string;
  readonly modelDir: string;
  /** 转换器身份；recipeHash 由管线按身份与产物清单派生，保持同 recipe 稳定。 */
  readonly importer: { readonly id: string; readonly version: string };
  readonly compatibility: AssetCompatibilityProfile;
  readonly geometryFileName?: string;
  readonly signal?: AbortSignal;
  /** HLOD bake is opt-in until Web instance IDs and package consumption are aligned. */
  readonly includeHlod?: boolean;
}

export interface PublishedDeepAssetPackage {
  readonly reference: DeepAssetPackageReference;
  readonly status: "committed" | "unchanged";
  readonly revision: number;
  /** unchanged 时与上一修订共享的全部 blob 数（依赖最小失效的存储面证据）。 */
  readonly reusedBlobs: number;
  readonly addedBlobs: number;
}

/**
 * 转换产物 → Deep Asset Package 生产与持久化管线：
 * 校验、并行 staging、修订号 CAS 发布一气呵成；包 manifest 落盘为 output/deep-package.json。
 * 发布被拒绝或冲突时返回 undefined 并告警，不把转换结果标为失败（几何与 sidecar 已就绪）。
 */
export async function publishModelDeepAssetPackage(
  input: PublishModelDeepAssetPackageInput,
): Promise<PublishedDeepAssetPackage | undefined> {
  const geometryFileName = input.geometryFileName ?? "geometry.glb";
  const outputDir = path.join(input.modelDir, "output");
  const files: DeepAssetPackageFileInput[] = [{
    id: "geometry:main", kind: "mesh", logicalPath: `output/${geometryFileName}`,
    fileName: geometryFileName, mediaType: "model/gltf-binary",
  }];
  for (const sidecar of ["hierarchy.json", "properties.json"] as const) {
    if (await exists(path.join(outputDir, sidecar))) {
      files.push({
        id: `metadata:${sidecar.replace(".json", "")}`, kind: "metadata", logicalPath: `output/${sidecar}`,
        fileName: sidecar, mediaType: "application/json",
      });
    }
  }
  if (input.includeHlod) {
    try {
      const sidecars = await prepareHlodSidecars(outputDir, geometryFileName, input.signal);
      files.push(...sidecars.files);
    } catch (error) {
      // HLOD was explicitly requested: never replace the active package with an incomplete revision.
      if (!input.signal?.aborted) console.warn("HLOD bake failed; prior Deep Asset Package remains active", error);
      return undefined;
    }
  }
  if (input.signal?.aborted) return undefined;
  const [sourceHash, sourceByteLength] = await Promise.all([sha256File(input.sourcePath), sourceSize(input.sourcePath)]);
  if (input.signal?.aborted) return undefined;
  const recipeHash = createHash("sha256").update(JSON.stringify({
    importer: input.importer, files: files.map((file) => file.logicalPath),
  })).digest("hex");
  const importerProvenance: DeepAssetImporterProvenance = {
    kind: "open-converter",
    id: input.importer.id,
    version: input.importer.version,
    recipeHash,
    deterministic: true,
  };
  let origins: readonly DeepAssetBlobOrigin[] = [];
  let packageValue: Awaited<ReturnType<typeof buildModelDeepAssetPackage>>["packageValue"];
  try {
    const built = await buildModelDeepAssetPackage({
      packageId: `pkg:${input.model.id}`,
      source: {
        kind: "model-file",
        logicalName: path.basename(input.sourcePath),
        contentHash: sourceHash,
        byteLength: sourceByteLength,
      },
      importer: importerProvenance,
      compatibility: input.compatibility,
      files,
      outputDir,
    });
    packageValue = built.packageValue;
    origins = built.blobOrigins;
  } catch (error) {
    console.warn("Deep Asset Package 构建失败，转换结果保留但无资产包引用", error);
    return undefined;
  }
  if (input.signal?.aborted) return undefined;
  const executor = input.store.createExecutor(origins);
  let result: Awaited<ReturnType<typeof executor.publish>>;
  try { result = await executor.publish(packageValue, { concurrency: 4,
    ...(input.signal ? { signal: input.signal } : {}) }); }
  finally { executor.dispose(); }
  if (result.status !== "committed" && result.status !== "unchanged" || !result.commit) {
    console.warn(`Deep Asset Package 发布未完成（status=${result.status}）`,
      summarizeIssues(result.issues), result.failure ? `failure=${result.failure}` : "");
    return undefined;
  }
  const revision = result.status === "committed" ? result.commit.nextRevision : result.commit.expectedRevision;
  const reference: DeepAssetPackageReference = {
    packageId: packageValue.manifest.packageId,
    revision,
    sourceHash,
    entryScene: packageValue.manifest.entryScene,
    packageUrl: `/assets/projects/${input.model.projectId}/models/${input.model.id}/output/deep-package.json`,
  };
  await writeFile(path.join(outputDir, "deep-package.json"), JSON.stringify({
    schemaVersion: 1,
    ...reference,
    package: packageValue,
  }, null, 2), "utf8");
  return {
    reference,
    status: result.status,
    revision,
    reusedBlobs: result.reusedBlobs,
    addedBlobs: result.committedBlobs,
  };
}

/**
 * collider 派生物 sidecar 约定名（D1）。生成端（T17 generatePhysicsCollider*）落盘该文件后，
 * 兼容性 profile 与质量报告才会按证据升级；生产链当前不产出，检测缺失时一律保持 unverified，
 * 不虚标 verified。条目字典与 T17 PhysicsColliderSourceResult 对齐，此处只验证结构可消费，
 * 几何正确性由运行时消费链与测试负责。
 */
export const COLLIDER_SIDECAR_FILE = "colliders.json";

export const PHYSICS_COLLIDERS_EVIDENCE_ID = "physics:colliders";

interface ColliderSidecarEntry {
  strategy?: unknown;
  status?: unknown;
}

interface ColliderSidecar {
  schemaVersion?: unknown;
  colliders?: unknown;
}

function isColliderStrategy(value: unknown): value is "convex-hull" | "simplified-mesh" {
  return value === "convex-hull" || value === "simplified-mesh";
}

/**
 * 检测 output 目录中可消费的 collider 派生物：
 * 文件缺失 / JSON 解析失败 / schemaVersion≠1 / 条目全 failed 或为空 → null（证据不存在）。
 * 存在 ok/approximate 条目 → 返回带内容哈希的证据；strategy 混合时标 mixed，
 * 任一 approximate 时 approximate=true（T17 近似语义，消费方不得冒充精确）。
 */
export async function detectColliderDerivativeEvidence(outputDir: string): Promise<PhysicsColliderEvidence | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(outputDir, COLLIDER_SIDECAR_FILE), "utf8");
  } catch {
    return null;
  }
  let parsed: ColliderSidecar;
  try {
    parsed = JSON.parse(raw) as ColliderSidecar;
  } catch {
    return null;
  }
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.colliders)) return null;
  const strategies = new Set<"convex-hull" | "simplified-mesh">();
  const consumable = parsed.colliders.filter((entry): entry is ColliderSidecarEntry & { strategy: "convex-hull" | "simplified-mesh" } => {
    if (typeof entry !== "object" || entry === null || !isColliderStrategy(entry.strategy)) return false;
    return entry.status === "ok" || entry.status === "approximate";
  });
  if (consumable.length === 0) return null;
  for (const entry of consumable) strategies.add(entry.strategy);
  return {
    evidenceId: PHYSICS_COLLIDERS_EVIDENCE_ID,
    strategy: strategies.size === 1 ? [...strategies][0]! : "mixed",
    evidenceSha256: await sha256File(path.join(outputDir, COLLIDER_SIDECAR_FILE)),
    ...(consumable.some((entry) => entry.status === "approximate") ? { approximate: true } : {}),
  };
}

/** colliders facet 的证据分级：有可消费派生物 → partial（未闭环运行时验证），否则 unverified。 */
function colliderFacetEvidence(colliderEvidence: PhysicsColliderEvidence | null | undefined): AssetFacetEvidence {
  if (colliderEvidence) {
    return {
      status: "partial",
      evidenceIds: [colliderEvidence.evidenceId],
      reason: "存在 collider 派生物证据（colliders.json），运行时消费验证未闭环，不声明 verified",
    };
  }
  return {
    status: "unverified",
    evidenceIds: [],
    reason: "colliders 尚无该转换链的独立验证证据，不声明支持",
  };
}

/** 与转换器身份绑定的兼容性 profile；facet 证据按产物实际可得性标注，不把未验证 facet 标 verified。 */
export function buildCadCompatibilityProfile(
  format: ModelFormat,
  importerId: string,
  importerVersion: string,
  options: { readonly hierarchy: boolean; readonly properties: boolean; readonly colliderEvidence?: PhysicsColliderEvidence | null },
): AssetCompatibilityProfile {
  const unverified = (facet: string): { status: "unverified"; evidenceIds: readonly string[]; reason: string } => ({
    status: "unverified", evidenceIds: [],
    reason: `${facet} 尚无该转换链的独立验证证据，不声明支持`,
  });
  const geometryEvidence = { status: "verified" as const, evidenceIds: ["geometry:main"], reason: null };
  const hierarchyEvidence = options.hierarchy
    ? { status: "verified" as const, evidenceIds: ["metadata:hierarchy"], reason: null }
    : unverified("hierarchy");
  const metadataEvidence = options.properties
    ? { status: "verified" as const, evidenceIds: ["metadata:properties"], reason: null }
    : unverified("metadata");
  const facets = {
    geometry: geometryEvidence,
    hierarchy: hierarchyEvidence,
    materials: unverified("materials"),
    textures: unverified("textures"),
    animation: unverified("animation"),
    skin: unverified("skin"),
    morph: unverified("morph"),
    cameras: unverified("cameras"),
    lights: unverified("lights"),
    colliders: colliderFacetEvidence(options.colliderEvidence),
    navmesh: unverified("navmesh"),
    metadata: metadataEvidence,
    pmi: unverified("pmi"),
    behavior: unverified("behavior"),
    audio: unverified("audio"),
  };
  return {
    schemaVersion: 1,
    id: `cad-${format}-gltf`,
    sourceKind: "model-file",
    format,
    importer: "open-converter",
    runtimeArtifact: "deep-asset-package",
    importerVersion,
    fixtureSetHash: createHash("sha256").update(`${importerId}:${importerVersion}:${format}`).digest("hex"),
    deterministic: true,
    facets,
  };
}

/**
 * D1 physics-ready 资产档判定（纯函数）：兼容性 profile + collider 证据 + 质量档 →
 * physics-ready / geometry-only 两档声明。判定保守、不冒充：
 * - inspect/preview 质量档直接 geometry-only（工业格式计划 §2.2：inspect/preview 不是发布凭证）；
 * - geometry facet 未 verified、colliders facet 未达 partial/verified、证据缺失或与
 *   profile 证据 id 脱钩，任一不满足都保持 geometry-only 并给机器可读原因。
 * 不校验 collider 几何本身——那是生成端（T17）与运行时消费链的职责。
 */
export function determinePhysicsReadiness(input: {
  readonly profile: AssetCompatibilityProfile;
  readonly colliderEvidence: PhysicsColliderEvidence | null | undefined;
  readonly qualityTier: ConversionQualityTier;
}): PhysicsReadinessDeclaration {
  const { profile, colliderEvidence, qualityTier } = input;
  const geometryOnly = (reason: string): PhysicsReadinessDeclaration => ({ tier: "geometry-only", reason });
  if (qualityTier === "inspect" || qualityTier === "preview") {
    return geometryOnly("inspect/preview 质量档不得声明 physics-ready");
  }
  if (profile.facets.geometry?.status !== "verified") {
    return geometryOnly("geometry facet 未 verified，几何基础不满足 physics-ready");
  }
  const collidersStatus = profile.facets.colliders?.status;
  if (collidersStatus !== "partial" && collidersStatus !== "verified") {
    return geometryOnly("colliders facet 无证据支撑（unverified/unsupported）");
  }
  if (!colliderEvidence) {
    return geometryOnly("colliders facet 已标注但 collider 证据缺失，不得声明 physics-ready");
  }
  if (!profile.facets.colliders.evidenceIds.includes(colliderEvidence.evidenceId)) {
    return geometryOnly("collider 证据与兼容性 profile 的证据 id 脱钩，判定保守为 geometry-only");
  }
  if (colliderEvidence.approximate === true) {
    return {
      tier: "physics-ready",
      colliderEvidence,
      reason: "collider 为近似体（T17 approximate），可用于物理仿真但不得冒充精确碰撞",
    };
  }
  return { tier: "physics-ready", colliderEvidence };
}

function summarizeIssues(issues: readonly DeepAssetPackageIssue[]): string {
  if (issues.length === 0) return "issues=[]";
  return `issues=${issues.slice(0, 5).map((issue) => `${issue.code}@${issue.path}`).join(", ")}${issues.length > 5 ? `（共 ${issues.length} 条）` : ""}`;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function sourceSize(target: string): Promise<number> {
  return (await stat(target)).size;
}
