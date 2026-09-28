import { NodeIO, type Material, type TextureInfo } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { MeshoptDecoder } from "meshoptimizer";
import {
  MESH_SAMPLE_LIMIT,
  countNonFinite,
  decodeScalarIndices,
  decodeVec3Attribute,
  positionRemap,
} from "./meshProcessingShared.js";

/**
 * T12 几何处理切片之 UV 检查:越界 UV、重叠 UV 岛、接缝分裂、零面积 UV 三角形、
 * 缺失 TEXCOORD 的**只检测不修补**报告。机器可读 issue 字典与 meshTopologyInspection 同构;
 * 任何畸形输入都以 issue 呈现,不抛异常。修复能力见 uvRepair.ts(默认关闭,显式启用)。
 */

export type UvIssueSeverity = "error" | "warning" | "info";

export type UvIssueCode =
  | "MALFORMED_INPUT"
  | "TEXCOORD_MISSING"
  | "UV_OUT_OF_RANGE"
  | "UV_OVERLAP"
  | "UV_DEGENERATE_TRIANGLE"
  | "UV_SEAM_SPLIT"
  | "PRIMITIVE_MODE_UNSUPPORTED"
  | "INSPECTION_FAILED";

export interface UvIssueDescriptor {
  severity: UvIssueSeverity;
  meaning: string;
  locator: string;
}

/** UV issue 字典:码 → 严重级 / 含义 / 定位符格式。机器可读,测试与报告共用。 */
export const UV_ISSUE_DICTIONARY: Readonly<Record<UvIssueCode, UvIssueDescriptor>> = {
  MALFORMED_INPUT: {
    severity: "error",
    meaning: "POSITION/indices/TEXCOORD_N 数组长度非法或含非有限值,无法按三角网格解读",
    locator: "primitive:<primitiveId> attribute:<POSITION|indices|TEXCOORD_N>",
  },
  TEXCOORD_MISSING: {
    severity: "error",
    meaning: "材质绑定纹理所需的 UV 通道缺失(采样回退、烘焙无法进行)",
    locator: "primitive:<primitiveId> channel:<TEXCOORD_N>",
  },
  UV_OUT_OF_RANGE: {
    severity: "warning",
    meaning: "UV 超出 [0,1] 且该通道无 wrapping 语义声明(通道全部纹理两轴 REPEAT/MIRRORED_REPEAT 视为已声明平铺,不报);可能为贴图截断",
    locator: "primitive:<primitiveId> channel:<TEXCOORD_N> vertex:<i> uv:<u,v>",
  },
  UV_OVERLAP: {
    severity: "warning",
    meaning: "同图元内不同 UV 岛的包围盒重叠(保守 AABB 检测;镜像/堆叠 UV 属有意重叠需人工确认);烘焙/图集绘制会互相覆盖",
    locator: "primitive:<primitiveId> channel:<TEXCOORD_N> island:<a> x island:<b>",
  },
  UV_DEGENERATE_TRIANGLE: {
    severity: "warning",
    meaning: "UV 空间零面积的三角形;重心坐标退化,烘焙会产生 NaN(渲染可存活)",
    locator: "primitive:<primitiveId> channel:<TEXCOORD_N> triangle:<i> reason:zero-area-uv",
  },
  UV_SEAM_SPLIT: {
    severity: "info",
    meaning: "同位置顶点在该通道持有不同 UV(UV 接缝分裂),统计性提示,不是缺陷",
    locator: "primitive:<primitiveId> channel:<TEXCOORD_N> position:<canonicalId> uvVariants:<k>",
  },
  PRIMITIVE_MODE_UNSUPPORTED: {
    severity: "info",
    meaning: "非 TRIANGLES(mode 4)图元,本检查跳过其 UV 统计",
    locator: "primitive:<primitiveId> mode:<mode>",
  },
  INSPECTION_FAILED: {
    severity: "error",
    meaning: "检查过程内部异常(不中断其余图元,样本保证不崩溃)",
    locator: "primitive:<primitiveId> message:<message>",
  },
};

