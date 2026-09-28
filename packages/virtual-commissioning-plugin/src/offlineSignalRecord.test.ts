import { describe, expect, it } from "vitest";
import type { DataSubscriptionStatus } from "@bim-studio/contracts";
import { describeOfflineReplay, offlineReplayToScenario } from "./offlineSignalRecord.js";
import { runVirtualDebugScenario } from "./engine.js";

const timeline = {
  revision: "dataset:line-a@2026-09-28T01:00:00Z",
  entries: [
    { at: 1_000, values: { pressure: 1 } },
    { at: 1_100, values: { pressure: 2 } },
  ],
};

const status: DataSubscriptionStatus = {
  connectionId: "p:c", projectId: "p", protocol: "opcua", lifecycle: "healthy",
  generation: 2, received: 2, published: 2, deduplicated: 0, droppedOutOfOrder: 0,
  parseFailures: 0, reconnects: 1, gapReportsTruncated: 0, lastSequence: 2,
  lastTimestamp: "2026-09-28T00:00:01.000Z", nextReconnectAt: null,
  updatedAt: "2026-09-28T00:00:01.000Z",
  gapReports: [{ id: "gap", connectionId: "p:c", fromSequence: 1, toSequence: 1,
    estimatedCount: 1, fromTime: "2026-09-28T00:00:00.000Z",
    toTime: "2026-09-28T00:00:01.000Z", sequenceKnown: true,
    detectedAt: "2026-09-28T00:00:01.000Z" }],
};

describe("offline replay projection", () => {
  it("preserves revision/gap provenance, marks OPC UA derived sequence and unknown sample quality", () => {
    const record = describeOfflineReplay({ timeline, origin: "dataset", sequenceSemantics: "estimated", status });
    expect(record).toMatchObject({ revision: timeline.revision, coverage: "gap-detected", signalQuality: "unknown",
      sequenceSemantics: "estimated", checkpoint: { connectionId: "p:c", generation: 2 },
      gaps: [{ sequenceKnown: true, estimatedCount: 1 }] });
    expect(record.samples.map((sample) => sample.quality)).toEqual(["unknown", "unknown"]);
    expect(offlineReplayToScenario(record, "case-1")).toMatchObject({
      initialSignals: { pressure: 1 }, commands: [{ atMs: 100, type: "set", key: "pressure", value: 2 }],
    });
    const result = runVirtualDebugScenario(offlineReplayToScenario(record, "case-1"));
    expect(result.trace.at(-1)?.signals.pressure).toBe(2);
    expect(result.status).toBe("passed");
    expect(timeline.entries[0].values.pressure).toBe(1);
  });

  it("does not turn missing sequence or restart state into complete history", () => {
    const record = describeOfflineReplay({ timeline, origin: "retained-events" });
    expect(record.coverage).toBe("unknown");
    expect(record.sequenceSemantics).toBe("unknown");
    expect(record.checkpoint).toBeNull();
    expect(record.gaps).toEqual([]);
    expect(describeOfflineReplay({ timeline, origin: "retained-events", status: { ...status, gapReports: [], gapReportsTruncated: 1 } }).coverage).toBe("gap-detected");
  });

  it("rejects empty, invalid, and non-tick-aligned records rather than silently dropping frames", () => {
    expect(() => describeOfflineReplay({ timeline: { ...timeline, revision: " " }, origin: "dataset" })).toThrow("revision");
    expect(() => describeOfflineReplay({ timeline: { revision: "x", entries: [{ at: 1.1, values: { a: 1 } }] }, origin: "dataset" })).toThrow("时间戳");
    expect(() => describeOfflineReplay({ timeline: { revision: "x", entries: [{ at: 1, values: { a: Number.NaN } }] }, origin: "dataset" })).toThrow("信号值");
    expect(() => describeOfflineReplay({ timeline: { revision: "x", entries: [timeline.entries[1], timeline.entries[0]] }, origin: "dataset" })).toThrow("时间倒退");
    expect(() => describeOfflineReplay({ timeline: { revision: "x", entries: [timeline.entries[0], timeline.entries[0]] }, origin: "dataset" })).toThrow("重复帧");
    const empty = describeOfflineReplay({ timeline: { revision: "x", entries: [] }, origin: "dataset" });
    expect(() => offlineReplayToScenario(empty, "case")).toThrow("没有可回放");
    const misaligned = describeOfflineReplay({ timeline: { revision: "x", entries: [{ at: 1_000, values: { a: 1 } }, { at: 1_175, values: { a: 2 } }] }, origin: "dataset" });
    expect(() => offlineReplayToScenario(misaligned, "case", 50)).toThrow("未对齐");
  });
});
