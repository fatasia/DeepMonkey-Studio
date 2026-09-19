import type { ProbeAabb } from "@bim-studio/deep-engine";
import type { BakeLightState } from "./modelOptimizer";

/**
 * 探针烘焙一期(B 烘焙轴切片)的空间规划层。
 *
 * 脏域语义刻意与 packages/deep-engine/src/lighting/probeClipmapPlan.ts 对齐:
 * 脏域是 ProbeAabb 列表、上限 64、超限收敛为整个场景——本文件只是该语义的
 * 烘焙侧消费方,不是第二套脏域权威;权威仍是灯光状态与场景变化集。
 */

/** 与 DeepGiQuality(performance|balanced|quality)同词表,保证跨系统档位口径一致。 */
export type ProbeBakeQuality = "performance" | "balanced" | "quality";

export const PROBE_BAKE_MAX_DIRTY_BOUNDS = 64;

export interface ProbeBakeQualityPreset {
  /** 每探针均匀球面方向样本数(直接光/遮挡共用同一组方向,保持确定性)。 */
  directionSamples: number;
  /** 每方向每灯阴影射线样本数,1 为硬阴影。 */
  shadowSamples: number;
  /** 每个命中表面的一跳间接样本数,0 关闭间接。 */
  indirectSamples: number;
  /** 探针间距相对场景半径的目标比例。 */
  targetSpacingRatio: number;
  /** 每个烘焙区域每轴的探针数(区域 = 缓存与脏域的最小单元)。 */
  probesPerRegionAxis: number;
}

export const PROBE_BAKE_QUALITY_PRESETS: Record<ProbeBakeQuality, ProbeBakeQualityPreset> = Object.freeze({
  performance: Object.freeze({ directionSamples: 8, shadowSamples: 1, indirectSamples: 0, targetSpacingRatio: 0.22, probesPerRegionAxis: 4 }),
  balanced: Object.freeze({ directionSamples: 16, shadowSamples: 1, indirectSamples: 2, targetSpacingRatio: 0.14, probesPerRegionAxis: 4 }),
  quality: Object.freeze({ directionSamples: 32, shadowSamples: 4, indirectSamples: 4, targetSpacingRatio: 0.09, probesPerRegionAxis: 4 }),
});

export interface ProbeGridLayout {
  origin: [number, number, number];
  spacing: number;
  gridCount: [number, number, number];
  probeCount: number;
  /** 布局指纹:布局变化意味着缓存全部失效(探针位置不再是同一批)。 */
  layoutKey: string;
}

export interface ProbeSamplePoint {
  cell: [number, number, number];
  position: [number, number, number];
  linearIndex: number;
}

export interface ProbeRegionPlan {
  key: string;
  cell: [number, number, number];
  /** 区域 AABB:覆盖本区域探针并向外扩半个间距,保证灯影响域判定保守。 */
  min: [number, number, number];
  max: [number, number, number];
  probes: ProbeSamplePoint[];
}

export interface ProbeGridPlan {
  layout: ProbeGridLayout;
  regions: ProbeRegionPlan[];
  sceneBounds: ProbeAabb;
}

const MAX_PROBES_PER_AXIS = 16;
const MIN_SPACING = 1e-4;

