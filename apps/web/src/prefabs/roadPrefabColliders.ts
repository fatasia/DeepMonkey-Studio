import type { IndustrialPrefabInstanceState, Vector3Value } from "@bim-studio/contracts";
import { linearPrefabSegments } from "./linearPrefabPath";
import { ROAD_CARRIAGEWAY_TOP_M, straightRoadShape } from "./parametricRoadGeometry";

/** 作者未显式配置碰撞厚度时的缺省值：顶面对齐路面顶时向下嵌入 8cm，保证路缘不悬空。 */
export const DEFAULT_ROAD_COLLIDER_THICKNESS_M = 0.16;

/** 单段道路碰撞体：轴对齐半尺寸 + 绕 y 偏航角，坐标系与铺设路径（代理局部）一致。 */
export interface RoadPrefabSegmentCollider {
  readonly center: Vector3Value;
  readonly halfExtents: Vector3Value;
  readonly yawRadians: number;
}

/**
 * I3 道路碰撞体：复用 linearPrefabSegments 分段数据，每段一个 cuboid 描述，
 * 供查看器物理链创建固定碰撞体；弯道不再被整路包围盒虚包大片空气。
 * 宽度取道路全铺装宽度（车行道 + 双路肩），顶面恒对齐车行道路面顶，
 * 厚度取作者 colliderThicknessM 参数或缺省值（对齐既有 fail-bounded 参数口径）。
 * 非道路、无铺设路径或路径非法（linearPrefabSegments fail-closed 抛错）时不上抛——
 * 前两者返回空表交由调用方回退整包围盒路径，后者如实抛出保持与几何生成一致的拒绝语义。
 */
export function roadPrefabSegmentColliders(state: IndustrialPrefabInstanceState | undefined): readonly RoadPrefabSegmentCollider[] {
  const path = state?.placementPath;
  if (!path || state.kind !== "road") return [];
  const shape = straightRoadShape(state.parameters);
  const widthM = shape.carriagewayWidthM + 2 * shape.shoulderWidthM;
  const thicknessM = shape.colliderThicknessM ?? DEFAULT_ROAD_COLLIDER_THICKNESS_M;
  return Object.freeze(linearPrefabSegments(path).map(segment => Object.freeze({
    center: Object.freeze({
      x: segment.midpoint.x,
      // 碰撞体顶面与车行道路面顶（路径点 y + 0.08）平齐，向下按厚度延伸。
      y: segment.midpoint.y + ROAD_CARRIAGEWAY_TOP_M - thicknessM / 2,
      z: segment.midpoint.z,
    }),
    halfExtents: Object.freeze({ x: segment.lengthM / 2, y: thicknessM / 2, z: widthM / 2 }),
    // linearPrefabGeometry 的分段子对象用 rotation.y = -yaw 摆放，碰撞体保持同一旋向。
    yawRadians: segment.yawRadians,
  })));
}