export interface MeshPrimitiveUvInput {
  primitiveId: string;
  /** 连续 XYZ;长度必须是 3 的倍数。畸形时跳过接缝/退化统计,不崩溃。 */
  positions: ArrayLike<number>;
  /** 三角列表索引;长度必须是 3 的倍数。 */
  indices: ArrayLike<number>;
  /** 通道名(TEXCOORD_0…) → 连续 UV(2×顶点数)。 */
  uvChannels: Readonly<Record<string, ArrayLike<number>>>;
  /** 通道 → wrapping 语义已声明(该通道全部纹理两轴 REPEAT/MIRRORED_REPEAT,含 glTF 缺省采样器)。缺省全部未声明。 */
  wrappingDeclaredChannels?: Readonly<Record<string, boolean>> | undefined;
  /** 材质绑定纹理所需的通道名。缺省 []。 */
  requiredUvChannels?: readonly string[] | undefined;
}

export interface UvIssue {
  code: UvIssueCode;
  severity: UvIssueSeverity;
  primitiveId: string;
  count: number;
  samples: string[];
  detail?: string;
}

export interface UvChannelStats {
  channel: string;
  primitiveId: string;
  vertexCount: number;
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
  /** 越界分量值个数(无论是否声明 wrapping 均计数,供修复决策参考)。 */
  outOfRangeValues: number;
  wrappingDeclared: boolean;
  /** 同位置顶点 UV 分裂的位置组数。 */
  seamSplitPositions: number;
  /** UV 零面积三角形数。 */
  degenerateTriangles: number;
  islandCount: number;
}

export interface UvInspectionReport {
  primitiveCount: number;
  vertexCount: number;
  triangleCount: number;
  uvChannelCount: number;
  islandCount: number;
  /** 无 error 级 issue 时为 true;只读语义,不代表几何被修补。 */
  ok: boolean;
  issues: UvIssue[];
  issueCountsByCode: Partial<Record<UvIssueCode, number>>;
  channelStats: UvChannelStats[];
}

/** UV 岛重叠扫描的岛数上限;超出后按岛 id 顺序扫描前 N 个并在 detail 声明截断(诚实边界)。 */
export const UV_OVERLAP_ISLAND_SCAN_LIMIT = 1024;

const SEVERITY_RANK: Record<UvIssueSeverity, number> = { error: 0, warning: 1, info: 2 };

const WRAP_REPEAT = 10497;
const WRAP_MIRRORED_REPEAT = 33648;

/** UV 通道名确定性排序(TEXCOORD_2 排在 TEXCOORD_10 之前按数值比较)。 */
export function compareUvChannelNames(a: string, b: string): number {
  const na = Number(a.slice("TEXCOORD_".length));
  const nb = Number(b.slice("TEXCOORD_".length));
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}

/** 精确 UV 值键(-0 归一化为 0;非有限值由 MALFORMED_INPUT 拦截,不入键)。 */
export function exactUvKey(u: number, v: number): string {
  return `${u === 0 ? 0 : u}|${v === 0 ? 0 : v}`;
}

/** glTF TEXCOORD 解码为连续 Float32Array(count*2)。 */
export function decodeVec2Attribute(accessor: { getCount(): number; getElement(index: number, target: number[]): void }): Float32Array {
  const count = accessor.getCount();
  const out = new Float32Array(count * 2);
  const element = [0, 0];
  for (let index = 0; index < count; index += 1) {
    accessor.getElement(index, element);
    out[index * 2] = element[0]!;
    out[index * 2 + 1] = element[1]!;
  }
  return out;
}

