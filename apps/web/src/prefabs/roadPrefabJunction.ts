import type { IndustrialPrefabInstanceState, Vector3Value } from "@bim-studio/contracts";
import { straightRoadShape } from "./parametricRoadGeometry";

/** 路口盖板描述：位于被标记路径点处的等宽方形路面板，坐标系与铺设路径（代理局部）一致。 */
export interface RoadJunctionPlate {
  /** 盖板中心 = 被标记的路径点；y 为路径点高度，盖板实际顶面在消费端按路面顶 + 抬高量落位。 */
  readonly center: Vector3Value;
  /** 盖板边长：车行道宽度 + 两侧路肩，即道路全铺装宽度，保证同时盖住主路与支路的端缝。 */
  readonly widthM: number;
  /** 来源路径点的稳定 id，测试与诊断可追溯到作者标记。 */
  readonly pointId: string;
}

/**
 * I3 道路 junction（T/十字）：把路径点上作者的 junction 标记解析成等宽方形路口盖板。
 * 作者预览与发布编译同走本函数 + buildLinearPrefabGeometry，两端几何字节级同源；
 * 顺序恒为路径点声明顺序，同输入必得同输出（确定性）。
 * 边界：只做等宽同材质方形盖板衔接 T/十字交汇，不做圆角、高差匝道或复杂立交。
 */
export function roadJunctionPlates(state: IndustrialPrefabInstanceState): readonly RoadJunctionPlate[] {
  const path = state?.placementPath;
  if (!path || state.kind !== "road") return [];
  // 等宽 = 道路全铺装宽度（车行道 + 双路肩）；无路肩时退化为车行道宽度。
  const shape = straightRoadShape(state.parameters);
  const widthM = shape.carriagewayWidthM + 2 * shape.shoulderWidthM;
  const plates: RoadJunctionPlate[] = [];
  for (const point of path.points) {
    if (point.junction !== true) continue;
    plates.push(Object.freeze({
      center: Object.freeze({ ...point.position }),
      widthM,
      pointId: point.id,
    }));
  }
  return Object.freeze(plates);
}
