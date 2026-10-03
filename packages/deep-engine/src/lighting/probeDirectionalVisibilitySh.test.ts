import { describe, expect, it } from "vitest";
import { probeOcclusionDirection } from "../rayTracing/probeOcclusionRayExtension.js";
import { packIrradianceProbeRecord } from "./probeClipmapSampling.js";
import { evaluateProbeDirectionalVisibilitySh, isProbeDirectionalVisibilityShMissing,
  projectProbeDirectionalVisibilitySh, probeSpecularDirectionalVisibilityGate,
  DEEP_GI_PROBE_VISIBILITY_SH_WORDS, DEEP_GI_PROBE_VISIBILITY_SH_WORD_OFFSET,
  unpackProbeVisibilityShWords } from "./probeDirectionalVisibilitySh.js";

const directions32 = Array.from({ length: 32 }, (_, ordinal) => probeOcclusionDirection(ordinal, 32));
const grey = (value: number): [number, number, number] => [value, value, value];

/** Chebyshev–Hermite 论证的方向性正控制：上半球恒 L、下半球 0 的解析场。 */
function hemisphereSamples(top: number, bottom: number): readonly [number, number, number][] {
  return directions32.map(direction => (direction[1]! >= 0 ? grey(top) : grey(bottom)));
}

describe("F5 方案 A：RGB L1 SH 方向可见度（words[12..23]）", () => {
  it("白炉逐位负控：均匀场 dipole 精确全零、重建恒等、门精确 1（乘法逐位不变）", () => {
    const uniform = Array.from({ length: 32 }, () => grey(0.5));
    const sh = projectProbeDirectionalVisibilitySh(uniform, directions32);
    // 32 个同值浮点求和/除 32 精确无舍入 → 均值扣除恒 0.0 → dipole 必须是字面 0。
    for (const channel of [sh.r, sh.g, sh.b]) {
      expect(channel[0]).toBe(0.5);
      expect(channel[1]).toBe(0);
      expect(channel[2]).toBe(0);
      expect(channel[3]).toBe(0);
    }
    for (const direction of directions32) {
      expect(evaluateProbeDirectionalVisibilitySh(sh, direction)).toEqual(grey(0.5));
    }
    const gate = probeSpecularDirectionalVisibilityGate({
      inDomain: true, environmentIrradiance: grey(0.5), probeIrradiance: grey(0.5),
      reflection: directions32[7]!, directionalSh: sh });
    expect(gate).toBe(1);
    // radiance * 1.0 与 radiance 逐位同（IEEE754 ×1.0 精确）。
    expect(123.456 * gate).toBe(123.456);
  });

  it("方向性验证：上半球亮/下半球暗的场，重建随反射方向分辨上/下半球（标量门不可分辨对照）", () => {
    const top = 1, bottom = 0;
    const sh = projectProbeDirectionalVisibilitySh(hemisphereSamples(top, bottom), directions32);
    const up = evaluateProbeDirectionalVisibilitySh(sh, [0, 1, 0]);
    const down = evaluateProbeDirectionalVisibilitySh(sh, [0, -1, 0]);
    // 重建核 (1, y, z, x)：朝上 ≈ 亮值、朝下 ≈ 暗值（32 方向离散 + LSQ 的有限锐度）。
    expect(up[0]).toBeGreaterThan(0.75);
    expect(down[0]).toBeLessThan(0.25);
    // 标量门（记录均值 0.5）对上/下半球给出同一个数：方向差只有 L1 能表达。
    const scalar = probeSpecularEnvironmentVisibilityScalar(grey(top / 2 + bottom / 2));
    const gateUp = probeSpecularDirectionalVisibilityGate({
      inDomain: true, environmentIrradiance: grey(1), probeIrradiance: grey(0.5),
      reflection: [0, 1, 0], directionalSh: sh });
    const gateDown = probeSpecularDirectionalVisibilityGate({
      inDomain: true, environmentIrradiance: grey(1), probeIrradiance: grey(0.5),
      reflection: [0, -1, 0], directionalSh: sh });
    expect(gateUp).toBeGreaterThan(scalar);
    expect(gateDown).toBeLessThan(scalar);
  });

  it("pack 往返：words[12..23] channel-major（R/G/B 各 4 系数 l0,m-1,m0,m1），缺省全零", () => {
    const samples = hemisphereSamples(1, 0);
    const sh = projectProbeDirectionalVisibilitySh(samples, directions32);
    const words = Array.from(new Float32Array(packIrradianceProbeRecord({
      irradiance: grey(1), validity: 1, meanDistance: 1, distanceVariance: 0.01,
      occlusionFloor: 0, directionalVisibilitySh: sh })));
    expect(words.length).toBe(24);
    expect(words.slice(0, DEEP_GI_PROBE_VISIBILITY_SH_WORD_OFFSET)).toHaveLength(12);
    expect(words.slice(DEEP_GI_PROBE_VISIBILITY_SH_WORD_OFFSET + 0,
      DEEP_GI_PROBE_VISIBILITY_SH_WORD_OFFSET + 4)).toEqual([...sh.r].map(Math.fround));
    expect(words.slice(DEEP_GI_PROBE_VISIBILITY_SH_WORD_OFFSET + 4,
      DEEP_GI_PROBE_VISIBILITY_SH_WORD_OFFSET + 8)).toEqual([...sh.g].map(Math.fround));
    expect(words.slice(DEEP_GI_PROBE_VISIBILITY_SH_WORD_OFFSET + 8,
      DEEP_GI_PROBE_VISIBILITY_SH_WORD_OFFSET + 12)).toEqual([...sh.b].map(Math.fround));
    const unpacked = unpackProbeVisibilityShWords(words);
    // pack 是 f32 落盘：往返与 fround 后的系数逐位等（这正是 native 同形对拍的字节合同）。
    expect(unpacked).toEqual({
      r: [...sh.r].map(Math.fround), g: [...sh.g].map(Math.fround), b: [...sh.b].map(Math.fround) });
    // 缺省（旧捕获）仍写全零：native 零校验/旧消费者零影响。
    const legacy = Array.from(new Float32Array(packIrradianceProbeRecord({
      irradiance: grey(1), validity: 1, meanDistance: 1, distanceVariance: 0.01 })));
    expect(legacy.slice(DEEP_GI_PROBE_VISIBILITY_SH_WORD_OFFSET))
      .toEqual(Array(DEEP_GI_PROBE_VISIBILITY_SH_WORDS).fill(0));
    expect(unpackProbeVisibilityShWords(legacy)).toBeUndefined();
    expect(isProbeDirectionalVisibilityShMissing(undefined)).toBe(true);
    expect(isProbeDirectionalVisibilityShMissing(sh)).toBe(false);
  });

  it("门保守三分支：域外恒 1、环境近黑恒 1、SH 缺失走标量 fallback、过冲 clamp 到 1", () => {
    const sh = projectProbeDirectionalVisibilitySh(hemisphereSamples(2, 0), directions32);
    expect(probeSpecularDirectionalVisibilityGate({
      inDomain: false, environmentIrradiance: grey(1), probeIrradiance: grey(5),
      reflection: [0, 1, 0], directionalSh: sh })).toBe(1);
    expect(probeSpecularDirectionalVisibilityGate({
      inDomain: true, environmentIrradiance: grey(0.00001), probeIrradiance: grey(5),
      reflection: [0, 1, 0], directionalSh: sh })).toBe(1);
    // SH 缺失：fallback 标量门（f5-variant-semantics 裁定式）。
    expect(probeSpecularDirectionalVisibilityGate({
      inDomain: true, environmentIrradiance: grey(1), probeIrradiance: grey(0.25),
      reflection: [0, -1, 0], directionalSh: undefined })).toBe(0.25);
    // 方向重建过冲 clamp 到 1（不放大）。
    expect(probeSpecularDirectionalVisibilityGate({
      inDomain: true, environmentIrradiance: grey(0.5), probeIrradiance: grey(2),
      reflection: [0, 1, 0], directionalSh: sh })).toBe(1);
    // 非有限系数在 pack 侧 fail-fast。
    expect(() => projectProbeDirectionalVisibilitySh(
      [[Number.NaN, 0, 0], ...Array.from({ length: 31 }, () => grey(1))], directions32))
      .toThrow(RangeError);
  });
});

/** 标量 fallback 参照（f5-variant-semantics 裁定式，仅本测试对照用）。 */
function probeSpecularEnvironmentVisibilityScalar(probe: [number, number, number]): number {
  return Math.min(1, Math.max(0, (probe[0] + probe[1] * 0 + probe[2] * 0) / 1));
}