/** 单图元 UV 检查(核心,数组入参,可脱离 GLB 复用)。返回按严重级排序的 issue 与逐通道统计。 */
export async function inspectPrimitiveUvs(
  primitive: MeshPrimitiveUvInput,
): Promise<{ issues: UvIssue[]; stats: UvChannelStats[]; islandCount: number }> {
  const issues: UvIssue[] = [];
  const stats: UvChannelStats[] = [];
  let islandCount = 0;
  try {
    const { primitiveId } = primitive;
    const positionsValid = primitive.positions.length % 3 === 0 && countNonFinite(primitive.positions) === 0;
    if (!positionsValid) {
      issues.push(uvIssue("MALFORMED_INPUT", primitiveId, 1,
        [`attribute:POSITION length:${primitive.positions.length}`], "POSITION 长度不是 3 的倍数或含非有限坐标;跳过接缝/退化/重叠统计"));
    }
    const vertexCount = positionsValid ? primitive.positions.length / 3 : 0;

    let triangleCount = Math.floor(primitive.indices.length / 3);
    if (primitive.indices.length % 3 !== 0) {
      issues.push(uvIssue("MALFORMED_INPUT", primitiveId, 1,
        [`attribute:indices length:${primitive.indices.length}`], "索引长度不是 3 的倍数,按截断到完整三角形继续检查"));
    }

    const declared = primitive.wrappingDeclaredChannels ?? {};
    const channelNames = Object.keys(primitive.uvChannels).sort(compareUvChannelNames);
    const validChannels: string[] = [];

    // 顶点级:逐通道长度/非有限/越界与统计。
    for (const channel of channelNames) {
      const uvs = primitive.uvChannels[channel]!;
      if (positionsValid && uvs.length !== vertexCount * 2) {
        issues.push(uvIssue("MALFORMED_INPUT", primitiveId, 1,
          [`attribute:${channel} length:${uvs.length}`], `长度应为顶点数*2=${vertexCount * 2}`));
        continue;
      }
      const nonFinite = countNonFinite(uvs);
      if (nonFinite > 0) {
        issues.push(uvIssue("MALFORMED_INPUT", primitiveId, nonFinite,
          [`attribute:${channel} non-finite`], "UV 含非有限值"));
        continue;
      }
      validChannels.push(channel);
      if (!positionsValid) continue;
      const statsAndIssue = inspectChannelVertices(primitiveId, channel, uvs, vertexCount, declared[channel] === true);
      stats.push(statsAndIssue.stats);
      if (statsAndIssue.issue) issues.push(statsAndIssue.issue);
    }

    // 材质所需通道缺失(存在于但畸形的通道由 MALFORMED_INPUT 覆盖,不重复报)。
    for (const channel of [...(primitive.requiredUvChannels ?? [])].sort()) {
      if (!validChannels.includes(channel)) {
        issues.push(uvIssue("TEXCOORD_MISSING", primitiveId, 1, [`channel:${channel}`]));
      }
    }

    if (positionsValid && triangleCount > 0) {
      const indices = primitive.indices;
      const remap = await positionRemap(toFloat32(primitive.positions));
      for (const statsEntry of stats) {
        const uvs = primitive.uvChannels[statsEntry.channel]!;
        statsEntry.seamSplitPositions = countSeamSplits(uvs, remap);
        if (statsEntry.seamSplitPositions > 0) {
          issues.push(uvIssue("UV_SEAM_SPLIT", primitiveId, statsEntry.seamSplitPositions,
            seamSamples(uvs, remap, statsEntry.channel), `channel:${statsEntry.channel}`));
        }
        statsEntry.degenerateTriangles = countDegenerateUvTriangles(uvs, indices, triangleCount, vertexCount);
        if (statsEntry.degenerateTriangles > 0) {
          issues.push(uvIssue("UV_DEGENERATE_TRIANGLE", primitiveId, statsEntry.degenerateTriangles,
            degenerateSamples(uvs, indices, triangleCount, vertexCount, statsEntry.channel),
            `channel:${statsEntry.channel}`));
        }
        const islands = buildUvIslands(uvs, indices, triangleCount, vertexCount);
        statsEntry.islandCount = islands.count;
        const overlap = findOverlappingIslandPairs(islands.bounds, islands.count);
        if (overlap.pairs > 0) {
          issues.push(uvIssue("UV_OVERLAP", primitiveId, overlap.pairs, overlap.samples,
            `channel:${statsEntry.channel} islands:${islands.count} scanned:${overlap.scanned}`
            + (overlap.capped ? ` capped:true islandsBeyondLimit:${islands.count - overlap.scanned} countIsLowerBound:true` : "")));
        }
        islandCount += islands.count;
      }
    }
    return { issues: sortIssues(issues), stats, islandCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push(uvIssue("INSPECTION_FAILED", primitive.primitiveId, 1, [`message:${message}`]));
    return { issues: sortIssues(issues), stats, islandCount };
  }
}

function inspectChannelVertices(
  primitiveId: string,
  channel: string,
  uvs: ArrayLike<number>,
  vertexCount: number,
  wrappingDeclared: boolean,
): { stats: UvChannelStats; issue: UvIssue | null } {
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  let outOfRangeValues = 0;
  const samples: string[] = [];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const u = uvs[vertex * 2]!, v = uvs[vertex * 2 + 1]!;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
    const badAxes = (u < 0 || u > 1 ? 1 : 0) + (v < 0 || v > 1 ? 1 : 0);
    if (badAxes > 0) {
      outOfRangeValues += badAxes;
      if (samples.length < MESH_SAMPLE_LIMIT) {
        samples.push(`vertex:${vertex} uv:${formatNumber(u)},${formatNumber(v)}`);
      }
    }
  }
  const stats: UvChannelStats = {
    channel, primitiveId, vertexCount,
    minU, maxU, minV, maxV,
    outOfRangeValues,
    wrappingDeclared,
    seamSplitPositions: 0,
    degenerateTriangles: 0,
    islandCount: 0,
  };
  if (outOfRangeValues > 0 && !wrappingDeclared) {
    const issue = uvIssue("UV_OUT_OF_RANGE", primitiveId, outOfRangeValues, samples, `channel:${channel}`
      + ` minU:${formatNumber(minU)} maxU:${formatNumber(maxU)} minV:${formatNumber(minV)} maxV:${formatNumber(maxV)}`);
    return { stats, issue };
  }
  return { stats, issue: null };
}

