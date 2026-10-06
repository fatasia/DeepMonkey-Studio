/**
 * 场景包 → `.dgc` 驻留摄入(簇级虚拟几何生产链的写端,assetBakeResidency 的簇 LOD 姊妹篇)。
 *
 * 接入点:上传/导入几何的现有处理管线在场景发布时经 `bakeRenderPacketForResidency`
 * (assetBakeResidency)把几何烘成 meshlet 驻留包;本模块消费同一 `RenderPacket` 输入、
 * 挂同一时点,为其中静态几何产出 `.dgc` 字节与簇 LOD 驻留 staging(`ClusterLodSceneStaging`,
 * 经既有 `PbrRenderer.stageClusterLodScene` / native `ClusterLodDagRuntime::from_dgc` →
 * `ClusterLodGpuRuntime::new` 既有 GPU 驻留链消费)。输入一字不改——簇 LOD 是加性驻留面,
 * 未入选几何保持普通 draw 路径,绝不静默丢几何。
 *
 * == 材质实例绑定簇顶点:按实例材质分节(裁决与取舍) ==
 * 静态实例按 (geometryId, materialId) 分节;每节独立 合并(仿射变换展开)→ buildMeshletDag
 * → encodeDgc(.dgc)→ 解码回路签核 → 该节专属 DAG + 材质绑定(materialId 记录在节上)。
 * 节内所有簇顶点共享同一材质实例,"绑定"由构造保证;簇 draw 按节分组即按材质分节。
 * 备选是单 DAG + 逐簇 bindless 材质索引:绘制数更少,但需要 WGSL/实例 ABI/GPU 管线
 * 三处改造且本窗口无真机验证条件,而分节与现有材质链(PreparedBatch 按材质分组、
 * native scene_pack 逐实例材质打包)粒度一致、零 shader 改动、单节可独立 fail-closed
 * (一节失败不毒化整场景)——故取分节。跨实例顶点焊接缺失(节内逐实例展开,同材质
 * 相邻实例不共享顶点)是相对 bindless 的已知代价,与作者链合并器
 * (apps/web buildClusterLodAuthorStaging)同口径。
 *
 * == fail-closed(绝不静默截断) ==
 * - 包级 deformation → 整包拒绝(`deformation-packet`,与作者链合并器同边界);
 * - 带 pose 实例 → 跳过并计数(`skippedDeformedInstances`,slot 不接收变形);
 * - alphaMode=BLEND 材质节 → 显式回退(`blend-material`;opaque pos-only 槽位画不了
 *   半透明,画错比不进簇 LOD 更糟;MASK/OPAQUE 按 G1 pos-only 边界进节);
 * - 顶点预算超限 → 该节回退(`vertex-budget-exceeded`,带数值),不影响其余节;
 * - bake/encode/签核任一失败 → 该节回退(`dgc-failed`,带阶段与消息),原样可诊断;
 * - 零可摄入实例 → `ok:true` 空节集(调用方按 sections.length 判断,无隐藏语义);
 * - 选项违约(非 16 分量变换、非法预算)→ TypeError,与 assetBakeResidency 同风格。
 */
import { buildMeshletDag } from "./geometry/meshletDag.js";
import { meshletDagToEncodable, encodeDgc } from "./geometry/dgcEncoder.js";
import { decodeDgc } from "./geometry/dgcLoader.js";
import { dgcDagToClusterLod } from "./geometry/dgcClusterLodBridge.js";
import type { ClusterLodSceneStaging } from "./webgpu/clusterLodRenderSlot.js";
import type { RenderPacket } from "./renderPacketTypes.js";

export const SCENE_CLUSTER_LOD_INGEST_SCHEMA_VERSION = 1 as const;

export interface SceneClusterLodIngestOptions {
  /** buildMeshletDag 层数(含 level0);缺省走其合同默认(4,可提前收敛)。 */
  readonly levels?: number;
  /** 簇最大三角数(透传 buildMeshletDag/随 .dgc 头持久化);缺省 64。 */
  readonly maxTriangles?: number;
  /** 簇顶点上限(随 .dgc 头持久化,≤64);缺省 64。 */
  readonly maxVertices?: number;
  /** 选层像素阈值透传到每节 staging;缺省走槽位合同(1px)。 */
  readonly pixelThreshold?: number;
  /** 单节合并展开后顶点数上限;超限该节显式回退。缺省 4_000_000(作者链合并器同值)。 */
  readonly maxSectionVertices?: number;
  /** 节数上限(材质×几何组合);超限整包拒绝。缺省 256。 */
  readonly maxSections?: number;
  /** .dgc 段 payload zlib 压缩;缺省 true(与 Rust DgcWriteOptions::default 一致)。 */
  readonly compress?: boolean;
  readonly signal?: AbortSignal;
}

