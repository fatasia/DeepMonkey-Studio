import { describe, expect, it } from "vitest";
import { collectStartupEvidence } from "./startupEvidence.js";
import { markStartup, resetStartupTimelineForTest } from "./startupTimeline.js";

function fakeClock(entries: { name: string; startTime: number }[]) {
  return Object.assign(
    { timeOrigin: 1_000, now: () => 5_000,
      getEntriesByType: (type: string) => (type === "mark" ? entries : []) as never,
      getEntriesByName: (name: string) => entries.filter(entry => entry.name === name) as never },
  ) as unknown as Performance;
}

describe("startup evidence", () => {
  it("assembles marks with time-origin offsets and measured spans", () => {
    resetStartupTimelineForTest();
    markStartup("bootstrap-start");
    markStartup("studio-render-start");
    markStartup("editor-interactive");
    const clock = fakeClock([
      { name: "bootstrap-start", startTime: 10 },
      { name: "studio-render-start", startTime: 232.5 },
      { name: "editor-interactive", startTime: 500 },
    ]);
    const evidence = collectStartupEvidence(clock);
    expect(evidence.schema).toBe("deep-monkey.startup-evidence.v1");
    expect(evidence.marks.map(mark => mark.name)).toEqual(
      ["bootstrap-start", "studio-render-start", "editor-interactive"]);
    expect(evidence.marks[0]!.offsetMs).toBe(10);
    expect(evidence.spans.map(span => span.name)).toEqual(
      ["startup.bootstrap-to-render", "startup.render-to-interactive"]);
    expect(evidence.spans[0]!.durationMs).toBeCloseTo(222.5, 6);
    expect(evidence.capturedAtMs).toBe(6_000);
  });

  it("emits JSON-serializable payloads for evidence collection", () => {
    resetStartupTimelineForTest();
    markStartup("bootstrap-start");
    const evidence = collectStartupEvidence(fakeClock([{ name: "bootstrap-start", startTime: 1 }]));
    expect(JSON.parse(JSON.stringify(evidence))).toMatchObject({ schema: "deep-monkey.startup-evidence.v1" });
  });
});
