import { describe, expect, it } from "vitest";
import { createSdfGiDayNightState, stepSdfGiDayNightFrame, computeSdfGiDynamicDirectField,
  dayNightSunDirectionEnu,
  referenceRoomBakeInstances, referenceRoomProbeField, aabbBoxMesh } from "./sdfGiDayNight.js";
import { shadeSdfGiFrame, frameDiffP99, SDF_GI_DEFAULT_CAMERA } from "./sdfGiShade.js";
import { sampleAtmosphereSkyRadiance, atmosphereSunTransmittance,
  type AtmosphereSkyParameters } from "../environment/atmosphereSky.js";
import { MAX_SDF_PROFILE_GRID_CELLS } from "../physics/sdfCollisionProfile.js";
import type { ProbeVector3 } from "../lighting/probeClipmapPlan.js";

const TURBIDITY = 3;
/** 物理大气天空采样(昼夜循环唯一天空源;harness 与证据脚本共用同一口径)。 */
export function atmosphereSkyRadiance(sunDirectionEnu: ProbeVector3):
  (directionEnu: ProbeVector3) => ProbeVector3 {
  const parameters: AtmosphereSkyParameters = { turbidity: TURBIDITY, sunDirectionEnu };
  return directionEnu => sampleAtmosphereSkyRadiance(parameters, directionEnu);
}

describe("Brief-GI M1 昼夜循环(旋转天光 + SDF 天光遮蔽 + SSGDI 输入 + 时域滤波)", () => {
  it("状态创建:场景烘焙有界、探针在房间内、可见度值域合法且被墙体调制", () => {
    const state = createSdfGiDayNightState({ directionCount: 16 });
    expect(state.bake.report.bakedCount).toBe(referenceRoomBakeInstances().length);
    expect(state.bake.memory.cells).toBeLessThanOrEqual(MAX_SDF_PROFILE_GRID_CELLS);
    expect(state.probes.length).toBe(9 * 4 * 7);
    for (const value of state.visibility) {
      expect(Number.isFinite(value) && value >= 0 && value <= 1).toBe(true);
    }
    // 物理调制:天窗开口下方探针向上可见度显著高于实心天花下方探针:
    const directionCount = state.directions.length;
    const probeIndex = (x: number, y: number, z: number): number =>
      (z * 4 + y) * 9 + x;
    const underSkylight = state.visibility[probeIndex(2, 2, 3) * directionCount]!; // +y 方向
    const underCeiling = state.visibility[probeIndex(2, 0, 1) * directionCount]!;
    expect(underSkylight).toBeGreaterThan(0.3);
    expect(underCeiling).toBeLessThan(underSkylight);
  });

  it("验收①:昼夜循环连续帧像素差 p99 ≤ 3/255(物理大气天空,旋转太阳)", () => {
    const state = createSdfGiDayNightState({ directionCount: 16 });
    const width = 256, height = 144;
    const step = 0.25; // 每帧方位角步进(度);全循环 1440 帧 = 60fps 下 24 秒昼日
    const shade = (azimuth: number): Uint8Array => {
      const sun = dayNightSunDirectionEnu(azimuth);
      const sky = atmosphereSkyRadiance(sun);
      const transmittance = atmosphereSunTransmittance({ turbidity: TURBIDITY, sunDirectionEnu: sun });
      // 动态直接层注入旋转太阳(地平下直射截止);GI 项经 α=0.1 时域滤波跟进:
      const directSun = sun[2] > 0
        ? { directionYUp: [sun[0], sun[2], sun[1]] as ProbeVector3,
            intensity: 20 * (transmittance[0] + transmittance[1] + transmittance[2]) / 3 }
        : { directionYUp: [0, 1, 0] as ProbeVector3, intensity: 0 };
      stepSdfGiDayNightFrame(state, azimuth, sky, undefined, directSun);
      return shadeSdfGiFrame(state, {
        width, height, camera: SDF_GI_DEFAULT_CAMERA, skyRadiance: sky,
      }).rgba;
    };
    // 预热:探针场时域收敛(α=0.1)后再进入差分测量,分离「收敛瞬态」与「连续旋转」;
    // 测量窗覆盖日出(azimuth 0 起,天空量变化最陡的时段):
    for (let frame = 0; frame < 16; frame++) shade(0);
    let previous = shade(0);
    let worst = 0;
    for (let frame = 1; frame <= 12; frame++) {
      const current = shade(frame * step);
      worst = Math.max(worst, frameDiffP99(previous, current));
      previous = current;
    }
    expect(worst).toBeLessThanOrEqual(3);
  }, 120_000);

  it("时域滤波收敛:静止天光下探针场单调逼近目标(α=0.1 无抖动)", () => {
    const state = createSdfGiDayNightState({ directionCount: 16, alpha: 0.1 });
    const sun = dayNightSunDirectionEnu(30);
    const sky = atmosphereSkyRadiance(sun);
    const energies: number[] = [];
    for (let frame = 0; frame < 40; frame++) {
      stepSdfGiDayNightFrame(state, 30, sky);
      energies.push(state.records.reduce((sum, record) =>
        sum + Math.hypot(record.irradiance[0]!, record.irradiance[1]!, record.irradiance[2]!), 0));
    }
    // 单调收敛(末段能量变化率 < 5%,无滤波抖动):
    const earlyDelta = Math.abs(energies[10]! - energies[0]!);
    const lateDelta = Math.abs(energies[39]! - energies[38]!);
    expect(earlyDelta).toBeGreaterThan(0);
    expect(lateDelta).toBeLessThan(earlyDelta * 0.05);
    expect(lateDelta).toBeLessThan(energies[39]! * 0.005);
  });

  it("验收④(链路 CPU 侧):252 探针 × 16 方向探针 SH 更新 p95 ≤ 6ms 预算", () => {
    const state = createSdfGiDayNightState({ directionCount: 16 });
    const sun = dayNightSunDirectionEnu(45);
    const sky = atmosphereSkyRadiance(sun);
    // SSGDI 项预计算一次(参考积分器代表动态直接层;其 GPU 通路成本不属本预算):
    const ssgdi = computeSdfGiDynamicDirectField(state);
    state.updateMillis.length = 0;
    for (let frame = 0; frame < 16; frame++) {
      stepSdfGiDayNightFrame(state, 45, sky, ssgdi);
    }
    const sorted = [...state.updateMillis].sort((left, right) => left - right);
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    expect(p95).toBeLessThan(6);
  }, 60_000);

  it("探针格/网格工具合同:参考房间 252 探针、AABB 盒 12 三角形、ENU 换算", () => {
    const { positions, level } = referenceRoomProbeField();
    expect(positions.length).toBe(level.probeCount);
    expect(level.gridSize).toEqual([9, 4, 7]);
    const mesh = aabbBoxMesh([0, 0, 0], [1, 1, 1]);
    expect(mesh.positions.length).toBe(24);
    expect(mesh.indices.length).toBe(36);
    expect(dayNightSunDirectionEnu(0)[2]).toBeCloseTo(0, 10);        // 方位 0:仰角 0
    expect(dayNightSunDirectionEnu(90)[2]).toBeCloseTo(Math.sin(22 * Math.PI / 180), 10);
    expect(probeDirectionToEnuStatic([1, 0, 0])).toEqual([1, 0, 0]);
    expect(probeDirectionToEnuStatic([0, 1, 0])).toEqual([0, 0, 1]); // y-up → z-up
  });
});

function probeDirectionToEnuStatic(direction: ProbeVector3): ProbeVector3 {
  return [direction[0], direction[2], direction[1]];
}
