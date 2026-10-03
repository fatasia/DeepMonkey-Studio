import { describe, expect, it } from "vitest";
import { FixedStepClock } from "@bim-studio/deep-engine/physics";
import { eventRecordingFrameIndex, eventsAtFrame } from "@bim-studio/contracts";

/**
 * E3/T23-time 帧率档位对拍(2026-10-02):
 * 把 FixedStepClock 的 tick 轴与 C4 事件录制的帧轴(frameMapping)在 30/60/120Hz
 * 与非整倍帧率下的真实数值行为钉死——同 origin、同步长、同取整语义下两轴必须
 * 同构;非整倍率的长程方向(放慢/加快)以实测为准,不以注释声明为准。
 * 落点 apps/web:deep-engine 与 contracts 互不依赖(架构既定),本组合域同时消费两者。
 */

const ORIGIN_EPOCH_MS = Date.parse("2026-10-02T00:00:00.000Z");
const STEP_MS_BY_HZ = { 30: 1000 / 30, 60: 1000 / 60, 120: 1000 / 120 } as const;

function isoAt(elapsedMs: number): string {
  return new Date(ORIGIN_EPOCH_MS + elapsedMs).toISOString();
}

/** 逐帧喂真实 dt 序列,返回每帧执行的 tick 快照。 */
function driveFrames(clock: FixedStepClock, dtSeconds: number, frames: number): number[] {
  const ticks: number[] = [];
  for (let i = 0; i < frames; i += 1) ticks.push(clock.advanceSeconds(dtSeconds));
  return ticks;
}

describe("E3 帧率档位:30/60/120Hz 标准档长程对拍", () => {
  it.each([30, 60, 120] as const)("hz=%i:精确整倍 dt 长程零漂移——每帧恰 1 tick,3600 帧后余量归零", hz => {
    const clock = new FixedStepClock({ hz, maxCatchUpTicks: 8 });
    const perFrame = driveFrames(clock, 1 / hz, 3600);
    expect(perFrame.every(ticks => ticks === 1)).toBe(true);
    expect(clock.tick).toBe(3600);
    expect(clock.pendingRemainderSeconds).toBe(0);
  });

  it.each([30, 60, 120] as const)("hz=%i:±4ms 真实帧抖动流长程收敛——总 tick 误差 ≤1 tick(理想)", hz => {
    // 抖动序列确定性生成(非随机):-4..+4ms 循环,均值≈0,模拟真实帧率波动。
    const jitterMs = [-4, -2, 1, 3, -1, 2, -3, 4];
    const clock = new FixedStepClock({ hz, maxCatchUpTicks: 8 });
    let executed = 0;
    for (let frame = 0; frame < 3600; frame += 1) {
      executed += clock.advanceSeconds(1 / hz + jitterMs[frame % jitterMs.length]! / 1000);
    }
    const ideal = 3600 + (jitterMs.reduce((sum, value) => sum + value, 0) / jitterMs.length) / 1000 * hz * 3600;
    expect(Math.abs(executed - ideal)).toBeLessThanOrEqual(1);
  });

  it("hz=120:1/60 输入每帧 2 tick(半速档位整倍关系)", () => {
    const clock = new FixedStepClock({ hz: 120, maxCatchUpTicks: 8 });
    expect(driveFrames(clock, 1 / 60, 600).every(ticks => ticks === 2)).toBe(true);
    expect(clock.tick).toBe(1200);
  });
});

describe("E3 非整倍帧率:长程方向与幅度以实测为准", () => {
  it("1/45fps@60hz:round 量化长程平均=理想(每 3 帧恰 4 tick),无系统性放慢", () => {
    const clock = new FixedStepClock({ hz: 60, maxCatchUpTicks: 8 });
    const perFrame = driveFrames(clock, 1 / 45, 3000);
    // 1/45*60 = 4/3 tick/帧;round 序列 1,2,1 循环,3 帧 4 tick = 理想值。
    expect(perFrame.slice(0, 3)).toEqual([1, 2, 1]);
    expect(clock.tick).toBe(4000); // 3000 帧 × 4/3 = 4000 理想,tick 轴零漂移。
    // 余量仅供诊断(f64 累加残渣 ~1e-13),非零尾数不构成时间语义漂移。
    expect(clock.pendingRemainderSeconds).toBeLessThan(1e-9);
  });

  it("1/144fps@60hz:量化残差有界,长程偏差在 ±1 tick 内且方向由实测钉死", () => {
    const clock = new FixedStepClock({ hz: 60, maxCatchUpTicks: 8 });
    driveFrames(clock, 1 / 144, 2880); // 20s,理想 1200 tick。
    const ideal = 2880 * (60 / 144);
    expect(Math.abs(clock.tick - ideal)).toBeLessThanOrEqual(1);
    // 余量封顶合同:碎屑不会累积超过 1 tick(时间语义仍单调)。
    expect(clock.pendingRemainderSeconds).toBeLessThanOrEqual(1);
  });
});