/** 场景包围盒 → 探针网格 + 区域划分。零厚度轴退化为单层探针。 */
export function planProbeGrid(sceneBounds: ProbeAabb, quality: ProbeBakeQuality): ProbeGridPlan {
  const preset = PROBE_BAKE_QUALITY_PRESETS[quality];
  const size = axisSize(sceneBounds);
  const radius = Math.hypot(size[0], size[1], size[2]) * 0.5;
  const spacing = Math.max(radius * preset.targetSpacingRatio, MIN_SPACING);
  const gridCount = size.map((extent, axis) => {
    if (extent <= spacing) return 1;
    return Math.min(MAX_PROBES_PER_AXIS, Math.max(1, Math.ceil(extent / spacing) + 1));
  }) as [number, number, number];
  const origin: [number, number, number] = [sceneBounds.min[0], sceneBounds.min[1], sceneBounds.min[2]];
  const probeCount = gridCount[0] * gridCount[1] * gridCount[2];
  const layout: ProbeGridLayout = {
    origin, spacing, gridCount, probeCount,
    layoutKey: `v1|${origin.map(value => value.toFixed(6)).join(",")}|${spacing.toFixed(6)}|${gridCount.join("x")}|${preset.probesPerRegionAxis}`,
  };
  const half = spacing * 0.5;
  const regions: ProbeRegionPlan[] = [];
  const perAxis = preset.probesPerRegionAxis;
  const regionCount = gridCount.map(count => Math.ceil(count / perAxis)) as [number, number, number];
  for (let rz = 0; rz < regionCount[2]; rz += 1)
    for (let ry = 0; ry < regionCount[1]; ry += 1)
      for (let rx = 0; rx < regionCount[0]; rx += 1) {
        const probes: ProbeSamplePoint[] = [];
        const start: [number, number, number] = [rx * perAxis, ry * perAxis, rz * perAxis];
        const stop: [number, number, number] = [
          Math.min(start[0] + perAxis, gridCount[0]),
          Math.min(start[1] + perAxis, gridCount[1]),
          Math.min(start[2] + perAxis, gridCount[2]),
        ];
        for (let z = start[2]; z < stop[2]; z += 1)
          for (let y = start[1]; y < stop[1]; y += 1)
            for (let x = start[0]; x < stop[0]; x += 1) {
              probes.push({
                cell: [x, y, z],
                position: [origin[0] + x * spacing, origin[1] + y * spacing, origin[2] + z * spacing],
                linearIndex: (z * gridCount[1] + y) * gridCount[0] + x,
              });
            }
        regions.push({
          key: `r:${rx}:${ry}:${rz}`,
          cell: [rx, ry, rz],
          min: [origin[0] + start[0] * spacing - half, origin[1] + start[1] * spacing - half, origin[2] + start[2] * spacing - half],
          max: [origin[0] + (stop[0] - 1) * spacing + half, origin[1] + (stop[1] - 1) * spacing + half, origin[2] + (stop[2] - 1) * spacing + half],
          probes,
        });
      }
  return { layout, regions, sceneBounds: cloneBounds(sceneBounds) };
}

/** 灯的影响域:方向光覆盖整个场景;点光为 position±range 裁剪进场景,不相交返回 null。 */
export function lightInfluenceAabb(light: BakeLightState, sceneBounds: ProbeAabb): ProbeAabb | null {
  assertFiniteLight(light);
  if (light.type === "directional") return cloneBounds(sceneBounds);
  const reach = Math.max(light.range, 0.001);
  const center: [number, number, number] = [light.position[0], light.position[1], light.position[2]];
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    min[axis] = Math.max(center[axis]! - reach, sceneBounds.min[axis]!);
    max[axis] = Math.min(center[axis]! + reach, sceneBounds.max[axis]!);
    if (min[axis]! > max[axis]!) return null;
  }
  return { min, max };
}

