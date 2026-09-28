/**
 * T05 验收切片：CPU 可见性参考集合（逐实例精确视锥 + 精确遮挡）。
 * 与引擎保守剔除链（GPU_FRUSTUM_CULL_WGSL / HI_Z_OCCLUSION_WGSL 的官方 CPU 孪生）对拍：
 * 断言「参考可见集 ⊆ 引擎保留集」（零错误漏剔——参考判可见的实例绝不允许被剔除）；
 * 引擎多保留（参考判不可见但引擎保留）按条计数报告，属保守可接受。
 *
 * 精确口径：参考不做球体/包围盒过近似——逐三角形齐次空间 Sutherland-Hodgman 视锥裁剪；
 * 遮挡真值用 softRasterizeReference（确定性像素中心采样）对参考不透明集合光栅出深度，
 * 再对候选实例逐像素严格 z-test（平局不取胜：自遮挡与共深邻居都不产生假可见）。
 * 深度约定：reversedZ=false 时 ndc.z 小=近；reversedZ=true 时内部翻转为 1-ndc.z 后
 * 统一走「小=近」的确定性光栅化合同（softRasterizeReference 深度语义不变）。
 */

import { createSoftRasterTarget, rasterizeTriangle, type SoftRasterTarget } from "./softRasterizeReference.js";

/** 实例试图：16 列主序（RenderPacket transform 合同），world = M·p。 */
export type Transform = ArrayLike<number>;

export interface ReferenceInstance {
  readonly transform: Transform;
  /** false = 透明（BLEND 语义不写遮挡深度），默认 true。MASK 仍写深度，按 opaque 传入。 */
  readonly opaque?: boolean;
}

export interface ReferenceGeometry {
  /** 交错 6 浮点（position+normal，MeshData 合同）。 */
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
}

export interface ReferenceView {
  /** 16 列主序 viewProjection；clip = VP·(world,1)，与 projectHiZOcclusionAabb 同一约定。 */
  readonly viewProjection: ArrayLike<number>;
  readonly viewport: readonly [number, number];
  /** true = reversedZ 视图（ndc.z 大=近）；参考内部翻转后统一处理。 */
  readonly reversedZ?: boolean;
}

export interface ReferenceVisibility {
  /** 精确视锥可见（任一三角形与视锥相交）。 */
  readonly frustumVisible: Uint8Array;
  /** 精确遮挡判定后可见（≥1 像素严格 z-test 胜出）。 */
  readonly depthVisible: Uint8Array;
  /** 最终参考可见集 = frustumVisible ∧ depthVisible。 */
  readonly visible: Uint8Array;
  /** 每实例可见像素数（诊断）。 */
  readonly visiblePixels: Uint32Array;
  /** 参考遮挡深度（原始 ndc.z 约定，未翻转；喂 buildDepthPyramid）。 */
  readonly depth: Float32Array;
  readonly width: number;
  readonly height: number;
}

export interface VisibilityComparison {
  /** 参考可见但引擎剔除 → 硬错误，必须为空（零错误漏剔）。 */
  readonly wrongCulled: readonly number[];
  /** 参考不可见但引擎保留 → 保守可接受，逐条计数报告。 */
  readonly conservativeKept: readonly number[];
  readonly referenceVisible: number;
  readonly engineKept: number;
}

type Vec3 = readonly [number, number, number];
type Clip4 = [number, number, number, number];

/** 列主序 4×4 矩阵乘：a·b。 */
export function multiplyMatrix(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[column * 4 + k]!;
    out[column * 4 + row] = sum;
  }
  return out;
}

/** 标准 WebGPU 深度 [0,1]（near=0）透视投影，列主序；fovY 弧度。 */
export function perspectiveProjection(fovY: number, aspect: number, near: number, far: number): Float64Array {
  const f = 1 / Math.tan(fovY / 2);
  return new Float64Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, near * far / (near - far), 0]);
}

