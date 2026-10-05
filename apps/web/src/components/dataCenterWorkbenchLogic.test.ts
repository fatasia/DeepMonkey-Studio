import { describe, expect, it } from "vitest";
import type { DataConnectorDiagnostics, DataDatasetField } from "@bim-studio/contracts";
import {
  connectorTrendBars,
  dataCenterStepStates,
  datasetFieldStats,
  DATA_CENTER_STEP_ORDER,
  pushConnectorSample,
  visibleRowRange,
} from "./dataCenterWorkbenchLogic";

describe("dataCenterStepStates(四步向导三态)", () => {
  it("有产出=完成,零产出=未完成,未清点=未知(不谎报)", () => {
    const steps = dataCenterStepStates({ connect: 2, transform: 0, publish: undefined, semantic: undefined });
    expect(steps.connect.done).toBe(true);
    expect(steps.transform.done).toBe(false);
    expect(steps.publish.done).toBeUndefined();
    expect(steps.semantic.count).toBeUndefined();
    expect(DATA_CENTER_STEP_ORDER).toEqual(["connect", "transform", "publish", "semantic"]);
  });
});

describe("pushConnectorSample / connectorTrendBars(迷你趋势标定)", () => {
  const diagnostics = (latencyMs: number | undefined, failures: number, consecutive = 0): DataConnectorDiagnostics => ({
    connectionId: "c1", projectId: "p1", type: "postgresql", status: "healthy",
    totalReads: 1, totalWrites: 0, totalFailures: failures, consecutiveFailures: consecutive, reconnects: 0, ...(latencyMs !== undefined ? { lastLatencyMs: latencyMs } : {}),
  });
  it("追加采样截断窗口,同刻覆盖(幂等)", () => {
    let samples = pushConnectorSample([], diagnostics(10, 0), "2026-10-05T00:00:00.000Z");
    samples = pushConnectorSample(samples, diagnostics(20, 0), "2026-10-05T00:01:00.000Z");
    samples = pushConnectorSample(samples, diagnostics(30, 0), "2026-10-05T00:01:00.000Z");
    expect(samples).toHaveLength(2);
    expect(samples[1]!.latencyMs).toBe(30);
    for (let i = 0; i < 30; i++) samples = pushConnectorSample(samples, diagnostics(i, 0), `2026-10-05T00:0${i % 10}:00.000Z`);
    expect(samples.length).toBeLessThanOrEqual(16);
  });
  it("失败标记取连续失败(累计值不作本快照判据);延迟柱归一化且零延迟给最小可见高", () => {
    const samples = [...pushConnectorSample([], diagnostics(50, 9, 2), "t1"), ...pushConnectorSample([], diagnostics(0, 9, 0), "t2")];
    const bars = connectorTrendBars(samples);
    expect(bars[0]!.failures).toBe(2); // 连续失败 2 → 红柱
    expect(bars[1]!.failures).toBe(0); // 累计失败 9 但连击已清零 → 不染红
    expect(bars[0]!.latency).toBe(1);
    expect(bars[1]!.latency).toBeGreaterThan(0);
    expect(bars[1]!.latency).toBeLessThan(0.1);
  });
});

describe("datasetFieldStats(类型徽章/样例值/空值率)", () => {
  const fields: DataDatasetField[] = [
    { key: "device_id", label: "设备", type: "string" },
    { key: "temperature", label: "温度", type: "number", unit: "°C" },
  ];
  it("空值率按行集合计算,样例取首个非空值;无行时不谎报 0%", () => {
    const stats = datasetFieldStats(fields, [
      { device_id: "Dev001", temperature: 42.5 },
      { device_id: null, temperature: undefined },
      { device_id: "Dev003", temperature: "" },
    ]);
    expect(stats[0]!.nullRate).toBeCloseTo(1 / 3);
    expect(stats[0]!.sample).toBe("Dev001");
    expect(stats[1]!.nullRate).toBeCloseTo(2 / 3); // undefined 与 "" 都按空值计
    expect(stats[1]!.sample).toBe("42.5");
    const empty = datasetFieldStats(fields, []);
    expect(empty[0]!.nullRate).toBeUndefined();
    expect(empty[0]!.sample).toBe("");
  });
});

describe("visibleRowRange(虚拟滚动行窗)", () => {
  it("含 overscan、越界收口,空表给空窗", () => {
    const mid = visibleRowRange({ scrollTop: 340, viewportHeight: 340, total: 100 });
    expect(mid.start).toBe(4); // 340/34=10, -6 overscan
    expect(mid.end).toBeLessThanOrEqual(100);
    expect(mid.end - mid.start).toBeGreaterThanOrEqual(Math.ceil(340 / 34));
    const top = visibleRowRange({ scrollTop: 0, viewportHeight: 340, total: 5 });
    expect(top).toEqual({ start: 0, end: 5 });
    const huge = visibleRowRange({ scrollTop: 99999, viewportHeight: 340, total: 10 });
    expect(huge.end).toBe(10);
    expect(visibleRowRange({ scrollTop: 0, viewportHeight: 0, total: 10 })).toEqual({ start: 0, end: 0 });
    expect(visibleRowRange({ scrollTop: 0, viewportHeight: 340, total: 0 })).toEqual({ start: 0, end: 0 });
  });
});
