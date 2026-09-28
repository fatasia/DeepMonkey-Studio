import { describe, expect, it } from "vitest";
import { FixedStepClock, stepSimSeconds } from "./fixedStepDriver.js";
import { replayFromStep, type FixedStepSim } from "./physicsTypes.js";

class CountingSim implements FixedStepSim<{ tick: number; value: number }> {
  #tick = 0;
  #value = 0;
  step(): void {
    this.#value += 1;
    this.#tick += 1;
  }
  get tick(): number { return this.#tick; }
  get value(): number { return this.#value; }
  capture(): { tick: number; value: number } { return { tick: this.#tick, value: this.#value }; }
  restore(s: { tick: number; value: number }): void { this.#tick = s.tick; this.#value = s.value; }
}

describe("FixedStepClock 构造合同", () => {
  it("拒绝非法 hz 与追赶上限", () => {
    expect(() => new FixedStepClock({ hz: 0, maxCatchUpTicks: 4 })).toThrow(/hz/);
    expect(() => new FixedStepClock({ hz: Number.NaN, maxCatchUpTicks: 4 })).toThrow(/hz/);
    expect(() => new FixedStepClock({ hz: 60, maxCatchUpTicks: 0 })).toThrow(/maxCatchUpTicks/);
  });
});

describe("量化协议(同 T19 语义)", () => {
  it("1/60 → 1 tick;1/30 → 2 ticks;tick 计数累积", () => {
    const clock = new FixedStepClock({ hz: 60, maxCatchUpTicks: 8 });
    expect(clock.advanceSeconds(1 / 60)).toBe(1);
    expect(clock.tick).toBe(1);
    expect(clock.advanceSeconds(1 / 30)).toBe(2);
    expect(clock.tick).toBe(3);
  });

  it("dt = 0 或负值执行 0 tick;NaN 抛错", () => {
    const clock = new FixedStepClock({ hz: 60, maxCatchUpTicks: 4 });
    expect(clock.advanceSeconds(0)).toBe(0);
    expect(clock.advanceSeconds(-1 / 120)).toBe(0);
    expect(clock.tick).toBe(0);
    expect(() => clock.advanceSeconds(Number.NaN)).toThrow(/finite/);
  });

  it("非整倍帧率(1/45)整体放慢:3 帧(理想 4.8 ticks)只执行 4 ticks", () => {
    const clock = new FixedStepClock({ hz: 60, maxCatchUpTicks: 4 });
    let executed = 0;
    for (let i = 0; i < 3; i += 1) executed += clock.advanceSeconds(1 / 45);
    // 80ms/帧 × 3 = 240ms = 4.8 ticks 理想;round 量化执行 4 ticks(放慢方向)。
    expect(executed).toBe(4);
    expect(clock.tick).toBe(4);
  });

  it("追赶上限:长帧只执行上限个 tick,余量封顶不累积", () => {
    const clock = new FixedStepClock({ hz: 60, maxCatchUpTicks: 5 });
    expect(clock.advanceSeconds(1.0)).toBe(5);
    expect(clock.tick).toBe(5);
    expect(clock.pendingRemainderSeconds).toBeLessThanOrEqual(1);
  });

  it("advanceTicks 是规范驱动器;reset 归零", () => {
    const clock = new FixedStepClock({ hz: 60, maxCatchUpTicks: 4 });
    clock.advanceTicks(17);
    expect(clock.tick).toBe(17);
    expect(() => clock.advanceTicks(-1)).toThrow(/non-negative/);
    clock.reset();
    expect(clock.tick).toBe(0);
  });
});

describe("时钟 + 求解器组合与局部回放", () => {
  it("stepSimSeconds 按 tick 数驱动求解器", () => {
    const sim = new CountingSim();
    const clock = new FixedStepClock({ hz: 60, maxCatchUpTicks: 4 });
    const executed = stepSimSeconds(sim, clock, 2 / 60);
    expect(executed).toBe(2);
    expect(sim.value).toBe(2);
    expect(sim.tick).toBe(2);
  });

  it("replayFromStep:恢复快照后重放与连续运行一致", () => {
    const a = new CountingSim();
    for (let i = 0; i < 10; i += 1) a.step();
    const b = new CountingSim();
    for (let i = 0; i < 4; i += 1) b.step();
    const snapshot = b.capture();
    replayFromStep(b, snapshot, 6);
    expect(b.tick).toBe(a.tick);
    expect(b.value).toBe(a.value);
  });
});
