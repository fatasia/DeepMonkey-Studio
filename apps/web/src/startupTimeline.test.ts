import { afterEach, describe, expect, it } from "vitest";
import { markStartup, measureStartupSpans, resetStartupTimelineForTest,
  type StartupMarkName } from "./startupTimeline";

type Recorded = { readonly name: string; readonly startTime: number };
function fakeClock(entries: readonly Recorded[]) {
  return { getEntriesByName: (name: string): PerformanceEntryList =>
    entries.filter(entry => entry.name === name) as PerformanceEntryList };
}

afterEach(() => resetStartupTimelineForTest());

describe("startup timeline", () => {
  it("measures known spans only after both marks exist", () => {
    const marks: Recorded[] = [];
    const clock = { getEntriesByName: (name: string): PerformanceEntryList =>
      marks.filter(entry => entry.name === name) as PerformanceEntryList };
    markStartup("bootstrap-start");
    expect(measureStartupSpans(clock)).toHaveLength(0);
    marks.push({ name: "bootstrap-start", startTime: 10 });
    markStartup("studio-render-start");
    expect(measureStartupSpans(clock)).toHaveLength(0);
    marks.push({ name: "studio-render-start", startTime: 222.5 });
    markStartup("editor-interactive");
    marks.push({ name: "editor-interactive", startTime: 500 });
    const spans = measureStartupSpans(clock);
    expect(spans.map(span => span.name)).toEqual(["startup.bootstrap-to-render", "startup.render-to-interactive"]);
    expect(spans[0]!.durationMs).toBeCloseTo(212.5, 6);
    expect(spans[1]!.durationMs).toBeCloseTo(277.5, 6);
  });

  it("ignores duplicate marks and never reports negative spans", () => {
    markStartup("bootstrap-start");
    markStartup("bootstrap-start");
    const clock = fakeClock([
      { name: "editor-interactive", startTime: 5 },
      { name: "bootstrap-start", startTime: 100 },
      { name: "studio-render-start", startTime: 200 },
    ]);
    const spans = measureStartupSpans(clock);
    expect(spans.every(span => span.durationMs >= 0)).toBe(true);
  });

  it("keeps the mark name set closed", () => {
    const names: readonly string[] = ["bootstrap-start", "delivery-manifest-loaded", "editor-styles-loaded",
      "studio-render-start", "scene-viewer-render-start", "editor-interactive"];
    for (const name of names) markStartup(name as StartupMarkName);
    expect(measureStartupSpans(fakeClock([])).every(span => span.name.startsWith("startup."))).toBe(true);
  });
});
