/**
 * B4/HLOD GPU 绘制整合:活动簇代理的**合批绘制计划**(纯 CPU,可单测)。
 *
 * 现状缺口(先读后写,2026-09-29):流送路径(authorChunkStream.applyClusterPlan)里
 * 每个活动代理 = 独立 overlay 块(`hlod-cluster:<id>`)+ 独立批 + 独立 draw;
 * T00 车间 10k 远档 242 个折叠簇 → 242 draw、242 份逐代理几何上传、每应用帧
 * 144B×N 批数据重铺。本模块把同一份 `HlodClusterFramePlan.activeProxyDraws`
 * 压成一个**实例化 draw**:单一单元盒几何 + 每代理一行 4x4 仿射
 * (`T_draw · M_box`,几何等价于逐代理绘制,f32 舍入内)。
 *
 * 合批 vs indirect draw 的取舍(实测口径见 batchBench):CPU 决策层
 * (decideHlodFrame)已把代理集合塌缩到 ≤千级;两者 draw 数同为 1,而 indirect
 * 还需剔除 dispatch + args buffer + 读回同步,本切片选合批为实测更优。
 * 逐 pass 计时身份:`hlodProxyTimedPass.ts`(hlod-proxy 暂缓登记;渲染侧 pass 落地时
 * 按其文件头的原子 diff 追加清单 + J4 能力行声明)。
 *
 * 诚实边界:本模块是绘制计划层(几何/矩阵/字节账目/脏行 delta),不触碰
 * authorChunkStream / PbrRenderer 传输(他人在途域);真机 GPU 帧时 unmeasured,
 * 联测清单见 `hlodClusterStream.batchBench.test.ts` 证据与切片报告。
 * 层级纪律(runtime purity):本模块不**值导入** threeBridge——代理 overlay 材质合同
 * `HLOD_PROXY_MATERIAL_ID` 由调用方注入(构造参数),批签名由活动集+原点+抑制态
 * 本地派生;跨层等价性(contract pin)由 threeBridge 侧的 batchBench 测试钉住。
 */

import type { GeometryResource } from "../renderPacket.js";
import type { HlodClusterFramePlan } from "../threeBridge/hlodClusterStream.js";

/** 合批专用的共享单元盒几何 id;几何中心在原点、半边长 0.5(实例矩阵承载盒尺度)。 */
export const HLOD_PROXY_UNIT_GEOMETRY_ID = "hlod-proxy-unit-box";
/** 每实例矩阵行浮点数(列主序 4x4 仿射,与 RenderInstance.transform 同约定)。 */
export const HLOD_PROXY_BATCH_STRIDE_FLOATS = 16;
/** 逐代理路径的批数据行浮点数(既有批合同:36 float/实例,见 authorChunkStream 行置零补偿)。 */
export const PER_PROXY_BATCH_ROW_FLOATS = 36;
/** 逐代理路径每次应用帧重铺的批数据字节(36 float × 4B)。 */
export const PER_PROXY_BATCH_ROW_BYTES = PER_PROXY_BATCH_ROW_FLOATS * 4;

/** 盒在几何空间的中心与半边长;实例矩阵 = T_draw · [diag(2×half), center](全边长缩放)。 */
export interface HlodProxyBoxExtents {
  readonly center: readonly [number, number, number];
  readonly half: readonly [number, number, number];
}

/**
 * 单元盒几何:24 顶点(stride-6 位置+外法线)+ 36 索引,角点 ±0.5,
 * 每面从外看 CCW(与 hlod/hlodProxyGeometry.emitBoxMesh、packetBoundsHlod 同约定)。
 */
