import { bakeSdfSceneGrid, type SdfSceneBakeInstance, type SdfSceneBakeResult } from "./sdfSceneBake.js";
import { traceSdfSkyVisibility } from "./sdfSkyVisibility.js";
import { updateProbeShWithSdfGi, type ProbeShUpdateResult } from "./probeShUpdate.js";
import { probeOcclusionDirection } from "../rayTracing/probeOcclusionRayExtension.js";
import { buildReferenceRoomScene, intersectReferenceScene, referenceSceneDiagonal,
  sampleReferenceDirect, type ReferenceScene } from "../lighting/probeReferenceScene.js";
import { sampleIrradianceProbeClipmap, type IrradianceProbeRecord } from "../lighting/probeClipmapSampling.js";
import type { ProbeClipmapLevel, ProbeVector3 } from "../lighting/probeClipmapPlan.js";

/**
 * Brief-GI M1 昼夜循环验收 harness(纯 CPU 参考域,验收①④⑦的证据发生器)。
 *
 * == 三层构成(Brief-GI 架构,M1 接线的直接验证) ==
 * - 静态遮蔽层:`bakeSdfSceneGrid` 场景 SDF + `traceSdfSkyVisibility` 探针方向圆锥追踪
 *   (静态,烘焙一次)+ `updateProbeShWithSdfGi` 把天光遮蔽写进探针场(时域滤波 α);
 * - 动态直接层(以参考积分器代表 SSGDI 输入口):逐帧随太阳旋转重算阴影直射真值 +
 *   上一帧探针场一阶反弹(probeBounceFeedback 同机制),经 updateProbeShWithSdfGi 的
 *   `ssgdi` 输入口进入探针 SH 更新——任务书 M1 第 3 条「SH 更新接受①②输入」;
 * - 天空:`environment/atmosphereSky` 物理大气(仰角随方位角正弦摆动,地平下自然
 *   熄灭=夜),探针方向 y-up → ENU 转换 [x, z, y]。
 *
 * == 确定性 ==
 * 无 RNG;太阳角是帧号的确定性函数;同帧号同序列逐位回放。
 */

export interface SdfGiDayNightOptions {
  /** 场景 SDF 体素边长(米);缺省 0.15。 */
  readonly cellSize?: number;
  /** 每探针方向数(16 默认档/32 高档);缺省 16。 */
  readonly directionCount?: number;
  /** 探针场时域滤波 α;缺省 0.1。 */
  readonly alpha?: number;
  /** 一阶反弹反照率上限(均匀近似);缺省 [0.45,0.44,0.43]。 */
  readonly bounceAlbedo?: ProbeVector3;
}

export interface SdfGiDayNightState {
  readonly bake: SdfSceneBakeResult;
  readonly scene: ReferenceScene;
  readonly probes: readonly ProbeVector3[];
  readonly level: ProbeClipmapLevel;
  readonly directions: readonly ProbeVector3[];
  /** 静态天光可见度(烘焙一次;下标 = probe × N + dir)。 */
  readonly visibility: Float32Array<ArrayBuffer>;
  readonly alpha: number;
  readonly bounceAlbedo: ProbeVector3;
  records: IrradianceProbeRecord[];
  frameIndex: number;
  /** 每帧探针 SH 更新耗时(ms,验收④证据链)。 */
  readonly updateMillis: number[];
}

/** 参考房间(薄墙/门洞/天窗)→ 静态烘焙实例(全部 static;AABB box 各 12 三角形)。 */
export function referenceRoomBakeInstances(): SdfSceneBakeInstance[] {
  return buildReferenceRoomScene().boxes.map((box, index) => ({
    id: `reference-box-${String(index).padStart(2, "0")}`,
    mesh: aabbBoxMesh(box.min, box.max),
  }));
}

/** AABB → 12 三角形盒(索引序固定,确定性)。 */
export function aabbBoxMesh(min: ProbeVector3, max: ProbeVector3):
  { positions: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  return {
    positions: Float32Array.from([
      x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
      x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
    ]),
    indices: Uint32Array.from([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
      3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    ]),
  };
}

/** 探针格:参考房间内 uniform 间距 lattice(clipmap level 的 uniform spacing 合同)。 */
export function referenceRoomProbeField(): { positions: ProbeVector3[]; level: ProbeClipmapLevel } {
  const spacing = 1;
  const gridSize = [9, 4, 7] as const;
  const positions: ProbeVector3[] = [];
  for (let z = 0; z < gridSize[2]; z++) for (let y = 0; y < gridSize[1]; y++) {
    for (let x = 0; x < gridSize[0]; x++) {
      positions.push([x * spacing, y * spacing, z * spacing]);
    }
  }
  const level: ProbeClipmapLevel = { level: 0, gridSize: [...gridSize], spacing,
    originCell: [0, 0, 0], origin: [0, 0, 0], max: [8, 3, 6],
    probeCount: gridSize[0] * gridSize[1] * gridSize[2] };
  return { positions, level };
}

/** 昼夜太阳:方位角 = 帧角;仰角 = 22°·sin(方位角)(地平下自然入夜)。ENU 单位矢量。 */
export function dayNightSunDirectionEnu(azimuthDegrees: number): ProbeVector3 {
  const azimuth = azimuthDegrees * Math.PI / 180;
  const elevation = 22 * Math.PI / 180 * Math.sin(azimuth);
  return [Math.cos(azimuth) * Math.cos(elevation), Math.sin(azimuth) * Math.cos(elevation),
    Math.sin(elevation)];
}

/** 探针方向(y-up)→ ENU(z-up):[x, z, y]。 */
export function probeDirectionToEnu(direction: ProbeVector3): ProbeVector3 {
  return [direction[0]!, direction[2]!, direction[1]!];
}

