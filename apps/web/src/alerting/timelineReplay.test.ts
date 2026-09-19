import { describe, expect, it } from "vitest";
import { AlertEngine } from "./alertEngine";
import { normalizeTimeline, TimelineReplay } from "./timelineReplay";

const ENTRIES = [
  { at: 0, values: { temp: 20, press: 0.5 } },
  { at: 10_000, values: { temp: 85, press: 0.4 } },
  { at: 20_000, values: { temp: 70, press: 0.1 } },
  { at: 30_000, values: { temp: 60, press: 0.5 } },
];

describe("timeline replay (P4 slice)", () => {
  it("normalizes out-of-order entries keeping the last write per timestamp", () => {
    const normalized = normalizeTimeline([
      { at: 20_000, values: { temp: 1 } },
      { at: 10_000, values: { temp: 2 } },
      { at: 20_000, values: { temp: 3 } },
    ]);
    expect(normalized.map((entry) => [entry.at, entry.values.temp])).toEqual([[10_000, 2], [20_000, 3]]);
  });

  it("holds step values between samples by default", () => {
    const replay = new TimelineReplay({ revision: "rev-7", entries: ENTRIES });
    replay.seek(15_000);
    expect(replay.sampleAt(15_000)?.values.temp).toBe(85);
    expect(replay.sampleAt(19_999)?.values.press).toBe(0.4);
    expect(replay.revisionId).toBe("rev-7");
  });

  it("interpolates linearly when requested", () => {
    const replay = new TimelineReplay({ revision: "rev-7", entries: ENTRIES }, { interpolation: "linear" });
    replay.seek(15_000);
    expect(replay.sampleAt(15_000)?.values.temp).toBeCloseTo(77.5, 5);
  });

  it("drives the playhead with speed and stops at the end", () => {
    const replay = new TimelineReplay({ revision: "rev-7", entries: ENTRIES });
    replay.play(4);
    expect(replay.advance(2_000)?.values.temp).toBe(20); // 0+2000×4=8s → 仍第一段 hold
    expect(replay.advance(1_000)?.values.temp).toBe(85); // 12s
    expect(replay.clock.playheadMs).toBe(12_000);
    replay.seek(29_000);
    replay.advance(2_000);
    expect(replay.clock.playing).toBe(false);
    expect(replay.clock.playheadMs).toBe(30_000);
  });

  it("feeds AlertEngine for replay-period alarm reproduction", () => {
    const engine = new AlertEngine([
      { id: "temp-high", label: "温度越限", signalId: "temp", kind: "threshold-above", threshold: 80, severity: "alarm" },
    ]);
    const replay = new TimelineReplay({ revision: "rev-7", entries: ENTRIES });
    replay.play(1);
    replay.seek(0);
    const events = [];
    for (let wall = 0; wall < 30_000; wall += 5_000) {
      const sample = replay.advance(5_000);
      if (sample) events.push(...engine.evaluate(sample));
    }
    expect(events.map((event) => `${event.type}@${event.at}`)).toEqual(["active@16000", "cleared@30000"]);
  });

  it("honors edgeBehavior=none outside the range", () => {
    const replay = new TimelineReplay({ revision: "rev-7", entries: ENTRIES }, { edgeBehavior: "none" });
    replay.seek(-5_000);
    expect(replay.sampleAt(-5_000)).toBeNull();
    replay.seek(99_000);
    expect(replay.sampleAt(99_000)).toBeNull();
  });
});