/** 摄入成功的一节:一份 .dgc 字节 + 簇 LOD 驻留 staging + 材质实例绑定记录。 */
export interface SceneClusterLodSection {
  /** 节身份,同时是簇 DAG 合同的 geometryId:`cluster-lod:s<index>:<geometry>:<material>`。 */
  readonly id: string;
  readonly geometryId: string;
  readonly materialId: string;
  /** 按实例材质分节的绑定记录:节内全部簇顶点使用该材质实例(构造保证)。 */
  readonly instanceIds: readonly string[];
  readonly dgcBytes: Uint8Array<ArrayBuffer>;
  /** 既有驻留链直取:stageClusterLodScene(staging) / 原生侧按节 from_dgc。 */
  readonly staging: ClusterLodSceneStaging;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly levelCount: number;
  readonly nodeCount: number;
}

/** 显式回退节:几何保持普通 draw 路径,原因与涉及实例如实上浮,绝不静默。 */
export interface SceneClusterLodFallback {
  readonly geometryId: string;
  readonly materialId: string;
  readonly instanceIds: readonly string[];
  readonly reason: "blend-material" | "vertex-budget-exceeded" | "dgc-failed";
  readonly detail: string;
}

export interface SceneClusterLodIngestValue {
  readonly schemaVersion: typeof SCENE_CLUSTER_LOD_INGEST_SCHEMA_VERSION;
  readonly sections: readonly SceneClusterLodSection[];
  readonly fallbacks: readonly SceneClusterLodFallback[];
  /** 带 pose 被跳过的实例数(变形边界,与作者链合并器同口径)。 */
  readonly skippedDeformedInstances: number;
  /** 进入 .dgc 节的实例数。 */
  readonly mergedInstances: number;
  /** 确定性缓存键:节键+字节长度+计数的 FNV-1a(证据键,非内容身份;内容身份是 .dgc 自身)。 */
  readonly cacheKey: string;
}

export type SceneClusterLodIngestFailure =
  | { readonly reason: "deformation-packet"; readonly detail: string }
  | { readonly reason: "section-budget-exceeded"; readonly detail: string };

export type SceneClusterLodIngestOutcome =
  | { readonly ok: true; readonly value: SceneClusterLodIngestValue }
  | { readonly ok: false; readonly failure: SceneClusterLodIngestFailure };

const DEFAULT_MAX_SECTION_VERTICES = 4_000_000;
const DEFAULT_MAX_SECTIONS = 256;
const DEFAULT_MAX_VERTICES_PER_CLUSTER = 64;
const DEFAULT_MAX_TRIANGLES_PER_CLUSTER = 64;

/**
 * 场景包 → 材质分节 .dgc 摄入。确定性纯函数(同输入逐位同输出);包未变形时
 * 输入 RenderPacket 不被修改(簇 LOD 是加性驻留面,普通 draw 路径始终完整保留)。
 */
