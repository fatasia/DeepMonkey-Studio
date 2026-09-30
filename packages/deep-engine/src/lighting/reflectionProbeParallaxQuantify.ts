import type { ProbeVector3 } from "./probeClipmapPlan.js";
import { reflectionProbeBoxProjectCpu } from "./reflectionProbeParallaxMath.js";
import { DEEP_REFLECTION_PROBE_DIRECTION_EPSILON, DEEP_REFLECTION_PROBE_UNCONSTRAINED_STEP,
} from "./reflectionProbeBoxProjectionWgsl.js";

/**
 * C15 反射探针盒投影——平面(现状) vs 盒投影的量化规范。
 *
 * 真值构造:反射射线与影响体 AABB 求交得参考命中点(盒投影的构造性成立域);
 * 内容点缺省取命中点(盒面上,盒误差应为 0),或沿射线指定距离(诚实对照"远处内容")。
 * 误差口径 = 采样方向(平面/盒)相对真值方向(内容点−探针中心)的角误差,
 * 像素位移 = 角误差 / 每像素弧度(默认 1080p、垂直 60°)。
 */

/** 量化默认视口:1080p、垂直 60°(radPerPx ≈ 9.69e-4)。 */
export const DEEP_REFLECTION_PARALLAX_DEFAULT_VIEWPORT = Object.freeze({
  width: 1920, height: 1080, verticalFovDegrees: 60,
});
export interface ReflectionParallaxViewport { readonly width: number; readonly height: number;
  readonly verticalFovDegrees: number }

export interface ReflectionParallaxCaseInput {
  readonly name: string;
  readonly probe: { center: ProbeVector3; halfExtents: ProbeVector3 };
  /** 接收点世界坐标。 */
  readonly worldPosition: ProbeVector3;
  /** 接收面法线(内部单位化)。 */
  readonly normal: ProbeVector3;
  /** 视线方向(表面→眼睛,内部单位化)。 */
  readonly viewDirection: ProbeVector3;
  /**
   * 被反射内容距离:缺省/null = 内容位于影响体 AABB 面上(盒投影的构造性成立域,
   * 盒误差应为 0);正数 = 内容沿反射射线该距离处(超出盒面的"远处内容"诚实对照)。
   */
  readonly contentDistance?: number | null;
}

export interface ReflectionParallaxCaseMetrics {
  readonly name: string;
  /** 平面(现状)采样方向的角误差(度)。 */
  readonly planarAngularErrorDeg: number;
  /** 盒投影采样方向的角误差(度);构造性用例 ≈ 0。 */
  readonly boxAngularErrorDeg: number;
  /** 默认视口下平面误差对应的反射内容像素位移。 */
  readonly planarPixelDisplacement: number;
  /** 默认视口下盒投影误差对应的反射内容像素位移。 */
  readonly boxPixelDisplacement: number;
  /** 改善倍数 = 平面角误差 / 盒角误差(盒为 0 时为 Infinity)。 */
  readonly improvementFactor: number;
  /** 内容是否在影响体 AABB 面上(构造性用例)。 */
  readonly constructive: boolean;
  readonly uncorrected: boolean;
}