/** 灯光状态变化 → 脏域列表(旧∪新影响域,未收敛;几何域语义见 convergeDirtyBounds)。 */
export function dirtyBoundsFromLightDelta(
  previous: readonly BakeLightState[],
  current: readonly BakeLightState[],
  sceneBounds: ProbeAabb,
): ProbeAabb[] {
  const before = new Map(previous.map(light => [light.id, light]));
  const after = new Map(current.map(light => [light.id, light]));
  const dirty: ProbeAabb[] = [];
  const changedIds = new Set<string>();
  for (const [id, light] of before) {
    const next = after.get(id);
    if (!next || !sameLightState(light, next)) changedIds.add(id);
  }
  for (const id of after.keys()) if (!before.has(id)) changedIds.add(id);
  for (const id of changedIds) {
    const oldLight = before.get(id);
    const newLight = after.get(id);
    // 与区域受影响灯的口径一致:仅在旧或新状态中"激活"(启用且强度>0)的灯才派生脏域,
    // 纯禁用态的属性调整不应强拆任何区域。
    const oldBounds = oldLight && isActive(oldLight) ? lightInfluenceAabb(oldLight, sceneBounds) : null;
    const newBounds = newLight && isActive(newLight) ? lightInfluenceAabb(newLight, sceneBounds) : null;
    for (const bounds of [oldBounds, newBounds]) {
      if (bounds) dirty.push(bounds);
    }
  }
  return dirty;
}

function isActive(light: BakeLightState): boolean {
  return light.enabled && light.intensity > 0;
}

/**
 * 间接传播外扩:开启 GI 后,灯光变化会影响影响域之外、经表面反弹到达的探针;
 * 每条脏域向四周外扩 margin(通常 = 最大灯距 × 传播系数)。这是一阶近似,
 * 更远的多次反弹链路需调用方追加 externalDirtyBounds,与 GI probeClipmap 的 dirtyBounds 同责。
 */
export function expandProbeAabb(bounds: ProbeAabb, margin: number): ProbeAabb {
  if (!(margin > 0)) return bounds;
  return {
    min: [bounds.min[0] - margin, bounds.min[1] - margin, bounds.min[2] - margin],
    max: [bounds.max[0] + margin, bounds.max[1] + margin, bounds.max[2] + margin],
  };
}

/** 脏域上限收敛:超过 64 条(GI 脏域同款上限)时退化为整个场景,保证预算有界。 */
export function convergeDirtyBounds(bounds: readonly ProbeAabb[], sceneBounds: ProbeAabb): ProbeAabb[] {
  return bounds.length > PROBE_BAKE_MAX_DIRTY_BOUNDS ? [cloneBounds(sceneBounds)] : [...bounds];
}

export function boundsOverlap(a: ProbeAabb, b: ProbeAabb): boolean {
  return a.min[0] <= b.max[0] && a.max[0] >= b.min[0]
    && a.min[1] <= b.max[1] && a.max[1] >= b.min[1]
    && a.min[2] <= b.max[2] && a.max[2] >= b.min[2];
}

export function regionsAffectedByBounds(plan: ProbeGridPlan, bounds: readonly ProbeAabb[]): ProbeRegionPlan[] {
  if (bounds.length === 0) return [];
  return plan.regions.filter(region => bounds.some(box => boundsOverlap(region, box)));
}

function axisSize(bounds: ProbeAabb): [number, number, number] {
  return [
    Math.max(bounds.max[0] - bounds.min[0], 0),
    Math.max(bounds.max[1] - bounds.min[1], 0),
    Math.max(bounds.max[2] - bounds.min[2], 0),
  ];
}

function sameLightState(left: BakeLightState, right: BakeLightState): boolean {
  return left.type === right.type && left.enabled === right.enabled
    && left.color === right.color && left.intensity === right.intensity && left.range === right.range
    && left.direction.every((value, axis) => value === right.direction[axis])
    && left.position.every((value, axis) => value === right.position[axis]);
}

function assertFiniteLight(light: BakeLightState): void {
  const vectors = light.type === "point" ? [light.position] : [light.direction];
  if (!vectors.every(vector => vector.every(value => Number.isFinite(value))) || !Number.isFinite(light.intensity) || !Number.isFinite(light.range)) {
    throw new RangeError(`灯 ${light.id} 含非有限数值,拒绝烘焙;请检查灯光状态来源。`);
  }
}

function cloneBounds(bounds: ProbeAabb): ProbeAabb {
  return { min: [...bounds.min] as [number, number, number], max: [...bounds.max] as [number, number, number] };
}