function countDegenerateUvTriangles(
  uvs: ArrayLike<number>,
  indices: ArrayLike<number>,
  triangleCount: number,
  vertexCount: number,
): number {
  let count = 0;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    if (uvTriangleDoubledArea(uvs, indices, triangle, vertexCount) === 0) count += 1;
  }
  return count;
}

function degenerateSamples(
  uvs: ArrayLike<number>,
  indices: ArrayLike<number>,
  triangleCount: number,
  vertexCount: number,
  channel: string,
): string[] {
  const samples: string[] = [];
  for (let triangle = 0; triangle < triangleCount && samples.length < MESH_SAMPLE_LIMIT; triangle += 1) {
    if (uvTriangleDoubledArea(uvs, indices, triangle, vertexCount) === 0) {
      samples.push(`channel:${channel} triangle:${triangle} reason:zero-area-uv`);
    }
  }
  return samples;
}

/** UV 空间有向面积 ×2;索引越界的三角形返回 NaN(不等于 0,不计退化)。 */
function uvTriangleDoubledArea(
  uvs: ArrayLike<number>,
  indices: ArrayLike<number>,
  triangle: number,
  vertexCount: number,
): number {
  const a = indices[triangle * 3]!, b = indices[triangle * 3 + 1]!, c = indices[triangle * 3 + 2]!;
  if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c)
    || a < 0 || b < 0 || c < 0 || a >= vertexCount || b >= vertexCount || c >= vertexCount) return NaN;
  const ua = uvs[a * 2]!, va = uvs[a * 2 + 1]!;
  const ub = uvs[b * 2]!, vb = uvs[b * 2 + 1]!;
  const uc = uvs[c * 2]!, vc = uvs[c * 2 + 1]!;
  return (ub - ua) * (vc - va) - (uc - ua) * (vb - va);
}

function collectUvVariantsByPosition(uvs: ArrayLike<number>, remap: Uint32Array): Map<number, Set<string>> {
  const groups = new Map<number, Set<string>>();
  for (let vertex = 0; vertex < remap.length; vertex += 1) {
    const canonical = remap[vertex]!;
    let variants = groups.get(canonical);
    if (variants === undefined) {
      variants = new Set<string>();
      groups.set(canonical, variants);
    }
    variants.add(exactUvKey(uvs[vertex * 2]!, uvs[vertex * 2 + 1]!));
  }
  return groups;
}