export function measureReflectionParallaxCase(input: ReflectionParallaxCaseInput,
  viewport: ReflectionParallaxViewport = DEEP_REFLECTION_PARALLAX_DEFAULT_VIEWPORT):
  ReflectionParallaxCaseMetrics {
  const normal = normalize(input.normal);
  const view = normalize(input.viewDirection);
  const reflected = reflect(view, normal);
  const projected = reflectionProbeBoxProjectCpu(input.worldPosition, reflected, input.probe);
  const exit = rayBoxExitFromInside(sub(input.worldPosition, input.probe.center), reflected,
    input.probe.halfExtents);
  const constructive = input.contentDistance == null;
  const contentPoint = add(input.worldPosition,
    scale(reflected, constructive ? exit : input.contentDistance!));
  const truth = normalize(sub(contentPoint, input.probe.center));
  const radPerPx = viewport.verticalFovDegrees * Math.PI / 180 / viewport.height;
  const planarErrorDeg = angleDeg(reflected, truth);
  const boxErrorDeg = angleDeg(projected.direction, truth);
  return Object.freeze({
    name: input.name,
    planarAngularErrorDeg: planarErrorDeg,
    boxAngularErrorDeg: boxErrorDeg,
    planarPixelDisplacement: planarErrorDeg * Math.PI / 180 / radPerPx,
    boxPixelDisplacement: boxErrorDeg * Math.PI / 180 / radPerPx,
    improvementFactor: boxErrorDeg > 0 ? planarErrorDeg / boxErrorDeg
      : planarErrorDeg > 0 ? Infinity : 1,
    constructive, uncorrected: !projected.corrected,
  });
}

/**
 * 房间扫掠用例族:接收点沿轴从探针中心(视差完美)推向 +轴墙面,地板朝上、固定视线;
 * 每档产出平面 vs 盒投影对照。供测试与 GPU 探针共享。
 */
export function roomParallaxCases(room: { center: ProbeVector3; halfExtents: ProbeVector3 },
  offsets: readonly number[], options?: { readonly normal?: ProbeVector3;
    readonly viewDirection?: ProbeVector3; readonly contentDistance?: number | null;
    readonly axis?: 0 | 1 | 2 }): ReflectionParallaxCaseInput[] {
  const axis = options?.axis ?? 0;
  return offsets.map(offset => {
    const position: [number, number, number] = [0, 0, 0];
    position[axis] = offset;
    return {
      name: `room-offset-${offset.toFixed(2)}`,
      probe: room,
      worldPosition: position,
      normal: options?.normal ?? [0, 1, 0],
      viewDirection: options?.viewDirection ?? [0.2, 0.6, 0.8],
      ...(options?.contentDistance === undefined ? {} : { contentDistance: options.contentDistance }),
    };
  });
}

function sub(a: ProbeVector3, b: ProbeVector3): ProbeVector3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add(a: ProbeVector3, b: ProbeVector3): ProbeVector3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a: ProbeVector3, factor: number): ProbeVector3 {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}
function normalize(a: ProbeVector3): ProbeVector3 {
  const length = Math.hypot(...a);
  return length > 0 ? [a[0] / length, a[1] / length, a[2] / length] : [0, 0, 0];
}
/** 反射:r = I − 2·dot(N,I)·N,I = −view(指向表面),展开为 2·dot(N,view)·N − view。 */
function reflect(view: ProbeVector3, normal: ProbeVector3): ProbeVector3 {
  const cosine = normal[0] * view[0] + normal[1] * view[1] + normal[2] * view[2];
  return [2 * cosine * normal[0] - view[0], 2 * cosine * normal[1] - view[1],
    2 * cosine * normal[2] - view[2]];
}
/** 盒内出发的射线与 AABB 的出射步长(与盒投影同判据;量化真值用,非校正路径)。 */
function rayBoxExitFromInside(relative: ProbeVector3, direction: ProbeVector3,
  halfExtents: ProbeVector3): number {
  let exit = DEEP_REFLECTION_PROBE_UNCONSTRAINED_STEP;
  for (let axis = 0; axis < 3; axis++) {
    if (!(Math.abs(direction[axis]!) >= DEEP_REFLECTION_PROBE_DIRECTION_EPSILON)) continue;
    const bound = direction[axis]! > 0 ? halfExtents[axis]! : -halfExtents[axis]!;
    exit = Math.min(exit, (bound - relative[axis]!) / direction[axis]!);
  }
  return exit;
}
function angleDeg(a: ProbeVector3, b: ProbeVector3): number {
  const cosine = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2])
    / Math.max(Math.hypot(...a) * Math.hypot(...b), 1e-300);
  return Math.acos(Math.min(1, Math.max(-1, cosine))) * 180 / Math.PI;
}