export function ingestSceneClusterLod(packet: RenderPacket,
  options: SceneClusterLodIngestOptions = {}): SceneClusterLodIngestOutcome {
  validateOptions(options);
  const maxSectionVertices = options.maxSectionVertices ?? DEFAULT_MAX_SECTION_VERTICES;
  const maxSections = options.maxSections ?? DEFAULT_MAX_SECTIONS;
  if (packet.deformation !== undefined) {
    return { ok: false, failure: { reason: "deformation-packet",
      detail: "Scene cluster LOD ingest rejects deformation packets (static-scene boundary)." } };
  }
  const geometries = new Map(packet.geometries.map(geometry => [geometry.id, geometry]));
  const materials = new Map(packet.materials.map(material => [material.id, material]));
  interface Pending { geometryId: string; materialId: string; instanceIds: string[]; transforms: ArrayLike<number>[] }
  const pending = new Map<string, Pending>();
  const fallbacks: SceneClusterLodFallback[] = [];
  let skippedDeformedInstances = 0;
  for (const instance of packet.instances) {
    if (instance.pose !== undefined) { skippedDeformedInstances += 1; continue; }
    if (instance.transform.length !== 16) {
      throw new TypeError(`Scene cluster LOD ingest requires a 4x4 transform (instance ${instance.id}).`);
    }
    const material = materials.get(instance.material);
    if (!material) throw new TypeError(`Scene cluster LOD ingest cannot resolve material ${instance.material}.`);
    if (material.alphaMode === "BLEND") {
      fallbacks.push({ geometryId: instance.geometry, materialId: instance.material,
        instanceIds: [instance.id], reason: "blend-material",
        detail: "Alpha-blended material is ineligible for the opaque pos-only cluster LOD slot; "
          + "instance stays on the normal draw path." });
      continue;
    }
    const key = `${instance.geometry}\u0000${instance.material}`;
    let section = pending.get(key);
    if (section === undefined) {
      if (pending.size >= maxSections) {
        return { ok: false, failure: { reason: "section-budget-exceeded",
          detail: `Scene cluster LOD ingest exceeds the section budget (${pending.size + 1} > ${maxSections}).` } };
      }
      section = { geometryId: instance.geometry, materialId: instance.material,
        instanceIds: [], transforms: [] };
      pending.set(key, section);
    }
    section.instanceIds.push(instance.id);
    section.transforms.push(instance.transform);
  }
  const sections: SceneClusterLodSection[] = [];
  for (const [index, section] of [...pending.values()].entries()) {
    checkAbort(options.signal);
    const outcome = ingestSection(geometries, section, index,
      { sections, fallbacks }, options, maxSectionVertices);
    if (outcome !== undefined) sections.push(outcome);
  }
  return { ok: true, value: { schemaVersion: SCENE_CLUSTER_LOD_INGEST_SCHEMA_VERSION,
    sections: Object.freeze(sections), fallbacks: Object.freeze(fallbacks),
    skippedDeformedInstances, mergedInstances: sections.reduce((sum, item) => sum + item.instanceIds.length, 0),
    cacheKey: `deep.cluster-lod-ingest.v1:${ingestCacheKey(sections)}` } };
}

function ingestSection(
  geometries: ReadonlyMap<string, RenderPacket["geometries"][number]>,
  section: { geometryId: string; materialId: string; instanceIds: string[]; transforms: ArrayLike<number>[] },
  index: number,
  sink: { sections: SceneClusterLodSection[]; fallbacks: SceneClusterLodFallback[] },
  options: SceneClusterLodIngestOptions, maxSectionVertices: number): SceneClusterLodSection | undefined {
  const geometry = geometries.get(section.geometryId);
  if (!geometry) throw new TypeError(`Scene cluster LOD ingest cannot resolve geometry ${section.geometryId}.`);
  const id = `cluster-lod:s${index}:${section.geometryId}:${section.materialId}`;
  const fallback = (reason: SceneClusterLodFallback["reason"], detail: string): undefined => {
    sink.fallbacks.push({ geometryId: section.geometryId, materialId: section.materialId,
      instanceIds: Object.freeze([...section.instanceIds]), reason, detail });
    return undefined;
  };
  const vertexCount = geometry.vertices.length / 6;
  const expanded = vertexCount * section.transforms.length;
  if (expanded > maxSectionVertices) {
    return fallback("vertex-budget-exceeded",
      `Merging ${section.transforms.length} instances of ${section.geometryId} would exceed the `
        + `per-section vertex budget (${expanded} > ${maxSectionVertices}).`);
  }
  try {
    const merged = mergeTransformedGeometry(geometry, section.transforms, maxSectionVertices);
    const maxTriangles = options.maxTriangles ?? DEFAULT_MAX_TRIANGLES_PER_CLUSTER;
    const maxVertices = options.maxVertices ?? DEFAULT_MAX_VERTICES_PER_CLUSTER;
    const dag = buildMeshletDag({ positions: merged.vertices, indices: merged.indices },
      { ...(options.levels === undefined ? {} : { levels: options.levels }), maxTriangles });
    const dgcBytes = encodeDgc(meshletDagToEncodable(dag, { maxVertices, maxTriangles },
      { sourceVertexCount: merged.vertices.length / 3, sourceTriangleCount: merged.indices.length / 3 }),
      { ...(options.compress === undefined ? {} : { compress: options.compress }) });
    // 解码回路签核:编码产物必须经 decodeDgc 全校验 + 簇 DAG 合同签核后才可驻留。
    const bridged = dgcDagToClusterLod(decodeDgc(dgcBytes), { geometryId: id });
    return Object.freeze({ id, geometryId: section.geometryId, materialId: section.materialId,
      instanceIds: Object.freeze([...section.instanceIds]), dgcBytes,
      staging: { dag: bridged.dag, levelGeometry: bridged.levelGeometry,
        ...(options.pixelThreshold === undefined ? {} : { pixelThreshold: options.pixelThreshold }) },
      vertexCount: merged.vertices.length / 3, triangleCount: merged.indices.length / 3,
      levelCount: dag.levels.length, nodeCount: bridged.dag.nodes.length });
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return fallback("dgc-failed", `Cluster LOD bake/encode/verify pipeline rejected section ${id}: ${detail}`);
  }
}