function countSeamSplits(uvs: ArrayLike<number>, remap: Uint32Array): number {
  let count = 0;
  for (const variants of collectUvVariantsByPosition(uvs, remap).values()) {
    if (variants.size > 1) count += 1;
  }
  return count;
}

function seamSamples(uvs: ArrayLike<number>, remap: Uint32Array, channel: string): string[] {
  const samples: string[] = [];
  const groups = collectUvVariantsByPosition(uvs, remap);
  const ordered = [...groups.entries()].sort((left, right) => left[0] - right[0]);
  for (const [canonical, variants] of ordered) {
    if (variants.size > 1 && samples.length < MESH_SAMPLE_LIMIT) {
      samples.push(`channel:${channel} position:${canonical} uvVariants:${variants.size}`);
    }
  }
  return samples;
}

interface UvIslandIndex {
  count: number;
  /** 岛 id → [minU, minV, maxU, maxV];岛 id 按 UV 角点规范键排序分配(确定性)。 */
  bounds: Array<[number, number, number, number]>;
}

/** 按 UV 角点共享做并查集聚岛;3T 角点线性 + 反路径压缩。 */
function buildUvIslands(
  uvs: ArrayLike<number>,
  indices: ArrayLike<number>,
  triangleCount: number,
  vertexCount: number,
): UvIslandIndex {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = key;
    while (parent.get(cursor) !== cursor) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra); else parent.set(ra, rb);
  };
  const boundsByKey = new Map<string, [number, number, number, number]>();
  const ensure = (vertex: number): string => {
    const u = uvs[vertex * 2]!, v = uvs[vertex * 2 + 1]!;
    const key = exactUvKey(u, v);
    if (!parent.has(key)) {
      parent.set(key, key);
      boundsByKey.set(key, [u, v, u, v]);
    }
    return key;
  };
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const a = indices[triangle * 3]!, b = indices[triangle * 3 + 1]!, c = indices[triangle * 3 + 2]!;
    if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c)
      || a < 0 || b < 0 || c < 0 || a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
    const ka = ensure(a), kb = ensure(b), kc = ensure(c);
    union(ka, kb);
    union(kb, kc);
  }
  const rootBounds = new Map<string, [number, number, number, number]>();
  for (const [key, bounds] of boundsByKey) {
    const root = find(key);
    const target = rootBounds.get(root);
    if (target === undefined) {
      rootBounds.set(root, [bounds[0], bounds[1], bounds[2], bounds[3]]);
    } else {
      target[0] = Math.min(target[0], bounds[0]);
      target[1] = Math.min(target[1], bounds[1]);
      target[2] = Math.max(target[2], bounds[2]);
      target[3] = Math.max(target[3], bounds[3]);
    }
  }
  const orderedRoots = [...rootBounds.keys()].sort();
  return { count: orderedRoots.length, bounds: orderedRoots.map((root) => rootBounds.get(root)!) };
}

/** 岛 AABB 两两重叠(闭区间判定);扫描上限 UV_OVERLAP_ISLAND_SCAN_LIMIT,超出声明截断。 */
function findOverlappingIslandPairs(
  bounds: Array<[number, number, number, number]>,
  islandCount: number,
): { pairs: number; samples: string[]; scanned: number; capped: boolean } {
  const scanned = Math.min(islandCount, UV_OVERLAP_ISLAND_SCAN_LIMIT);
  let pairs = 0;
  const samples: string[] = [];
  for (let i = 0; i < scanned; i += 1) {
    for (let j = i + 1; j < scanned; j += 1) {
      const a = bounds[i]!, b = bounds[j]!;
      if (Math.max(a[0], b[0]) <= Math.min(a[2], b[2]) && Math.max(a[1], b[1]) <= Math.min(a[3], b[3])) {
        pairs += 1;
        if (samples.length < MESH_SAMPLE_LIMIT) {
          samples.push(`island:${i} bounds:[${a.map(formatNumber).join(",")}]`
            + ` x island:${j} bounds:[${b.map(formatNumber).join(",")}]`);
        }
      }
    }
  }
  return { pairs, samples, scanned, capped: islandCount > scanned };
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6) : String(value);
}

