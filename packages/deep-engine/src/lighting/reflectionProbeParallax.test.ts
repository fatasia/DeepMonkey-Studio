// C15 反射探针盒投影视差校正——CPU 数据面与量化门禁。
// 断言数值全部来自本仓 tsx 实跑记录(2026-09-29),不凭想象打分:
// 平面(现状 raw reflect)误差随接收点偏心单调涨至 61.5°(1080p/60° 视口 ≈ 1107px),
// 盒投影在构造性成立域(内容位于影响体 AABB 面上)误差恒 0;
// 远内容(超出影响体)为诚实边界:盒投影误差可大于平面,由测试钉死为文档化行为。
import { describe, expect, it } from "vitest";
import { DEEP_REFLECTION_PROBE_SECONDARY_CUTOFF,
} from "./reflectionProbeBoxProjectionWgsl.js";
import { DEEP_REFLECTION_PARALLAX_DEFAULT_VIEWPORT, measureReflectionParallaxCase,
  packReflectionProbeRecord, reflectionProbeBoxProjectCpu, reflectionProbeInfluenceWeightCpu,
  reflectionProbePairWeightsCpu, resolveReflectionProbeBox, roomParallaxCases,
  selectReflectionProbePair, unpackReflectionProbeRecord,
} from "./reflectionProbeParallax.js";

const ROOM = Object.freeze({
  center: Object.freeze([0, 0, 0] as const),
  halfExtents: Object.freeze([4, 1.5, 4] as const),
  blendDistance: 1,
  influenceRadius: 2,
});