/**
 * 逐实例仿射展开合并(位置 XYZ;法线不进簇 LOD——pos-only 槽位管线,与作者链合并器
 * 同边界)。展开与 `applyAffinePoint`(three-bridge 公共导出)逐字一致:4x4 列主序,
 * 平移在 m[12..14];Float32Array 写入时的 fround 与 camera-localize 精度口径一致。
 */
function mergeTransformedGeometry(geometry: RenderPacket["geometries"][number],
  transforms: readonly ArrayLike<number>[],
  maxVertices: number): { vertices: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
  const sourceCount = geometry.vertices.length / 6;
  const vertices = new Float32Array(sourceCount * 3 * transforms.length);
  const indices = new Uint32Array(geometry.indices.length * transforms.length);
  let vertexOffset = 0;
  for (const m of transforms) {
    if (vertexOffset + sourceCount > maxVertices) {
      throw new RangeError(`Cluster LOD section merge exceeded the vertex budget (${maxVertices}).`);
    }
    for (let vertex = 0; vertex < sourceCount; vertex++) {
      const base = vertex * 6;
      const x = geometry.vertices[base]!, y = geometry.vertices[base + 1]!, z = geometry.vertices[base + 2]!;
      const target = (vertexOffset + vertex) * 3;
      vertices[target] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      vertices[target + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      vertices[target + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    }
    for (let offset = 0; offset < geometry.indices.length; offset++) {
      indices[offset + vertexOffset] = geometry.indices[offset]! + vertexOffset;
    }
    vertexOffset += sourceCount;
  }
  return { vertices, indices };
}

function validateOptions(options: SceneClusterLodIngestOptions): void {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Invalid scene cluster LOD ingest options.");
  }
  if (options.signal !== undefined && (!options.signal || typeof options.signal.aborted !== "boolean"
    || typeof options.signal.addEventListener !== "function")) {
    throw new TypeError("Invalid ingest AbortSignal.");
  }
  for (const [name, value] of [["levels", options.levels], ["maxTriangles", options.maxTriangles],
    ["maxVertices", options.maxVertices], ["maxSectionVertices", options.maxSectionVertices],
    ["maxSections", options.maxSections]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new RangeError(`Scene cluster LOD ingest ${name} must be a positive safe integer.`);
    }
  }
  if (options.maxVertices !== undefined && options.maxVertices > 64) {
    throw new RangeError("Scene cluster LOD ingest maxVertices must be within the .dgc limit (64).");
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error(signal.reason instanceof Error ? signal.reason.message
    : "Scene cluster LOD ingest was aborted.", signal.reason === undefined ? undefined : { cause: signal.reason });
  error.name = "AbortError";
  throw error;
}

function ingestCacheKey(sections: readonly SceneClusterLodSection[]): string {
  let hash = 0xcbf29ce484222325n;
  const byte = (value: number): void => { hash ^= BigInt(value); hash = BigInt.asUintN(64, hash * 0x100000001b3n); };
  const word = (value: number): void => { for (let shift = 0; shift < 8; shift++) byte(Math.floor(value / 2 ** (shift * 8)) & 255); };
  const text = (value: string): void => { const data = new TextEncoder().encode(value); word(data.length); data.forEach(byte); };
  for (const section of sections) {
    text(section.id);
    word(section.dgcBytes.byteLength);
    word(section.nodeCount);
  }
  return hash.toString(16).padStart(16, "0");
}