/** 全量检查:聚合图元,输出确定性排序的机器可读报告。 */
export async function inspectMeshUvs(primitives: MeshPrimitiveUvInput[]): Promise<UvInspectionReport> {
  const issues: UvIssue[] = [];
  const stats: UvChannelStats[] = [];
  let vertexCount = 0;
  let triangleCount = 0;
  let islandCount = 0;
  for (const primitive of primitives) {
    vertexCount += primitive.positions.length / 3;
    triangleCount += Math.floor(primitive.indices.length / 3);
    const finding = await inspectPrimitiveUvs(primitive);
    issues.push(...finding.issues);
    stats.push(...finding.stats);
    islandCount += finding.islandCount;
  }
  stats.sort((left, right) => left.primitiveId.localeCompare(right.primitiveId)
    || compareUvChannelNames(left.channel, right.channel));
  const sorted = sortIssues(issues);
  return {
    primitiveCount: primitives.length,
    vertexCount,
    triangleCount,
    uvChannelCount: stats.length,
    islandCount,
    ok: !sorted.some((entry) => entry.severity === "error"),
    issues: sorted,
    issueCountsByCode: countByCode(sorted),
    channelStats: stats,
  };
}

/** GLB 适配器:读取文件,枚举 mesh/primitive、材质纹理槽与采样器 wrapping 后走核心检查。只读,不写文件。 */
export async function inspectGlbUvs(filePath: string): Promise<UvInspectionReport> {
  const io = await glbIo();
  const document = await io.read(filePath);
  const primitives: MeshPrimitiveUvInput[] = [];
  const adapterIssues: UvIssue[] = [];
  document.getRoot().listMeshes().forEach((mesh, meshIndex) => {
    mesh.listPrimitives().forEach((primitive, primitiveIndex) => {
      const primitiveId = `mesh:${meshIndex}/primitive:${primitiveIndex}`;
      if (primitive.getMode() !== 4) {
        adapterIssues.push(uvIssue("PRIMITIVE_MODE_UNSUPPORTED", primitiveId, 1, [`mode:${primitive.getMode()}`]));
        return;
      }
      const positionAccessor = primitive.getAttribute("POSITION");
      if (!positionAccessor) {
        adapterIssues.push(uvIssue("MALFORMED_INPUT", primitiveId, 1, ["attribute:POSITION missing"]));
        return;
      }
      const uvChannels: Record<string, Float32Array> = {};
      for (const semantic of primitive.listSemantics()) {
        if (!/^TEXCOORD_\d+$/.test(semantic)) continue;
        const accessor = primitive.getAttribute(semantic);
        if (!accessor) continue;
        uvChannels[semantic] = decodeVec2Attribute(accessor);
      }
      const context = materialUvContext(primitive.getMaterial());
      primitives.push({
        primitiveId,
        positions: decodeVec3Attribute(positionAccessor),
        indices: primitive.getIndices() ? decodeScalarIndices(primitive.getIndices()!) : sequence(positionAccessor.getCount()),
        uvChannels,
        wrappingDeclaredChannels: context.wrappingDeclared,
        requiredUvChannels: context.requiredChannels,
      });
    });
  });
  const report = await inspectMeshUvs(primitives);
  report.issues = sortIssues([...report.issues, ...adapterIssues]);
  report.issueCountsByCode = countByCode(report.issues);
  report.ok = !report.issues.some((entry) => entry.severity === "error");
  return report;
}

interface MaterialUvContext {
  requiredChannels: string[];
  wrappingDeclared: Record<string, boolean>;
}

/**
 * 从材质收集:绑定纹理所需的 TEXCOORD 通道,以及各通道的 wrapping 声明
 * (glTF Transform v4 把 Sampler 并入 TextureInfo,缺省 wrapS/wrapT = REPEAT;
 * 某通道全部纹理两轴 REPEAT/MIRRORED_REPEAT 才视为已声明平铺)。
 * 覆盖 5 个核心纹理槽 + 已知材质扩展纹理槽;KHR_texture_transform 的集合编号经
 * TextureInfo.getTexCoord() 计入(v4 实现含该扩展的 texCoord 覆盖)。
 */
