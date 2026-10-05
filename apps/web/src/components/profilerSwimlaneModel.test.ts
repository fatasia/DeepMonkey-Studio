import { describe, expect, it } from "vitest";
import {
  ProfilerSwimlaneCollector,
  buildSwimlaneView,
  type ProfilerSwimlaneSample,
} from "./profilerSwimlaneModel";

function sample(frame: number, passes: [string, number][], overrides: Partial<ProfilerSwimlaneSample> = {}): ProfilerSwimlaneSample {
  return { frame, passes: passes.map(([passId, durationMs]) => ({ passId, durationMs })), ...overrides };
}

describe("ProfilerSwimlaneCollector", () => {
  it("accepts monotonic measured frames and rejects stale or duplicate frames", () => {
    const collector = new ProfilerSwimlaneCollector();
    expect(collector.push(sample(10, [["shadow-cascades", 1]]))).toBe(true);
    expect(collector.push(sample(10, [["shadow-cascades", 1]]))).toBe(false);
    expect(collector.push(sample(9, [["shadow-cascades", 1]]))).toBe(false);
    expect(collector.push(sample(Number.NaN, []))).toBe(false);
    expect(collector.size).toBe(1);
    expect(collector.lastFrame).toBe(10);
  });

  it("keeps only the most recent capacity frames and freezes samples", () => {
    const collector = new ProfilerSwimlaneCollector({ capacity: 8 });
    for (let frame = 0; frame < 12; frame += 1) collector.push(sample(frame, [["main", 1]]));
    expect(collector.size).toBe(8);
    expect(collector.snapshot().map(entry => entry.frame)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("drops malformed pass entries instead of poisoning lanes", () => {
    const collector = new ProfilerSwimlaneCollector();
    collector.push({ frame: 1, passes: [{ passId: "", durationMs: 1 }, { passId: "main", durationMs: Number.NaN }, { passId: "main", durationMs: -2 }, { passId: "main", durationMs: 3 }] });
    expect(collector.snapshot()[0]?.passes).toEqual([{ passId: "main", durationMs: 3 }]);
  });

  it("clamps capacity into the legal range", () => {
    expect(new ProfilerSwimlaneCollector({ capacity: 1 }).capacity).toBe(8);
    expect(new ProfilerSwimlaneCollector({ capacity: 9_999 }).capacity).toBe(240);
  });

  it("clear resets the buffer and frame watermark", () => {
    const collector = new ProfilerSwimlaneCollector();
    collector.push(sample(5, [["main", 1]]));
    collector.clear();
    expect(collector.size).toBe(0);
    expect(collector.push(sample(5, [["main", 1]]))).toBe(true);
  });
});

describe("buildSwimlaneView", () => {
  it("returns an empty view for an empty window", () => {
    const view = buildSwimlaneView([]);
    expect(view.frames).toEqual([]);
    expect(view.lanes).toEqual([]);
    expect(view.mostExpensive).toBeUndefined();
    expect(view.scaleMaxMs).toBe(0);
    expect(view.rebuildIncrementCount).toBe(0);
  });

  it("orders lanes by windowed total and keeps first-seen order as tiebreak", () => {
    const view = buildSwimlaneView([
      sample(1, [["aa", 1], ["bb", 5]]),
      sample(2, [["aa", 4], ["bb", 5]]),
    ]);
    expect(view.lanes.map(lane => lane.passId)).toEqual(["bb", "aa"]);
    expect(view.lanes[0]!.totalMs).toBe(10);
    expect(view.lanes[1]!.values).toEqual([1, 4]);
  });

  it("aligns values per frame and keeps missing passes undefined, never zero", () => {
    const view = buildSwimlaneView([
      sample(1, [["main", 2], ["gi", 8]]),
      sample(2, [["main", 3]]),
    ]);
    const gi = view.lanes.find(lane => lane.passId === "gi")!;
    expect(gi.values).toEqual([8, undefined]);
    expect(gi.peakMs).toBe(8);
  });

  it("caps lanes to maxLanes and reports omitted pass kinds honestly", () => {
    const view = buildSwimlaneView([
      sample(1, [["p1", 10], ["p2", 9], ["p3", 8], ["p4", 7]]),
    ], { maxLanes: 2 });
    expect(view.lanes.map(lane => lane.passId)).toEqual(["p1", "p2"]);
    expect(view.omittedPassCount).toBe(2);
  });

  it("locates the single most expensive pass across the window", () => {
    const view = buildSwimlaneView([
      sample(1, [["main", 4], ["shadow-cascades", 9.5]]),
      sample(2, [["shadow-cascades", 2], ["bloom", 12]]),
    ]);
    expect(view.mostExpensive).toEqual({ passId: "bloom", durationMs: 12, frame: 2 });
  });

  it("marks renderer rebuild increments between aligned frames", () => {
    const view = buildSwimlaneView([
      sample(1, [["main", 1]], { rebuildTotal: 3 }),
      sample(2, [["main", 1]], { rebuildTotal: 4 }),
      sample(3, [["main", 1]], { rebuildTotal: 4 }),
      sample(4, [["main", 1]]),
      sample(5, [["main", 1]], { rebuildTotal: 6 }),
    ]);
    expect(view.rebuildMarks[1]).toEqual({ frame: 2, fromTotal: 3, toTotal: 4 });
    expect(view.rebuildMarks[2]).toBeUndefined();
    expect(view.rebuildMarks[4]).toEqual({ frame: 5, fromTotal: 4, toTotal: 6 });
    expect(view.rebuildIncrementCount).toBe(2);
  });

  it("computes gpu span / cpu rows and a shared global scale", () => {
    const view = buildSwimlaneView([
      sample(1, [["main", 2]], { gpuSpanMs: 10, cpuSubmitMs: 5 }),
      sample(2, [["main", 3]], { gpuSpanMs: 20 }),
    ]);
    expect(view.gpuSpan.values).toEqual([10, 20]);
    expect(view.gpuSpan.peakMs).toBe(20);
    expect(view.cpuSubmit.values).toEqual([5, undefined]);
    expect(view.scaleMaxMs).toBe(20);
  });

  it("ignores non-finite gpu span and cpu values", () => {
    const view = buildSwimlaneView([
      sample(1, [["main", 2]], { gpuSpanMs: Number.NaN, cpuSubmitMs: Number.POSITIVE_INFINITY }),
    ]);
    expect(view.gpuSpan.values).toEqual([undefined]);
    expect(view.cpuSubmit.values).toEqual([undefined]);
  });
});