describe("reflection probe parallax data plane (C15)", () => {
  it("packs and unpacks the 64-byte record layout without drift", () => {
    const record = { ...ROOM, captureOffset: [0.5, 0, 0] as const, generation: 3 };
    const unpacked = unpackReflectionProbeRecord(packReflectionProbeRecord(record));
    expect(unpacked.center).toEqual([0, 0, 0]);
    expect(unpacked.halfExtents).toEqual([4, 1.5, 4]);
    expect(unpacked.blendDistance).toBe(1);
    expect(unpacked.influenceRadius).toBe(2);
    expect(unpacked.captureOffset).toEqual([0.5, 0, 0]);
    expect(unpacked.generation).toBe(3);
  });

  it("fails closed on invalid probe records instead of shipping silent NaN", () => {
    expect(() => packReflectionProbeRecord({ ...ROOM, center: [NaN, 0, 0] })).toThrow(RangeError);
    expect(() => packReflectionProbeRecord({ ...ROOM, halfExtents: [0, 1.5, 4] })).toThrow(RangeError);
    expect(() => packReflectionProbeRecord({ ...ROOM, blendDistance: -1 })).toThrow(RangeError);
    expect(() => packReflectionProbeRecord({ ...ROOM, influenceRadius: Number.NaN })).toThrow(RangeError);
    // f32 精确整数上限 2^24:代际号超出会在存储时静默失真,fail-closed。
    expect(() => packReflectionProbeRecord({ ...ROOM, generation: 16_777_217 })).toThrow(RangeError);
    expect(() => unpackReflectionProbeRecord(new ArrayBuffer(32))).toThrow(RangeError);
  });

  it("weights probes: core 1, monotonic decay in the outer shell, 0 beyond influence", () => {
    // 核 = AABB 内(权重 1)。
    expect(reflectionProbeInfluenceWeightCpu([0, -1, 0], ROOM)).toBe(1);
    // 过渡壳 = 影响体边界向内 blendDistance:blendDistance=1, radius=2 → 壳在 AABB 外
    // 1..2m;x+0.5/0.99 仍在核,壳内单调衰减,x+1.5=0.5,x+1.99≈0.01,x+2=0。
    expect(reflectionProbeInfluenceWeightCpu([4.5, 0, 0], ROOM)).toBe(1);
    expect(reflectionProbeInfluenceWeightCpu([4.99, 0, 0], ROOM)).toBe(1);
    const shellMid = reflectionProbeInfluenceWeightCpu([5.5, 0, 0], ROOM);
    expect(shellMid).toBeCloseTo(0.5, 12);
    const shellNear = reflectionProbeInfluenceWeightCpu([5.99, 0, 0], ROOM);
    expect(shellNear).toBeGreaterThan(0);
    expect(shellNear).toBeLessThan(shellMid);
    expect(reflectionProbeInfluenceWeightCpu([6.01, 0, 0], ROOM)).toBe(0);
    // blendDistance=0 退化为边界硬切换(代际切换语义),壳内无渐变。
    const hard = { ...ROOM, blendDistance: 0 };
    expect(reflectionProbeInfluenceWeightCpu([5.99, 0, 0], hard)).toBe(1);
    expect(reflectionProbeInfluenceWeightCpu([6.01, 0, 0], hard)).toBe(0);
    // 非法输入一律 0(与 WGSL 守卫同语义)。
    expect(reflectionProbeInfluenceWeightCpu([NaN, 0, 0], ROOM)).toBe(0);
    expect(reflectionProbeInfluenceWeightCpu([0, 0, 0], { ...ROOM, halfExtents: [0, 1, 1] })).toBe(0);
  });

  it("projects: receiver at probe center keeps the direction, exit hits the AABB face", () => {
    const result = reflectionProbeBoxProjectCpu([0, 0, 0], [0.3, 0.5, 0.81], ROOM);
    expect(result.corrected).toBe(true);
    // 中心接收点:交点方向 ≡ 原方向(单位化后),构造性恒等。
    const length = Math.hypot(0.3, 0.5, 0.81);
    expect(result.direction[0]).toBeCloseTo(0.3 / length, 12);
    expect(result.direction[1]).toBeCloseTo(0.5 / length, 12);
    expect(result.direction[2]).toBeCloseTo(0.81 / length, 12);
    // 出射步长 = y 轴先行:1.5/0.50098…(tsx 实跑 2.994144285100503)。
    expect(result.hitDistance).toBeCloseTo(2.994144285100503, 9);
  });

  it("projects: off-center receiver converges to the analytic wall-hit direction", () => {
    const position: [number, number, number] = [3, -1.2, 1];
    const direction: [number, number, number] = [0.2, 0.8, 0.2];
    const result = reflectionProbeBoxProjectCpu(position, direction, ROOM);
    expect(result.corrected).toBe(true);
    // 解析真值:交点 = 接收点 + 单位方向·出射步长,采样方向 = 交点相对探针中心。
    const unit = direction.map(value => value / Math.hypot(...direction));
    const exit = Math.min(...unit.map((value, axis) => {
      if (Math.abs(value) < 1e-6) return Infinity;
      const bound = value > 0 ? ROOM.halfExtents[axis]! : -ROOM.halfExtents[axis]!;
      return (bound - (position[axis]! - ROOM.center[axis]!)) / value;
    }));
    const hit = position.map((value, axis) => value + unit[axis]! * exit);
    const truth = hit.map(value => value / Math.hypot(...hit));
    expect(result.hitDistance).toBeCloseTo(exit, 9);
    result.direction.forEach((value, axis) => expect(value).toBeCloseTo(truth[axis]!, 9));
    // 交点必须落在 AABB 面上(至少一轴到达边界)。
    const onFace = hit.some((value, axis) => Math.abs(Math.abs(value) - ROOM.halfExtents[axis]!) < 1e-6);
    expect(onFace).toBe(true);
  });

  it("falls back with explicit sentinels instead of correcting the uncorrectable", () => {
    // 盒外(与 influenceWeight>0 同判据的 AABB 判据):哨兵 -1,方向原样返回。
    const outside = reflectionProbeBoxProjectCpu([4.5, 0, 0], [1, 0, 0], ROOM);
    expect(outside.corrected).toBe(false);
    expect(outside.hitDistance).toBe(-1);
    expect(outside.direction).toEqual([1, 0, 0]);
    // 退化:零方向 / 非有限 / 非法 extents:哨兵 -2。
    const degenerate = reflectionProbeBoxProjectCpu([0, 0, 0], [0, 0, 0], ROOM);
    expect(degenerate.hitDistance).toBe(-2);
    const notFinite = reflectionProbeBoxProjectCpu([0, 0, 0], [NaN, 1, 0], ROOM);
    expect(notFinite.hitDistance).toBe(-2);
    const badBox = reflectionProbeBoxProjectCpu([0, 0, 0], [1, 0, 0], { ...ROOM, halfExtents: [-4, 1, 1] });
    expect(badBox.hitDistance).toBe(-2);
  });

  it("normalizes dual-probe pair weights with the shared cutoff semantics", () => {
    expect(reflectionProbePairWeightsCpu(1, 1)).toEqual([0.5, 0.5]);
    // 次级低于裁剪阈:只保留主探针(1,0)——单探针退化不付第二次 cubemap 采样。
    expect(reflectionProbePairWeightsCpu(1, DEEP_REFLECTION_PROBE_SECONDARY_CUTOFF / 2)).toEqual([1, 0]);
    // 双零/低于阈总和:无覆盖 (0,0),宿主走纯环境回退。
    expect(reflectionProbePairWeightsCpu(0, 0)).toEqual([0, 0]);
    expect(reflectionProbePairWeightsCpu(0.005, 0.004)).toEqual([0, 0]);
    // 负权重视同缺失:非法主权重不入混合,次级顶上(与 WGSL select 守卫同式)。
    expect(reflectionProbePairWeightsCpu(-1, 0.5)).toEqual([0, 1]);
  });

  it("resolves AABB: manual wins, scene-bounds derives, missing both fails closed", () => {
    const bounds = { min: [-8, -1.5, -8] as const, max: [8, 3, 8] as const };
    const manual = resolveReflectionProbeBox({
      manual: { center: [1, 2, 3], halfExtents: [2, 1, 2], blendDistance: 0.5 },
      sceneBounds: bounds,
    });
    expect(manual.source).toBe("manual");
    expect(manual.box.center).toEqual([1, 2, 3]);
    expect(manual.box.blendDistance).toBe(0.5);
    expect(manual.box.influenceRadius).toBe(2);
    const auto = resolveReflectionProbeBox({ sceneBounds: bounds });
    expect(auto.source).toBe("scene-bounds");
    expect(auto.box.center).toEqual([0, 0.75, 0]);
    expect(auto.box.halfExtents).toEqual([8, 2.25, 8]);
    const shrunk = resolveReflectionProbeBox({ sceneBounds: bounds, autoScale: 0.5 });
    expect(shrunk.box.halfExtents).toEqual([4, 1.125, 4]);
    expect(() => resolveReflectionProbeBox({ sceneBounds: null })).toThrow(RangeError);
    expect(() => resolveReflectionProbeBox({ sceneBounds: bounds, autoScale: 1.5 })).toThrow(RangeError);
  });

  it("selects the pair: top-two by influence weight, normalized, single-probe degenerate", () => {
    const roomB = { ...ROOM, center: [6, 0, 0] as const };
    const overlap = selectReflectionProbePair([1.5, 0, 0], [ROOM, roomB]);
    expect(overlap.primary).toBe(0);
    expect(overlap.secondary).toBe(1);
    expect(overlap.weights).toEqual([0.5, 0.5]);
    const onlyB = selectReflectionProbePair([10, 0, 0], [ROOM, roomB]);
    expect(onlyB.primary).toBe(1);
    expect(onlyB.secondary).toBeUndefined();
    expect(onlyB.weights).toEqual([1, 0]);
    const nowhere = selectReflectionProbePair([50, 0, 0], [ROOM, roomB]);
    expect(nowhere.primary).toBe(-1);
    expect(nowhere.weights).toEqual([0, 0]);
  });

  it("quantifies: planar error grows to 61.5deg while box projection stays exact on-wall", () => {
    const sweep = roomParallaxCases(ROOM, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5])
      .map(item => measureReflectionParallaxCase(item));
    // 构造性成立域:盒投影逐用例误差恰为 0(GT 与盒投影共享同一求交式)。
    for (const metrics of sweep) {
      expect(metrics.constructive).toBe(true);
      expect(metrics.uncorrected).toBe(false);
      expect(metrics.boxAngularErrorDeg).toBe(0);
      expect(metrics.boxPixelDisplacement).toBe(0);
    }
    // 平面(现状)误差单调上涨:0 → 61.5044°(tsx 实跑),像素位移过千。
    expect(sweep[0]!.planarAngularErrorDeg).toBe(0);
    let previous = -1;
    for (const metrics of sweep) {
      expect(metrics.planarAngularErrorDeg).toBeGreaterThanOrEqual(previous);
      previous = metrics.planarAngularErrorDeg;
    }
    expect(sweep[1]!.planarAngularErrorDeg).toBeCloseTo(11.3099, 3);
    const worst = sweep[sweep.length - 1]!;
    expect(worst.planarAngularErrorDeg).toBeCloseTo(61.5044, 3);
    expect(worst.planarPixelDisplacement).toBeCloseTo(1107.1, 0);
    expect(worst.improvementFactor).toBe(Infinity);
  });

  it("quantifies the honest boundary: far content beyond the influence volume degrades", () => {
    // 内容位于影响体外 30m(如窗外远景):盒投影把它压到盒面,方向误差反而大于平面。
    // 这是构造性成立域的另一面——盒投影的成立域就是影响体表面,也是"AABB 须贴合
    // 主导几何(手置/autoScale)"的量化依据;钉死为文档化行为,防止误当免费午餐。
    const far = roomParallaxCases(ROOM, [1, 2, 3.5], { contentDistance: 30 })
      .map(item => measureReflectionParallaxCase(item));
    for (const metrics of far) {
      expect(metrics.constructive).toBe(false);
      expect(metrics.boxAngularErrorDeg).toBeGreaterThan(metrics.planarAngularErrorDeg);
      expect(metrics.improvementFactor).toBeLessThan(0.2);
    }
    expect(far[0]!.planarAngularErrorDeg).toBeCloseTo(1.8844, 3);
    expect(far[0]!.boxAngularErrorDeg).toBeCloseTo(20.7355, 3);
  });

  it("locks the pixel-displacement convention against the default viewport", () => {
    expect(DEEP_REFLECTION_PARALLAX_DEFAULT_VIEWPORT).toEqual({ width: 1920, height: 1080, verticalFovDegrees: 60 });
    const metrics = measureReflectionParallaxCase({
      name: "lock", probe: ROOM, worldPosition: [2, 0, 0], normal: [0, 1, 0],
      viewDirection: [0.2, 0.6, 0.8],
    });
    const radPerPx = 60 * Math.PI / 180 / 1080;
    expect(metrics.planarPixelDisplacement)
      .toBeCloseTo(metrics.planarAngularErrorDeg * Math.PI / 180 / radPerPx, 9);
  });
});