/** lookAt 视图矩阵（列主序，世界→视图，视图 -z 朝前）。 */
export function lookAtView(eye: readonly [number, number, number], target: readonly [number, number, number],
  up: readonly [number, number, number]): Float64Array {
  const sub = (a: readonly number[], b: readonly number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!] as const;
  const normalize = (v: readonly number[]) => {
    const length = Math.hypot(v[0]!, v[1]!, v[2]!);
    if (!(length > 0)) throw new Error("lookAtView vectors must be nonzero.");
    return [v[0]! / length, v[1]! / length, v[2]! / length] as const;
  };
  const cross = (a: readonly number[], b: readonly number[]) =>
    [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!] as const;
  const forward = normalize(sub(target, eye));
  const right = normalize(cross(forward, up));
  const trueUp = cross(right, forward);
  const dot3 = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  return new Float64Array([right[0], trueUp[0], -forward[0], 0, right[1], trueUp[1], -forward[1], 0,
    right[2], trueUp[2], -forward[2], 0, -dot3(right, eye), -dot3(trueUp, eye), dot3(forward, eye), 1]);
};

function toClip(point: Vec3, viewProjection: ArrayLike<number>): Clip4 {
  return [
    viewProjection[0]! * point[0]! + viewProjection[4]! * point[1]! + viewProjection[8]! * point[2]! + viewProjection[12]!,
    viewProjection[1]! * point[0]! + viewProjection[5]! * point[1]! + viewProjection[9]! * point[2]! + viewProjection[13]!,
    viewProjection[2]! * point[0]! + viewProjection[6]! * point[1]! + viewProjection[10]! * point[2]! + viewProjection[14]!,
    viewProjection[3]! * point[0]! + viewProjection[7]! * point[1]! + viewProjection[11]! * point[2]! + viewProjection[15]!];
}

/** 视锥 = 裁剪空间六个半空间（w±x、w±y、z、w−z），与 viewProjectionFrustum 世界平面等价。 */
const CLIP_PLANES: ReadonlyArray<readonly [number, number, number, number]> = [
  [1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1], [0, -1, 0, 1], [0, 0, 1, 0], [0, 0, -1, 1]];

/** 齐次空间 Sutherland-Hodgman；返回 NDC 多边形（近平面裁剪保证 w>0），空 = 完全视锥外。 */
export function clipTriangleToNdc(triangle: readonly Vec3[], viewProjection: ArrayLike<number>): Vec3[] {
  let polygon: Clip4[] = triangle.map(point => toClip(point, viewProjection));
  for (const plane of CLIP_PLANES) {
    if (polygon.length === 0) return [];
    const distances = polygon.map(clip => plane[0]! * clip[0]! + plane[1]! * clip[1]! + plane[2]! * clip[2]! + plane[3]! * clip[3]!);
    const next: Clip4[] = [];
    for (let index = 0; index < polygon.length; index++) {
      const current = polygon[index]!, currentDistance = distances[index]!;
      const nextIndex = (index + 1) % polygon.length, nextVertex = polygon[nextIndex]!;
      const nextDistance = distances[nextIndex]!;
      if (currentDistance >= 0) next.push([...current] as Clip4);
      if ((currentDistance >= 0) !== (nextDistance >= 0)) {
        const t = currentDistance / (currentDistance - nextDistance);
        next.push([current[0]! + (nextVertex[0]! - current[0]!) * t, current[1]! + (nextVertex[1]! - current[1]!) * t,
          current[2]! + (nextVertex[2]! - current[2]!) * t, current[3]! + (nextVertex[3]! - current[3]!) * t]);
      }
    }
    polygon = next;
  }
  return polygon.map(clip => [clip[0]! / clip[3]!, clip[1]! / clip[3]!, clip[2]! / clip[3]!] as const);
}

function toWorldTriangle(instance: ReferenceInstance, geometry: ReferenceGeometry, triangle: number): Vec3[] {
  const m = instance.transform;
  return [0, 1, 2].map(corner => {
    const vertex = geometry.indices[triangle * 3 + corner]! * 6;
    const x = geometry.vertices[vertex]!, y = geometry.vertices[vertex + 1]!, z = geometry.vertices[vertex + 2]!;
    return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
      m[2]! * x + m[6]! * y + m[10]! * z + m[14]!] as const;
  });
}

