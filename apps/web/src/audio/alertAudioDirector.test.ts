import { describe, expect, it } from "vitest";
import type { AlarmSink } from "./alertAudioDirector";
import { AlertAudioDirector } from "./alertAudioDirector";
import type { AlertEvent } from "@bim-studio/studio-core";
import { snapshotTransitionEvents, type AlarmBinding } from "./alertAudioRules";

interface RecordingSink extends AlarmSink {
  starts: string[];
  stops: string[];
}

function recordingSink(): RecordingSink {
  const sink = {
    starts: [] as string[],
    stops: [] as string[],
    startAlarm(modelId: string) { sink.starts.push(modelId); },
    stopAlarm(modelId: string) { sink.stops.push(modelId); },
  };
  return sink;
}

function alert(type: AlertEvent["type"], ruleId: string, severity: AlertEvent["severity"] = "alarm"): AlertEvent {
  return { type, ruleId, severity, value: 42, at: 1 };
}

const BINDINGS: AlarmBinding[] = [
  { modelId: "pump-01", minSeverity: "warning", ruleIds: ["pump-rule"] },
  { modelId: "area-siren", minSeverity: "alarm" },
];

describe("alert audio director (T29)", () => {
  it("routes active/cleared to the first matching binding", () => {
    const sink = recordingSink();
    const director = new AlertAudioDirector(sink, [...BINDINGS]);
    director.handleEvents([alert("active", "pump-rule")]);
    expect(sink.starts).toEqual(["pump-01"]);
    expect(director.isRinging("pump-01")).toBe(true);
    expect(director.ringingRuleId("pump-01")).toBe("pump-rule");

    director.handleEvents([alert("cleared", "pump-rule")]);
    expect(sink.stops).toEqual(["pump-01"]);
    expect(director.ringingCount).toBe(0);
  });

  it("deduplicates repeated active events to a single start", () => {
    const sink = recordingSink();
    const director = new AlertAudioDirector(sink, [...BINDINGS]);
    director.handleEvents(Array.from({ length: 10 }, () => alert("active", "pump-rule")));
    expect(sink.starts).toEqual(["pump-01"]);
    expect(sink.stops).toEqual([]);
  });

  it("keeps ringing when a non-owning rule clears, escalates silently to catch-all", () => {
    const sink = recordingSink();
    const director = new AlertAudioDirector(sink, [...BINDINGS]);
    director.handleEvents([alert("active", "pump-rule", "warning")]);
    director.handleEvents([alert("cleared", "area-rule")]);
    expect(sink.stops).toEqual([]);
    expect(director.isRinging("pump-01")).toBe(true);
  });

  it("honours severity gates and unmatched rules", () => {
    const sink = recordingSink();
    const director = new AlertAudioDirector(sink, [...BINDINGS]);
    director.handleEvents([alert("active", "pump-rule", "info")]);
    expect(sink.starts).toEqual([]);
    director.handleEvents([alert("active", "unknown-rule", "warning")]);
    expect(sink.starts).toEqual([]);
    director.handleEvents([alert("active", "unknown-rule", "alarm")]);
    expect(sink.starts).toEqual(["area-siren"]);
  });

  it("stops on acknowledge by default", () => {
    const sink = recordingSink();
    const director = new AlertAudioDirector(sink, [...BINDINGS]);
    director.handleEvents([alert("active", "pump-rule")]);
    director.handleEvents([alert("acknowledged", "pump-rule")]);
    expect(sink.stops).toEqual(["pump-01"]);
  });

  it("feeds from alert-state snapshot polling without double starts", () => {
    const sink = recordingSink();
    const director = new AlertAudioDirector(sink, [...BINDINGS]);
    const first = snapshotTransitionEvents([], [
      { ruleId: "pump-rule", label: "p", signalId: "s", severity: "alarm", status: "active", since: 0, lastValue: 9, acknowledgedAt: null, clearedAt: null },
    ], 100);
    director.handleEvents(first);
    director.handleEvents(first); // 同一批快照重复消费(轮询重放)不重复启动
    expect(sink.starts).toEqual(["pump-01"]);
    const second = snapshotTransitionEvents([
      { ruleId: "pump-rule", label: "p", signalId: "s", severity: "alarm", status: "active", since: 0, lastValue: 9, acknowledgedAt: null, clearedAt: null },
    ], [], 200);
    director.handleEvents(second);
    expect(sink.stops).toEqual(["pump-01"]);
  });

  it("dispose stops every ringing source, clears state and is idempotent", () => {
    const sink = recordingSink();
    const director = new AlertAudioDirector(sink, [...BINDINGS]);
    director.handleEvents([alert("active", "pump-rule"), alert("active", "any-rule")]);
    expect(director.ringingCount).toBe(2);
    director.dispose();
    expect([...sink.stops].sort()).toEqual(["area-siren", "pump-01"]);
    expect(director.ringingCount).toBe(0);
    director.dispose();
    expect(sink.stops).toHaveLength(2);
    director.handleEvents([alert("active", "pump-rule")]);
    expect(sink.starts).toHaveLength(2);
    expect(director.ringingCount).toBe(0);
  });

  it("survives 1000 start/stop cycles with balanced sink calls and no residue (leak proof: rules layer)", () => {
    const sink = recordingSink();
    const director = new AlertAudioDirector(sink, [...BINDINGS]);
    const active = alert("active", "pump-rule");
    const cleared = alert("cleared", "pump-rule");
    for (let cycle = 0; cycle < 1000; cycle += 1) {
      director.handleEvents([active]);
      expect(director.ringingCount).toBe(1);
      director.handleEvents([cleared]);
      expect(director.ringingCount).toBe(0);
    }
    expect(sink.starts).toHaveLength(1000);
    expect(sink.stops).toHaveLength(1000);
  });
});