export function hlodProxyUnitBoxGeometry(): GeometryResource {
  const vertices = new Float32Array(24 * 6);
  const indices = new Uint32Array(36);
  const corners: readonly [number, number, number][] = [
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
  ];
  // 六面:法线、四角按从外看 CCW 排列(与 emitBoxMesh 面序一致)。
  const faces: readonly { readonly normal: readonly [number, number, number];
    readonly quad: readonly [number, number, number, number] }[] = [
    { normal: [1, 0, 0], quad: [1, 2, 6, 5] }, { normal: [-1, 0, 0], quad: [0, 4, 7, 3] },
    { normal: [0, 1, 0], quad: [3, 7, 6, 2] }, { normal: [0, -1, 0], quad: [0, 1, 5, 4] },
    { normal: [0, 0, 1], quad: [4, 5, 6, 7] }, { normal: [0, 0, -1], quad: [0, 3, 2, 1] },
  ];
  faces.forEach((face, faceIndex) => {
    const base = faceIndex * 4;
    for (let corner = 0; corner < 4; corner++) {
      const offset = (base + corner) * 6;
      const point = corners[face.quad[corner]!]!;
      vertices[offset] = point[0]; vertices[offset + 1] = point[1]; vertices[offset + 2] = point[2];
      vertices[offset + 3] = face.normal[0]; vertices[offset + 4] = face.normal[1]; vertices[offset + 5] = face.normal[2];
    }
    const indexBase = faceIndex * 6;
    indices[indexBase] = base; indices[indexBase + 1] = base + 1; indices[indexBase + 2] = base + 2;
    indices[indexBase + 3] = base; indices[indexBase + 4] = base + 2; indices[indexBase + 5] = base + 3;
  });
  return { id: HLOD_PROXY_UNIT_GEOMETRY_ID, revision: 0, vertices, indices };
}