/** 创建状态:场景 SDF 烘焙(一次)+ 静态天光可见度(一次)+ 空探针场。 */
export function createSdfGiDayNightState(options: SdfGiDayNightOptions = {}): SdfGiDayNightState {
  const cellSize = options.cellSize ?? 0.15;
  const directionCount = options.directionCount ?? 16;
  const bake = bakeSdfSceneGrid(referenceRoomBakeInstances(), { cellSize, instanceDomain: "scene" });
  const scene = buildReferenceRoomScene();
  const { positions, level } = referenceRoomProbeField();
  const directions = Array.from({ length: directionCount },
    (_, ordinal) => probeOcclusionDirection(ordinal, directionCount));
  const visibility = traceSdfSkyVisibility(bake.grid, positions, directions,
    { maxDistance: referenceSceneDiagonal(scene) });
  return {
    bake, scene, probes: positions, level, directions, visibility,
    alpha: options.alpha ?? 0.1,
    bounceAlbedo: options.bounceAlbedo ?? [0.45, 0.44, 0.43],
    records: positions.map(() => ({ irradiance: [0, 0, 0], validity: 1,
      meanDistance: referenceSceneDiagonal(scene), distanceVariance: 0 })),
    frameIndex: 0, updateMillis: [],
  };
}

/**
 * 单帧推进:旋转天光 → 探针 SH 更新(①SDF 天光遮蔽 + ②SSGDI 输入 + 时域滤波)。
 * `skyRadiance(directionEnu)` 由调用方注入(物理大气或均匀场对照)。
 * `directSun` 注入动态直接层的方向光(旋转太阳:y-up 方向 + 强度;缺省 = 参考场景
 * 既有固定光,验收①的昼夜门以旋转太阳注入)。
 * `ssgdi` 可外部注入(帧预算测量只计时探针 SH 更新本身;缺省由参考积分器现算,
 * 其成本是 CPU 参考直射层,不代表生产 SSGDI GPU 通路)。
 * 返回本帧探针 SH 更新结果(消费方可取 targetEnergy 做证据)。
 */
export function stepSdfGiDayNightFrame(state: SdfGiDayNightState, azimuthDegrees: number,
  skyRadiance: (directionEnu: ProbeVector3) => ProbeVector3,
  ssgdi?: readonly (ProbeVector3 | undefined)[],
  directSun?: { readonly directionYUp: ProbeVector3; readonly intensity: number }): ProbeShUpdateResult {
  const directionSkyRadiance = state.directions.map(direction =>
    skyRadiance(probeDirectionToEnu(direction)));
  const dynamicDirect = ssgdi ?? computeSdfGiDynamicDirectField(state, directSun);
  const started = performance.now();
  const result = updateProbeShWithSdfGi({
    previous: state.records, positions: state.probes, directions: state.directions,
    visibilities: state.visibility, directionSkyRadiance, ssgdi: dynamicDirect,
    bounceAlbedo: state.bounceAlbedo, alpha: state.alpha });
  state.records = [...result.records];
  state.frameIndex += 1;
  state.updateMillis.push(performance.now() - started);
  return result;
}

/** 动态直接层(参考积分器口径):阴影直射真值 + 上一帧探针场一阶反弹。 */
export function computeSdfGiDynamicDirectField(state: SdfGiDayNightState,
  directSun?: { readonly directionYUp: ProbeVector3; readonly intensity: number }):
  readonly ProbeVector3[] {
  const tMax = referenceSceneDiagonal(state.scene);
  const step = Math.max(tMax / 64, 1e-3);
  const scene = directSun === undefined ? state.scene : { ...state.scene, light: {
    surfaceToLightWorld: directSun.directionYUp, intensity: directSun.intensity } };
  return state.probes.map(position =>
    evaluateDynamicDirectField(scene, position, state.directions, tMax, step,
      state.records, state.level, state.bounceAlbedo));
}

/** 阴影直射真值 + 一阶反弹(引擎口径;miss 项 = 0,动态直接层不重复计天空)。 */
function evaluateDynamicDirectField(scene: ReferenceScene, position: ProbeVector3,
  directions: readonly ProbeVector3[], tMax: number, step: number,
  previousRecords: readonly IrradianceProbeRecord[], level: ProbeClipmapLevel,
  bounceAlbedo: ProbeVector3): ProbeVector3 {
  let r = 0, g = 0, b = 0;
  for (const direction of directions) {
    const hit = intersectReferenceScene(scene, position, direction, tMax);
    if (hit === undefined) continue;
    const hitPoint: ProbeVector3 = [position[0]! + direction[0]! * hit.t,
      position[1]! + direction[1]! * hit.t, position[2]! + direction[2]! * hit.t];
    const direct = sampleReferenceDirect(scene, hitPoint, hit.normal, hit.albedo, true);
    const lifted: ProbeVector3 = [hitPoint[0] + hit.normal[0]! * step,
      hitPoint[1] + hit.normal[1]! * step, hitPoint[2] + hit.normal[2]! * step];
    const sampled = sampleIrradianceProbeClipmap({ worldPosition: lifted, worldNormal: hit.normal,
      levels: [level], records: previousRecords, environmentFallback: [0, 0, 0] });
    r += direct[0] + bounceAlbedo[0]! * sampled.irradiance[0]!;
    g += direct[1] + bounceAlbedo[1]! * sampled.irradiance[1]!;
    b += direct[2] + bounceAlbedo[2]! * sampled.irradiance[2]!;
  }
  const count = directions.length;
  return [r / count, g / count, b / count];
}