function materialUvContext(material: Material | null): MaterialUvContext {
  if (!material) return { requiredChannels: [], wrappingDeclared: {} };
  const required = new Set<string>();
  const wrapping = new Map<string, boolean>();
  const slots: Array<[TextureInfo | null]> = [
    [material.getBaseColorTextureInfo()],
    [material.getNormalTextureInfo()],
    [material.getMetallicRoughnessTextureInfo()],
    [material.getEmissiveTextureInfo()],
    [material.getOcclusionTextureInfo()],
    ...material.listExtensions().flatMap((extension) => extensionTextureSlots(extension)),
  ];
  for (const [info] of slots) {
    if (!info) continue;
    const channel = `TEXCOORD_${info.getTexCoord()}`;
    required.add(channel);
    const declaredU = isWrapping(info.getWrapS());
    const declaredV = isWrapping(info.getWrapT());
    wrapping.set(channel, (wrapping.get(channel) ?? true) && declaredU && declaredV);
  }
  const wrappingDeclared: Record<string, boolean> = {};
  for (const [channel, declared] of wrapping) wrappingDeclared[channel] = declared;
  return { requiredChannels: [...required].sort(), wrappingDeclared };
}

function isWrapping(mode: number): boolean {
  return mode === WRAP_REPEAT || mode === WRAP_MIRRORED_REPEAT;
}

/** 结构化读取已知材质扩展的纹理槽(避免 import 全部扩展类型;getter 缺失时跳过)。 */
function extensionTextureSlots(extension: unknown): Array<[TextureInfo | null]> {
  const slots: Array<[TextureInfo | null]> = [];
  if (!extension) return slots;
  const infoGetters = [
    "getClearcoatTextureInfo",
    "getClearcoatRoughnessTextureInfo",
    "getSheenColorTextureInfo",
    "getSheenRoughnessTextureInfo",
    "getTransmissionTextureInfo",
    "getSpecularTextureInfo",
    "getThicknessTextureInfo",
    "getIridescenceTextureInfo",
    "getIridescenceThicknessTextureInfo",
    "getAnisotropyTextureInfo",
  ];
  const source = extension as Record<string, unknown>;
  for (const infoGetter of infoGetters) {
    const getInfo = source[infoGetter];
    if (typeof getInfo !== "function") continue;
    const info = (getInfo as () => unknown).call(extension);
    if (info) slots.push([info as TextureInfo]);
  }
  return slots;
}

function sequence(count: number): Uint32Array {
  const out = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) out[index] = index;
  return out;
}

function uvIssue(code: UvIssueCode, primitiveId: string, count: number, samples: string[], detail?: string): UvIssue {
  const descriptor = UV_ISSUE_DICTIONARY[code];
  return { code, severity: descriptor.severity, primitiveId, count, samples, ...(detail ? { detail } : {}) };
}

function sortIssues(issues: UvIssue[]): UvIssue[] {
  return [...issues].sort((left, right) =>
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
    || left.code.localeCompare(right.code)
    || left.primitiveId.localeCompare(right.primitiveId));
}

function countByCode(issues: UvIssue[]): Partial<Record<UvIssueCode, number>> {
  const counts: Partial<Record<UvIssueCode, number>> = {};
  for (const entry in issues) {
    const issue = issues[Number(entry)]!;
    counts[issue.code] = (counts[issue.code] ?? 0) + issue.count;
  }
  return counts;
}

function toFloat32(values: ArrayLike<number>): Float32Array {
  return values instanceof Float32Array ? values : Float32Array.from(values);
}

let glbIoPromise: Promise<NodeIO> | undefined;

async function glbIo(): Promise<NodeIO> {
  glbIoPromise ??= draco3d.createDecoderModule().then((decoder) => new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "draco3d.decoder": decoder, "meshopt.decoder": MeshoptDecoder }));
  return glbIoPromise;
}