/** 从 stride-6 代理网格提取盒中心/半边长(位置分量 min/max);无效几何 fail-closed。 */
export function hlodProxyBoxExtents(geometry: GeometryResource): HlodProxyBoxExtents {
  const vertices = geometry.vertices;
  if (vertices.length === 0 || vertices.length % 6 !== 0) {
    throw new Error(`HLOD proxy geometry ${geometry.id} vertices must be non-empty stride-6.`);
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < vertices.length; offset += 6) {
    for (let axis = 0; axis < 3; axis++) {
      const value = vertices[offset + axis]!;
      if (!Number.isFinite(value)) throw new Error(`HLOD proxy geometry ${geometry.id} has non-finite position.`);
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }
  const center: [number, number, number] = [
    (min[0]! + max[0]!) * 0.5, (min[1]! + max[1]!) * 0.5, (min[2]! + max[2]!) * 0.5];
  const half: [number, number, number] = [
    (max[0]! - min[0]!) * 0.5, (max[1]! - min[1]!) * 0.5, (max[2]! - min[2]!) * 0.5];
  return { center, half };
}

/** 列主序 4x4 仿射乘积 A·B(两者均为 16 float 列主序仿射)。 */
export function composeAffineColumnMajor(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[column * 4 + k]!;
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/** 实例矩阵 = T_draw · M_box:M_box 把 ±0.5 单元盒映到代理盒(缩放全边长 2×half、平移中心)。 */
export function composeProxyInstanceMatrix(transform: ArrayLike<number>,
  extents: HlodProxyBoxExtents): Float32Array {
  if (transform.length !== 16 || Array.from(transform).some(value => !Number.isFinite(value))) {
    throw new Error("HLOD proxy instance transform must be a finite column-major 4x4.");
  }
  const span: readonly [number, number, number] = [extents.half[0]! * 2, extents.half[1]! * 2,
    extents.half[2]! * 2];
  const boxMatrix = new Float32Array([
    span[0], 0, 0, 0,
    0, span[1], 0, 0,
    0, 0, span[2], 0,
    extents.center[0]!, extents.center[1]!, extents.center[2]!, 1,
  ]);
  return composeAffineColumnMajor(transform, boxMatrix);
}

/** 一次合批重建的输出:行序 = instanceIds 升序;changedRows 是相对上帧的脏行下标。 */
export interface HlodProxyBatchPlan {
  /** 批层指纹:活动代理集 + 局部化原点 + 抑制态(与决策层签名分层,本地派生)。 */
  readonly signature: string;
  readonly geometryId: string;
  readonly materialId: string;
  readonly instanceIds: readonly string[];
  readonly matrices: Float32Array;
  readonly instanceCount: number;
}

export interface HlodProxyBatchUpdate {
  readonly plan: HlodProxyBatchPlan;
  /** true = 活动集或签名变化导致全量重编;false = 活动集未变(脏行仍可能来自集合外变化)。 */
  readonly fullRebuild: boolean;
  /** 相对上帧发生变化的行下标(升序);no-op 为空。 */
  readonly changedRows: readonly number[];
}

/** 合批器选项:材质 id 是 threeBridge 的 overlay 合同(纯净化层级不值导入,调用方注入)。 */
export interface HlodProxyBatcherOptions {
  /** 代理 overlay 材质 id(threeBridge 合同值,如 HLOD_PROXY_MATERIAL_ID)。 */
  readonly materialId: string;
  /** 缺省为共享单元盒几何 id。 */
  readonly unitGeometryId?: string;
}

/**
 * 合批器:持上一帧计划,逐帧只重编变化的实例行。
 * 几何 id 是内容寻址(T26 合同),同 id 的 revision 变化视为包漂移 fail-closed。
 */
export class HlodProxyDrawBatcher {
  private readonly extentsByGeometry = new Map<string, { readonly extents: HlodProxyBoxExtents;
    readonly revision: number }>();
  private previous: HlodProxyBatchPlan | undefined;

  constructor(private readonly options: HlodProxyBatcherOptions) {
    if (!options || typeof options.materialId !== "string" || options.materialId.length === 0) {
      throw new TypeError("HLOD proxy batcher requires a non-empty overlay materialId.");
    }
  }

  /** 已缓存的盒几何数(测试可观测缓存复用)。 */
  get cachedGeometryCount(): number { return this.extentsByGeometry.size; }

  update(plan: HlodClusterFramePlan, geometries: ReadonlyMap<string, GeometryResource>): HlodProxyBatchUpdate {
    // 批层指纹只取绘制相关面:隐藏集/迟滞不影响代理批内容,不进签名。
    const signature = `b${plan.suppressed ? 1 : 0}|${plan.origin.join(",")}|`
      + [...plan.activeProxyDraws.keys()].sort().join(",");
    const instanceIds = [...plan.activeProxyDraws.keys()].sort();
    const matrices = new Float32Array(instanceIds.length * HLOD_PROXY_BATCH_STRIDE_FLOATS);
    for (let index = 0; index < instanceIds.length; index++) {
      const draw = plan.activeProxyDraws.get(instanceIds[index]!)!;
      let cached = this.extentsByGeometry.get(draw.geometryId);
      if (!cached) {
        const geometry = geometries.get(draw.geometryId);
        if (!geometry) throw new Error(`HLOD proxy geometry is not distributed in the packet: ${draw.geometryId}`);
        cached = { extents: hlodProxyBoxExtents(geometry), revision: geometry.revision };
        this.extentsByGeometry.set(draw.geometryId, cached);
      } else {
        // 几何 id 是内容寻址(T26 合同):同 id 的 revision 变化 = 包漂移,fail-closed。
        const geometry = geometries.get(draw.geometryId);
        if (geometry && geometry.revision !== cached.revision) {
          throw new Error(`HLOD proxy geometry ${draw.geometryId} revision drifted `
            + `(${cached.revision} -> ${geometry.revision}); content-addressed ids must not mutate.`);
        }
      }
      matrices.set(composeProxyInstanceMatrix(draw.transform, cached.extents),
        index * HLOD_PROXY_BATCH_STRIDE_FLOATS);
    }
    const next: HlodProxyBatchPlan = { signature, geometryId: this.options.unitGeometryId
        ?? HLOD_PROXY_UNIT_GEOMETRY_ID,
      materialId: this.options.materialId, instanceIds, matrices, instanceCount: instanceIds.length };
    const previous = this.previous;
    this.previous = next;
    if (!previous || previous.signature !== signature) {
      return { plan: next, fullRebuild: true,
        changedRows: instanceIds.map((_, index) => index) };
    }
    // 活动集不变:逐行 16 float 精确比对(同变换逐位相同 ⇒ 零脏行)。
    const changedRows: number[] = [];
    for (let index = 0; index < instanceIds.length; index++) {
      const base = index * HLOD_PROXY_BATCH_STRIDE_FLOATS;
      for (let f = 0; f < HLOD_PROXY_BATCH_STRIDE_FLOATS; f++) {
        if (previous.matrices[base + f] !== next.matrices[base + f]) { changedRows.push(index); break; }
      }
    }
    return { plan: next, fullRebuild: false, changedRows };
  }
}

/**
 * 绘制账目(同一决策计划的两种绘制路径;字节按既有管道合同计,可证伪):
 * - 逐代理(现状):N 块 ×(几何上传 + 144B 批行),N draw,每应用帧 144N 批重铺;
 * - 合批(本模块):单元盒几何一次 + 64B×N 实例行,1 draw,脏行 delta 上传。
 */
export interface HlodProxyDrawCost {
  readonly activeProxyCount: number;
  readonly perProxyDraws: number;
  readonly batchedDraws: number;
  /** 逐代理首次激活上传 = Σ(几何字节 + 144B 批行)。 */
  readonly perProxyActivationBytes: number;
  /** 合批首次激活上传 = 单元盒几何字节 + 64B×N 实例行。 */
  readonly batchedActivationBytes: number;
  /** 稳态相机帧(活动集与原点不变):逐代理 144N vs 合批 0。 */
  readonly perProxySteadyFrameBytes: number;
  readonly batchedSteadyFrameBytes: number;
  /** 全量重编帧:逐代理 144N vs 合批 64N。 */
  readonly perProxyRebuildBytes: number;
  readonly batchedRebuildBytes: number;
  /** 局部集合变化帧:合批只传脏行 64×Δ;逐代理合同要求全量 N 行重铺。 */
  readonly perProxyDeltaFrameBytes: number;
  readonly batchedDeltaFrameBytes: number;
  /** draw 数削减率(N=0 时 null)。 */
  readonly drawReduction: number | null;
}

export function hlodProxyDrawCost(activeProxyCount: number, proxyGeometryBytes: number,
  changedRowCount: number = activeProxyCount): HlodProxyDrawCost {
  if (!Number.isInteger(activeProxyCount) || activeProxyCount < 0 || !Number.isFinite(proxyGeometryBytes)
    || proxyGeometryBytes < 0 || !Number.isInteger(changedRowCount) || changedRowCount < 0
    || changedRowCount > activeProxyCount) {
    throw new TypeError("HLOD proxy draw cost inputs must be non-negative integers with changedRowCount ≤ count "
      + "and a finite byte size.");
  }
  const perProxyActivation = activeProxyCount * (proxyGeometryBytes + PER_PROXY_BATCH_ROW_BYTES);
  // 单元盒几何字节 = 24 顶点 × 6 float × 4B + 36 索引 × 4B = 720B(几何合同,常量)。
  const unitGeometryBytes = 24 * 6 * 4 + 36 * 4;
  const batchedActivation = unitGeometryBytes + activeProxyCount * HLOD_PROXY_BATCH_STRIDE_FLOATS * 4;
  return { activeProxyCount,
    perProxyDraws: activeProxyCount, batchedDraws: activeProxyCount === 0 ? 0 : 1,
    perProxyActivationBytes: perProxyActivation, batchedActivationBytes: batchedActivation,
    perProxySteadyFrameBytes: activeProxyCount * PER_PROXY_BATCH_ROW_BYTES,
    batchedSteadyFrameBytes: 0,
    perProxyRebuildBytes: activeProxyCount * PER_PROXY_BATCH_ROW_BYTES,
    batchedRebuildBytes: activeProxyCount * HLOD_PROXY_BATCH_STRIDE_FLOATS * 4,
    perProxyDeltaFrameBytes: activeProxyCount * PER_PROXY_BATCH_ROW_BYTES,
    batchedDeltaFrameBytes: changedRowCount * HLOD_PROXY_BATCH_STRIDE_FLOATS * 4,
    drawReduction: activeProxyCount === 0 ? null : 1 - 1 / activeProxyCount };
}

/** 合批计划 → RenderInstance 行(共享单元盒几何);供既有实例管道(非流送路径)消费。 */
export function hlodProxyBatchInstances(plan: HlodProxyBatchPlan): { id: string; geometry: string;
  material: string; transform: Float32Array }[] {
  const rows: { id: string; geometry: string; material: string; transform: Float32Array }[] = [];
  for (let index = 0; index < plan.instanceIds.length; index++) {
    rows.push({ id: plan.instanceIds[index]!, geometry: plan.geometryId, material: plan.materialId,
      transform: plan.matrices.slice(index * HLOD_PROXY_BATCH_STRIDE_FLOATS,
        (index + 1) * HLOD_PROXY_BATCH_STRIDE_FLOATS) });
  }
  return rows;
}
