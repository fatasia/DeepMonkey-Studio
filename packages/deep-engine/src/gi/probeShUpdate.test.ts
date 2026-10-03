import { describe, expect, it } from "vitest";
import { projectSkyVisibilitySh, evaluateSkyVisibilitySh, blendSkyVisibilitySh,
  isSkyVisibilityShNeutral, type SkyVisibilitySh } from "./probeSkyVisibilitySh.js";
import { updateProbeShWithSdfGi, resolveDeepGiTemporalAlpha, DEEP_GI_PROBE_TEMPORAL_ALPHA,
  probeVisibilitySlice, type ProbeShUpdateInput } from "./probeShUpdate.js";
import { probeOcclusionDirection } from "../rayTracing/probeOcclusionRayExtension.js";
import type { IrradianceProbeRecord } from "../lighting/probeClipmapSampling.js";
import type { ProbeVector3 } from "../lighting/probeClipmapPlan.js";

const DIRECTIONS_16 = Array.from({ length: 16 }, (_, ordinal) => probeOcclusionDirection(ordinal, 16));
const UNIT_SKY: ProbeVector3[] = DIRECTIONS_16.map(() => [1, 1, 1]);

describe("Brief-GI M1 天光可见度 L1 SH(白炉构造合同)", () => {
  it("白炉逐位负控:均匀可见度 → c0 精确、dipoles 逐位零、重建逐位恒等", () => {
    for (const uniform of [1, 0.5, 0.25] as const) {
      const visibilities = DIRECTIONS_16.map(() => uniform);
      const sh = projectSkyVisibilitySh(visibilities, DIRECTIONS_16);
      expect(sh[0]).toBe(uniform);
      expect(sh[1]).toBe(0);   // d_y 逐位零
      expect(sh[2]).toBe(0);   // d_z 逐位零
      expect(sh[3]).toBe(0);   // d_x 逐位零
      for (const direction of DIRECTIONS_16) {
        expect(evaluateSkyVisibilitySh(sh, direction)).toBe(uniform);
      }
    }
    expect(isSkyVisibilityShNeutral([1, 0, 0, 0])).toBe(false);
    expect(isSkyVisibilityShNeutral([0, 0, 0, 0])).toBe(true);
    expect(isSkyVisibilityShNeutral(undefined)).toBe(true);
  });

  it("方向性:上半球开/下半球闭 → 重建单调分辨(上下差异显著)", () => {
    const visibilities = DIRECTIONS_16.map(direction => direction[1]! >= 0 ? 1 : 0);
    const sh = projectSkyVisibilitySh(visibilities, DIRECTIONS_16);
    const up = evaluateSkyVisibilitySh(sh, [0, 1, 0]);
    const down = evaluateSkyVisibilitySh(sh, [0, -1, 0]);
    expect(up).toBeGreaterThan(0.6);
    expect(down).toBeLessThan(0.4);
    expect(up - down).toBeGreaterThan(0.4);
  });

  it("时域滤波:α=0/1 逐位透传,稳态逐位不动,非法 α fail-fast", () => {
    const a: SkyVisibilitySh = [0.5, 0.1, -0.2, 0.05];
    const b: SkyVisibilitySh = [1, -0.1, 0.3, 0];
    expect(blendSkyVisibilitySh(a, b, 0)).toBe(a);
    expect(blendSkyVisibilitySh(a, b, 1)).toBe(b);
    const mid = blendSkyVisibilitySh(a, b, 0.5);
    expect(mid[0]).toBe(0.75);
    // 稳态不动点:b 与 b 的 lerp 逐位仍等于 b(0·α 精确消去):
    const steady = blendSkyVisibilitySh(b, b, 0.1);
    expect(steady[0]).toBe(b[0]);
    expect(steady[1]).toBe(b[1]);
    expect(steady[2]).toBe(b[2]);
    expect(steady[3]).toBe(b[3]);
    expect(() => blendSkyVisibilitySh(a, b, 1.5)).toThrow(/alpha/);
    expect(() => blendSkyVisibilitySh(a, b, NaN)).toThrow(/alpha/);
  });

  it("投影校验:长度失配/越界值/非有限方向 fail-fast", () => {
    expect(() => projectSkyVisibilitySh([1, 1], DIRECTIONS_16)).toThrow(/one direction per/);
    expect(() => projectSkyVisibilitySh(DIRECTIONS_16.map(() => 1.5), DIRECTIONS_16))
      .toThrow(/\[0, 1\]/);
    expect(() => projectSkyVisibilitySh(DIRECTIONS_16.map(() => NaN), DIRECTIONS_16))
      .toThrow(/finite/);
  });
});

function record(irradiance: ProbeVector3,
  extra: Partial<IrradianceProbeRecord> = {}): IrradianceProbeRecord {
  return { irradiance, validity: 1, meanDistance: 10, distanceVariance: 0.5, ...extra };
}

const POSITION: ProbeVector3[] = [[1, 1, 1], [2, 1, 1], [3, 1, 1]];

function updateInput(overrides: Partial<ProbeShUpdateInput> = {}): ProbeShUpdateInput {
  const visibilities = new Float32Array(POSITION.length * DIRECTIONS_16.length).fill(1);
  return {
    previous: POSITION.map(() => undefined),
    positions: POSITION,
    directions: DIRECTIONS_16,
    visibilities,
    directionSkyRadiance: UNIT_SKY,
    ...overrides,
  };
}

