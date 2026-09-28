import { describe, expect, it } from "vitest";
import { comparePoseSeries, DEFAULT_POSE_COMPARE_TOLERANCE } from "./physicsPoseCompare";
import type { ParsedPoseSeries } from "./physicsPoseRecorder";

const q = (yaw: number): [number, number, number, number] => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];

const series = (
  end: string,
  frames: Array<Record<string, { p: [number, number, number]; q: [number, number, number, number] }>>,
): ParsedPoseSeries => {
  const bodies = Object.keys(frames[0] ?? {});
  return {
    end,
    steps: frames.length,
    bodies,
    fixedStepSeconds: 1 / 60,
    frames: frames.map((frame, index) => ({
      step: index + 1,
      bodies: bodies.map((id) => ({ id, p: frame[id]!.p, q: frame[id]!.q })),
    })),
    source: `${end}.json`,
  };
};

describe("comparePoseSeries", () => {
  it("逐位相同的两序列全零差且无超差", () => {
    const a = series("web", [{ b1: { p: [0, 0, 0], q: q(0) } }, { b1: { p: [0.1, 0, 0], q: q(0.1) } }]);
    const result = comparePoseSeries(a, structuredClone(a));
    expect(result.stepsCompared).toBe(2);
    expect(result.maxPosition).toBe(0);
    expect(result.maxRotation).toBe(0);
    expect(result.exceededStepCount).toBe(0);
    expect(result.firstExceededStep).toBeNull();
  });

  it("恒定 8 mm 位移差：默认 5 mm 容差全部超差并报告首超差步", () => {
    const a = series("web", [{ b1: { p: [0, 0, 0], q: q(0) } }, { b1: { p: [0.1, 0, 0], q: q(0) } }]);
    const b = series("native", [{ b1: { p: [0.008, 0, 0], q: q(0) } }, { b1: { p: [0.108, 0, 0], q: q(0) } }]);
    const result = comparePoseSeries(a, b);
    expect(result.maxPosition).toBeCloseTo(0.008, 12);
    expect(result.firstExceededStep).toBe(1);
    expect(result.exceededStepCount).toBe(2);
    expect(result.perStep[0]!.positionExceeded).toBe(true);
    expect(result.perStep[0]!.rotationExceeded).toBe(false);
  });

  it("旋转差按 2·acos 口径：0.03 rad 差超过 0.02 rad 默认容差", () => {
    const a = series("web", [{ b1: { p: [0, 0, 0], q: q(0.5) } }]);
    const b = series("native", [{ b1: { p: [0, 0, 0], q: q(0.53) } }]);
    const result = comparePoseSeries(a, b);
    expect(result.maxRotation).toBeCloseTo(0.03, 10);
    expect(result.perStep[0]!.rotationExceeded).toBe(true);
  });

  it("步数不同取较小值；步号错位即停（宁少比不错比）", () => {
    const a = series("web", [
      { b1: { p: [0, 0, 0], q: q(0) } },
      { b1: { p: [0.1, 0, 0], q: q(0) } },
      { b1: { p: [0.2, 0, 0], q: q(0) } },
    ]);
    const b = series("native", [{ b1: { p: [0, 0, 0], q: q(0) } }, { b1: { p: [0.1, 0, 0], q: q(0) } }]);
    expect(comparePoseSeries(a, b).stepsCompared).toBe(2);
    // B 序列步号人为改成 5,6:与 A 的 1,2 错位 → 0 帧可比。
    const bOffset: ParsedPoseSeries = { ...b, frames: b.frames.map((frame) => ({ ...frame, step: frame.step + 4 })) };
    expect(comparePoseSeries(a, bOffset).stepsCompared).toBe(0);
  });

  it("刚体清单取交集", () => {
    const a = series("web", [{ b1: { p: [0, 0, 0], q: q(0) }, only_web: { p: [9, 9, 9], q: q(0) } }]);
    const b = series("native", [{ b1: { p: [0.001, 0, 0], q: q(0) }, only_native: { p: [9, 9, 9], q: q(0) } }]);
    const result = comparePoseSeries(a, b);
    expect(result.bodies).toEqual(["b1"]);
    expect(result.maxPosition).toBeCloseTo(0.001, 12);
  });

  it("自定义容差生效", () => {
    const a = series("web", [{ b1: { p: [0, 0, 0], q: q(0) } }]);
    const b = series("native", [{ b1: { p: [0.008, 0, 0], q: q(0) } }]);
    const result = comparePoseSeries(a, b, { positionMeters: 0.01, rotationRadians: 0.02 });
    expect(result.perStep[0]!.exceeded).toBe(false);
    expect(result.tolerance.positionMeters).toBe(0.01);
  });

  it("默认容差为 T17 口径 5 mm / 0.02 rad", () => {
    expect(DEFAULT_POSE_COMPARE_TOLERANCE).toEqual({ positionMeters: 0.005, rotationRadians: 0.02 });
  });

  it("交集为空时中文报错", () => {
    const a = series("web", [{ x: { p: [0, 0, 0], q: q(0) } }]);
    const b = series("native", [{ y: { p: [0, 0, 0], q: q(0) } }]);
    expect(() => comparePoseSeries(a, b)).toThrow("共同");
  });
});