describe("E3 事件帧轴×时钟 tick 轴同构对拍(C4 frameMapping)", () => {
  it.each([30, 60, 120] as const)("hz=%i:nearest 帧轴与时钟 round 量化同构——事件帧号=该时刻累计 tick", hz => {
    const frameStepMs = STEP_MS_BY_HZ[hz];
    const manifest = { originEpochMs: ORIGIN_EPOCH_MS, frameMapping: { frameStepMs, mode: "nearest" as const } };
    // 工业时间轴精度=毫秒(ISO 8601);采样点取整毫秒并避开 0.5 步长 round 边界,
    // 两轴消费同一毫秒值时同构性才可比。
    for (const steps of [0.3, 0.7, 1.3, 2.5, 3.9, 10.6]) {
      const elapsedMs = Math.round(steps * frameStepMs);
      const probe = new FixedStepClock({ hz, maxCatchUpTicks: 8 });
      probe.advanceTicks(Math.round(elapsedMs / 1000 * hz));
      expect(eventRecordingFrameIndex(isoAt(elapsedMs), manifest)).toBe(probe.tick);
    }
  });

  it("floor 帧轴与 nearest 的差异窗口如实钉死:0.5 步长边界两侧归属不同帧", () => {
    const frameStepMs = STEP_MS_BY_HZ[60]; // ≈16.667ms;整毫秒采样点,远离边界处语义稳定。
    const floorManifest = { originEpochMs: ORIGIN_EPOCH_MS, frameMapping: { frameStepMs, mode: "floor" as const } };
    const nearestManifest = { originEpochMs: ORIGIN_EPOCH_MS, frameMapping: { frameStepMs, mode: "nearest" as const } };
    expect(eventRecordingFrameIndex(isoAt(7), floorManifest)).toBe(0);
    expect(eventRecordingFrameIndex(isoAt(9), floorManifest)).toBe(0);
    expect(eventRecordingFrameIndex(isoAt(7), nearestManifest)).toBe(0);
    expect(eventRecordingFrameIndex(isoAt(9), nearestManifest)).toBe(1); // 9ms > 8.33ms 半步长 → 下一帧。
  });

  it("eventsAtFrame 按帧取事件:帧窗内事件齐全,窗外不串帧(60hz 档)", () => {
    const frameStepMs = STEP_MS_BY_HZ[60];
    const manifest = { originEpochMs: ORIGIN_EPOCH_MS, frameMapping: { frameStepMs, mode: "nearest" as const } };
    const entries = [
      { kind: "event", industrialTime: isoAt(0.2 * frameStepMs), sequence: 1, sequenceAssigned: true, monotonicMs: 0, event: { source: "plc", key: "in-frame-0", value: "a" } },
      { kind: "event", industrialTime: isoAt(1.4 * frameStepMs), sequence: 2, sequenceAssigned: true, monotonicMs: 1, event: { source: "plc", key: "in-frame-1", value: "b" } },
      { kind: "event", industrialTime: isoAt(2.49 * frameStepMs), sequence: 3, sequenceAssigned: true, monotonicMs: 2, event: { source: "plc", key: "near-boundary", value: "c" } },
    ] as unknown as Parameters<typeof eventsAtFrame>[0];
    expect(eventsAtFrame(entries, 0, manifest).map(item => item.event.key)).toEqual(["in-frame-0"]);
    expect(eventsAtFrame(entries, 1, manifest).map(item => item.event.key)).toEqual(["in-frame-1"]);
    expect(eventsAtFrame(entries, 2, manifest).map(item => item.event.key)).toEqual(["near-boundary"]);
  });

  it("未声明帧映射时按帧对齐 fail-closed(不退化为猜测帧号)——与时钟组合的前提声明", () => {
    const manifest = { originEpochMs: ORIGIN_EPOCH_MS, frameMapping: null };
    expect(() => eventRecordingFrameIndex(isoAt(100), manifest)).toThrow(/帧映射/);
  });
});