describe("Brief-GI M1 探针 SH 更新(①天光遮蔽 ②SSGDI + 时域滤波)", () => {
  it("白炉稳定性:均匀天空 × 全开可见度,稳态场任意 α 逐位不动", () => {
    const steady = POSITION.map(() => record([1, 1, 1]));
    const result = updateProbeShWithSdfGi(updateInput({ previous: steady, alpha: 0.1 }));
    for (const updated of result.records) {
      expect(updated.irradiance[0]).toBe(1);
      expect(updated.irradiance[1]).toBe(1);
      expect(updated.irradiance[2]).toBe(1);
    }
    // 首帧(无 previous)同样精确落在均匀目标:
    const firstFrame = updateProbeShWithSdfGi(updateInput({}));
    for (const updated of firstFrame.records) {
      expect(updated.irradiance[0]).toBe(1);
    }
  });

  it("遮蔽生效:全闭可见度 → 目标只剩 SSGDI 输入;时域向目标收敛", () => {
    const closed = new Float32Array(POSITION.length * DIRECTIONS_16.length);
    const ssgdi: ProbeVector3[] = [[0.5, 0.4, 0.3], [0, 0, 0], [0, 0, 0]];
    let state = POSITION.map(() => record([0, 0, 0]));
    for (let frame = 0; frame < 64; frame++) {
      const result = updateProbeShWithSdfGi(updateInput({
        previous: state, visibilities: closed, ssgdi, alpha: 0.1 }));
      state = [...result.records];
    }
    // α=0.1 收敛到 target = ssgdi(天光项被全闭可见度清零);64 帧后残差按幅值 ≤2e-3:
    expect(Math.abs(state[0]!.irradiance[0] - 0.5)).toBeLessThan(2e-3);
    expect(Math.abs(state[1]!.irradiance[1])).toBeLessThan(2e-3);
    // occlusionFloor = 可见度均值 c0(全闭 = 0):
    expect(state[0]!.occlusionFloor).toBe(0);
  });

  it("F5 合同不动:words[12..23] 捕获 SH 原样透传(同对象),嵌入探针原样透传", () => {
    const capturedSh: NonNullable<IrradianceProbeRecord["directionalVisibilitySh"]> = {
      r: [1, 0, 0, 0], g: [0.5, 0, 0, 0], b: [0.2, 0, 0, 0] };
    const previous = [record([1, 1, 1], { directionalVisibilitySh: capturedSh }), record([2, 2, 2])];
    const buried = record([9, 9, 9], { validity: 0 });
    const result = updateProbeShWithSdfGi(updateInput({ previous: [...previous, buried] }));
    if (result.records.length !== 3) throw new Error("expected three records");
    expect(result.records[0]!.directionalVisibilitySh).toBe(capturedSh);
    expect(result.records[2]).toBe(buried);           // 埋入探针:同对象透传,不被天光场复活
    expect(result.records[2]!.irradiance[0]).toBe(9);
    // 正常探针 occlusionFloor = c0 = 1(全开):
    expect(result.records[0]!.occlusionFloor).toBe(1);
  });

  it("静态 1 bounce:反照率抬升目标能量;能量哨兵在非有限目标上 fail-closed", () => {
    const closed = new Float32Array(POSITION.length * DIRECTIONS_16.length);
    const ssgdi: ProbeVector3[] = [[0.4, 0.4, 0.4], [0.4, 0.4, 0.4], [0.4, 0.4, 0.4]];
    const result = updateProbeShWithSdfGi(updateInput({
      previous: POSITION.map(() => record([0, 0, 0])), visibilities: closed, ssgdi,
      bounceAlbedo: [0.5, 0.5, 0.5], alpha: 1 }));
    expect(result.bounceSentinelTrips).toBe(0);
    for (const updated of result.records) {
      // bounce 后 = target ×(1+ρ)= 0.4 × 1.5:
      expect(updated.irradiance[0]).toBeCloseTo(0.6, 5);
    }
    expect(result.targetEnergy).toBeGreaterThan(0);
  });

  it("配置解析 fail-closed + 可见度切片对齐", () => {
    expect(DEEP_GI_PROBE_TEMPORAL_ALPHA).toBeCloseTo(0.1, 10);
    expect(resolveDeepGiTemporalAlpha(undefined)).toBe(0.1);
    expect(resolveDeepGiTemporalAlpha(0.05)).toBe(0.05);
    expect(resolveDeepGiTemporalAlpha(0)).toBe(0.1);
    expect(resolveDeepGiTemporalAlpha(Number.NaN)).toBe(0.1);
    const visibilities = new Float32Array(6).fill(0).map((_, index) => index % 2 ? 0.5 : 1);
    expect(probeVisibilitySlice(visibilities, 1, 3)).toEqual([0.5, 1, 0.5]);
    expect(() => updateProbeShWithSdfGi(updateInput({
      directionSkyRadiance: [[1, 1, 1]] }))).toThrow(/misaligned/);
    expect(() => updateProbeShWithSdfGi(updateInput({
      positions: [[1, 1, 1]] }))).toThrow(/one previous record per probe/);
  });
});