function rasterizePolygon(target: SoftRasterTarget, polygon: readonly Vec3[], slot: number, reversedZ: boolean,
  depthBias = 0): void {
  for (let fan = 1; fan + 1 < polygon.length; fan++) {
    const corners = [polygon[0]!, polygon[fan]!, polygon[fan + 1]!].map(point => [
      (point[0]! * 0.5 + 0.5) * target.width - 0.5, (0.5 - point[1]! * 0.5) * target.height - 0.5,
      (reversedZ ? 1 - point[2]! : point[2]!) - depthBias] as const);
    // 绕序无关：镜像实例与窗口 y 翻转都会翻转朝向。rasterizeTriangle 的 edge 函数
    // = 本式取负，故按本式 area>0 翻转使写入面积恒正。
    const area = (corners[1]![0]! - corners[0]![0]!) * (corners[2]![1]! - corners[0]![1]!)
      - (corners[1]![1]! - corners[0]![1]!) * (corners[2]![0]! - corners[0]![0]!);
    const order = area > 0 ? [0, 2, 1] : [0, 1, 2];
    const a = corners[order[0]!]!, b = corners[order[1]!]!, c = corners[order[2]!]!;
    rasterizeTriangle(target, { ax: a[0]!, ay: a[1]!, az: a[2]!, bx: b[0]!, by: b[1]!, bz: b[2]!,
      cx: c[0]!, cy: c[1]!, cz: c[2]!, slot, triangleLocalIndex: 0 });
  }
}

/** 构建参考可见集（冻结视图、静态场景）。多边形 NDC → 窗口换算含透视除法已完成的前提。 */
export function buildInstanceVisibilityReference(geometry: ReferenceGeometry, instances: readonly ReferenceInstance[],
  view: ReferenceView): ReferenceVisibility {
  const [width, height] = view.viewport;
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new RangeError("Reference viewport must be positive integers.");
  }
  const reversedZ = view.reversedZ === true;
  const frustumVisible = new Uint8Array(instances.length);
  const polygons: Vec3[][][] = instances.map(() => []);
  for (const [index, instance] of instances.entries()) {
    for (let triangle = 0; triangle < geometry.indices.length / 3; triangle++) {
      const clipped = clipTriangleToNdc(toWorldTriangle(instance, geometry, triangle), view.viewProjection);
      if (clipped.length > 0) { frustumVisible[index] = 1; polygons[index]!.push(clipped); }
    }
  }
  // 遮挡深度：全部参考不透明且视锥可见实例；透明（BLEND 语义）不写深度。
  const depth = createSoftRasterTarget(width, height);
  for (const [index, instance] of instances.entries()) {
    if (!frustumVisible[index] || instance.opaque === false) continue;
    for (const polygon of polygons[index]!) rasterizePolygon(depth, polygon, 0, reversedZ);
  }
  const depthVisible = new Uint8Array(instances.length);
  const visiblePixels = new Uint32Array(instances.length);
  // 探针深度带 1e-6 松弛：平局（共面/自身）按可见计——参考口径略松使「⊆ 引擎保留集」更严。
  const tieEpsilon = 1e-6;
  for (const [index] of instances.entries()) {
    if (!frustumVisible[index]) continue;
    const probe = createSoftRasterTarget(width, height);
    probe.depth.set(depth.depth);
    for (const polygon of polygons[index]!) rasterizePolygon(probe, polygon, 1, reversedZ, tieEpsilon);
    const written = probe.slot.reduce((sum, slot) => sum + (slot === 1 ? 1 : 0), 0);
    visiblePixels[index] = written;
    depthVisible[index] = written > 0 ? 1 : 0;
  }
  const visible = new Uint8Array(instances.length);
  let count = 0;
  for (let index = 0; index < instances.length; index++) {
    visible[index] = frustumVisible[index]! && depthVisible[index]! ? 1 : 0;
    count += visible[index]!;
  }
  return { frustumVisible, depthVisible, visible, visiblePixels, depth: depth.depth, width, height };
}

/** 对比参考可见集与引擎保留集。 */
export function compareInstanceVisibility(reference: ReferenceVisibility,
  engineKept: ReadonlyArray<boolean> | Uint8Array): VisibilityComparison {
  const wrongCulled: number[] = [], conservativeKept: number[] = [];
  let engineCount = 0, referenceCount = 0;
  for (let index = 0; index < reference.visible.length; index++) {
    const kept = Boolean(engineKept[index]);
    if (kept) engineCount++;
    if (reference.visible[index]) {
      referenceCount++;
      if (!kept) wrongCulled.push(index);
    } else if (kept) conservativeKept.push(index);
  }
  return { wrongCulled, conservativeKept, referenceVisible: referenceCount, engineKept: engineCount };
}
