import { describe, expect, it } from "vitest";
import {
  DISABLED_QUALITY_TELEMETRY_SNAPSHOT,
  QUALITY_TELEMETRY_SCHEMA,
  QualityTelemetryCollector,
  type QualityFrameRecord,
} from "./qualityTelemetry.js";

function record(overrides: Partial<QualityFrameRecord> = {}): QualityFrameRecord {
  return {
    frame: 1, passCount: 7, uploadedBytes: 128,
    visibleInstances: 900, activeProfile: "quality", adaptiveDecisions: 0,
    ...overrides,
  };
}

describe("QualityTelemetryCollector", () => {
  it("returns one identical frozen constant while disabled, without recording anything", () => {
    const collector = new QualityTelemetryCollector(16, false);
    for (let frame = 0; frame < 100; frame++) {
      collector.record(record({ frame, passCount: -1, activeProfile: "cinematic" as never }));
    }
    // 关闭态:入口即返回,非法字段也不触发校验/格式化;快照恒为同一冻结常量。
    expect(collector.snapshot()).toBe(DISABLED_QUALITY_TELEMETRY_SNAPSHOT);
    expect(Object.isFrozen(DISABLED_QUALITY_TELEMETRY_SNAPSHOT)).toBe(true);
    expect(DISABLED_QUALITY_TELEMETRY_SNAPSHOT).toMatchObject({
      schema: QUALITY_TELEMETRY_SCHEMA, capacity: 0, retainedFrameCount: 0,
      totals: { passCount: 0, uploadedBytes: 0, framesWithMeasuredVisibleInstances: 0 },
      frames: [],
    });
  });

  it("fails closed on invalid records while enabled", () => {
    const collector = new QualityTelemetryCollector(16, true);
    expect(() => collector.record(record({ passCount: 1.5 }))).toThrow(RangeError);
    expect(() => collector.record(record({ uploadedBytes: -1 }))).toThrow(RangeError);
    expect(() => collector.record(record({ visibleInstances: 3.5 }))).toThrow(RangeError);
    expect(() => collector.record(record({ activeProfile: "cinematic" as never }))).toThrow(RangeError);
    expect(() => collector.record(record({ frame: -2 }))).toThrow(RangeError);
    expect(collector.snapshot().retainedFrameCount).toBe(0);
  });

  it("sums totals, tracks latest profile and decisions, and reports unmeasured frames", () => {
    const collector = new QualityTelemetryCollector(16, true);
    collector.record(record({ frame: 3, passCount: 4, uploadedBytes: 100, visibleInstances: null, adaptiveDecisions: 0 }));
    collector.record(record({ frame: 1, passCount: 2, uploadedBytes: 50, visibleInstances: 10, adaptiveDecisions: 0 }));
    collector.record(record({ frame: 2, passCount: 1, uploadedBytes: 25, visibleInstances: 12, adaptiveDecisions: 1 }));
    const snapshot = collector.snapshot();
    expect(snapshot.retainedFrameCount).toBe(3);
    expect(snapshot.firstFrame).toBe(1);
    expect(snapshot.lastFrame).toBe(3);
    expect(snapshot.totals).toEqual({ passCount: 7, uploadedBytes: 175, framesWithMeasuredVisibleInstances: 2 });
    expect(snapshot.activeProfile).toBe("quality");
    expect(snapshot.adaptiveDecisions).toBe(0);
    expect(snapshot.frames.map(frame => frame.frame)).toEqual([1, 2, 3]);
  });

  it("evicts oldest frames beyond capacity and rejects late arrivals after eviction", () => {
    const collector = new QualityTelemetryCollector(16, true);
    for (let frame = 0; frame < 20; frame++) collector.record(record({ frame, passCount: 1 }));
    let snapshot = collector.snapshot();
    expect(snapshot.retainedFrameCount).toBe(16);
    expect(snapshot.firstFrame).toBe(4);
    expect(snapshot.totals.passCount).toBe(20);
    expect(() => collector.record(record({ frame: 4 }))).toThrow(/recorded frame 4/);
    collector.reset();
    snapshot = collector.snapshot();
    expect(snapshot.retainedFrameCount).toBe(0);
    expect(snapshot.totals.passCount).toBe(0);
    expect(() => collector.record(record({ frame: 5 }))).toThrow(/evicted/);
    collector.record(record({ frame: 20 }));
    expect(() => collector.record(record({ frame: 20 }))).toThrow(/recorded frame 20/);
  });

  it("rejects capacity outside the bounded diagnostic range", () => {
    expect(() => new QualityTelemetryCollector(8, true)).toThrow(RangeError);
    expect(() => new QualityTelemetryCollector(4097, true)).toThrow(RangeError);
  });
});
