import { describe, expect, it } from "vitest";
import { AlertEngine, type AlertRule } from "./alertEngine";

const RULES: AlertRule[] = [
  { id: "temp-high", label: "轴承温度越限", signalId: "bearing-temp", kind: "threshold-above", threshold: 80, severity: "alarm", hysteresis: 5 },
  { id: "press-low", label: "油压过低", signalId: "oil-press", kind: "threshold-below", threshold: 0.2, severity: "warning" },
];

describe("alert engine (P3 slice)", () => {
  it("fires once on crossing, not on every violating sample", () => {
    const engine = new AlertEngine(RULES);
    expect(engine.evaluate({ values: { "bearing-temp": 70 }, at: 1000 })).toHaveLength(0);
    const fired = engine.evaluate({ values: { "bearing-temp": 85 }, at: 2000 });
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ type: "active", ruleId: "temp-high", severity: "alarm", value: 85 });
    expect(engine.evaluate({ values: { "bearing-temp": 86 }, at: 3000 })).toHaveLength(0);
    expect(engine.evaluate({ values: { "bearing-temp": 90 }, at: 4000 })).toHaveLength(0);
  });

  it("hysteresis prevents flapping near the threshold", () => {
    const engine = new AlertEngine(RULES);
    engine.evaluate({ values: { "bearing-temp": 85 }, at: 1000 });
    // 85→76：仍高于清除线（80−5），不得清除
    expect(engine.evaluate({ values: { "bearing-temp": 76 }, at: 2000 })).toHaveLength(0);
    expect(engine.snapshot()[0]?.status).toBe("active");
    // 75：达到清除线，清除
    const cleared = engine.evaluate({ values: { "bearing-temp": 75 }, at: 3000 });
    expect(cleared[0]?.type).toBe("cleared");
    expect(engine.snapshot()[0]?.status).toBe("cleared");
  });

  it("supports acknowledge lifecycle and keeps it across continued violation", () => {
    const engine = new AlertEngine(RULES);
    engine.evaluate({ values: { "bearing-temp": 90 }, at: 1000 });
    expect(engine.acknowledge("temp-high", 1500)).toBe(true);
    expect(engine.acknowledge("temp-high", 1600)).toBe(false);
    expect(engine.evaluate({ values: { "bearing-temp": 95 }, at: 2000 })).toHaveLength(0);
    expect(engine.snapshot()[0]).toMatchObject({ status: "acknowledged", acknowledgedAt: 1500 });
  });

  it("evaluates below-threshold rules with hysteresis-free recovery", () => {
    const engine = new AlertEngine(RULES);
    expect(engine.evaluate({ values: { "oil-press": 0.1 }, at: 1000 })[0]?.type).toBe("active");
    expect(engine.evaluate({ values: { "oil-press": 0.3 }, at: 2000 })[0]?.type).toBe("cleared");
  });

  it("handles missing signals explicitly: holds state, clears after stale window", () => {
    const engine = new AlertEngine(RULES, { staleAfterMs: 5000 });
    engine.evaluate({ values: { "bearing-temp": 90 }, at: 1000 });
    // 缺信号但未超时：保持 active，无事件
    expect(engine.evaluate({ values: {}, at: 3000 })).toHaveLength(0);
    expect(engine.snapshot()[0]?.status).toBe("active");
    // 超时：显式清除并留痕（value=null）
    const cleared = engine.evaluate({ values: {}, at: 7000 });
    expect(cleared[0]).toMatchObject({ type: "cleared", ruleId: "temp-high", value: null });
  });

  it("lastValue survives as evidence after clear", () => {
    const engine = new AlertEngine(RULES);
    engine.evaluate({ values: { "bearing-temp": 85 }, at: 1000 });
    engine.evaluate({ values: { "bearing-temp": 70 }, at: 2000 });
    expect(engine.snapshot()[0]).toMatchObject({ status: "cleared", lastValue: 70, clearedAt: 2000 });
  });
});
