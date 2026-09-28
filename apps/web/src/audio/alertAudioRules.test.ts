import { describe, expect, it } from "vitest";
import type { AlertEvent, AlertStateSnapshot } from "@bim-studio/studio-core";
import {
  DEFAULT_ALARM_POLICY,
  matchesAlarmBinding,
  nextAlarmCommand,
  severityAtLeast,
  snapshotTransitionEvents,
  type AlarmBinding,
} from "./alertAudioRules";

const BINDING: AlarmBinding = { modelId: "motor-01", minSeverity: "warning", ruleIds: ["rule-a"] };
const CATCH_ALL: AlarmBinding = { modelId: "siren-01", minSeverity: "alarm" };

function event(type: AlertEvent["type"], ruleId: string, severity: AlertEvent["severity"] = "alarm"): AlertEvent {
  return { type, ruleId, severity, value: 120, at: 1000 };
}

describe("alarm command rules (T29)", () => {
  it("starts on active when idle and severity qualifies", () => {
    expect(nextAlarmCommand(event("active", "rule-a"), undefined, BINDING)).toBe("start");
  });

  it("does not restart while ringing (same or other rule)", () => {
    expect(nextAlarmCommand(event("active", "rule-a"), "rule-a", BINDING)).toBe("none");
    expect(nextAlarmCommand(event("active", "rule-b"), "rule-a", BINDING)).toBe("none");
  });

  it("gates by minimum severity", () => {
    expect(nextAlarmCommand(event("active", "rule-a", "info"), undefined, BINDING)).toBe("none");
    expect(nextAlarmCommand(event("active", "rule-a", "warning"), undefined, BINDING)).toBe("start");
  });

  it("stops on cleared only for the owning rule", () => {
    expect(nextAlarmCommand(event("cleared", "rule-a"), "rule-a", BINDING)).toBe("stop");
    expect(nextAlarmCommand(event("cleared", "rule-b"), "rule-a", BINDING)).toBe("none");
    expect(nextAlarmCommand(event("cleared", "rule-a"), undefined, BINDING)).toBe("none");
  });

  it("silences on acknowledge by default and honours the policy switch", () => {
    expect(nextAlarmCommand(event("acknowledged", "rule-a"), "rule-a", BINDING)).toBe("stop");
    expect(nextAlarmCommand(event("acknowledged", "rule-b"), "rule-a", BINDING)).toBe("none");
    expect(nextAlarmCommand(event("acknowledged", "rule-a"), "rule-a", BINDING, { silenceOnAcknowledge: false })).toBe("none");
    expect(DEFAULT_ALARM_POLICY).toEqual({ silenceOnAcknowledge: true });
  });

  it("matches bindings by rule list or catch-all", () => {
    expect(matchesAlarmBinding(BINDING, "rule-a")).toBe(true);
    expect(matchesAlarmBinding(BINDING, "rule-x")).toBe(false);
    expect(matchesAlarmBinding(CATCH_ALL, "anything")).toBe(true);
    expect(severityAtLeast("alarm", "warning")).toBe(true);
    expect(severityAtLeast("info", "warning")).toBe(false);
  });
});

function snapshot(ruleId: string, status: AlertStateSnapshot["status"], lastValue: number | null = 7): AlertStateSnapshot {
  return { ruleId, label: ruleId, signalId: `${ruleId}.signal`, severity: "alarm", status, since: 0, lastValue, acknowledgedAt: null, clearedAt: null };
}

describe("alert-state snapshot transition bridge (T29)", () => {
  it("emits active when a rule becomes non-cleared", () => {
    const events = snapshotTransitionEvents([snapshot("r1", "cleared")], [snapshot("r1", "active")], 5000);
    expect(events).toEqual([{ type: "active", ruleId: "r1", severity: "alarm", value: 7, at: 5000 }]);
  });

  it("emits cleared and acknowledged transitions, nothing on stable states", () => {
    const events = snapshotTransitionEvents(
      [snapshot("r1", "active"), snapshot("r2", "active"), snapshot("r3", "acknowledged"), snapshot("r4", "cleared")],
      [snapshot("r1", "acknowledged"), snapshot("r2", "cleared"), snapshot("r3", "acknowledged"), snapshot("r4", "cleared")],
      6000,
    );
    expect(events.map((item) => item.type)).toEqual(["acknowledged", "cleared"]);
  });

  it("treats rules missing from the next snapshot as cleared", () => {
    const events = snapshotTransitionEvents([snapshot("r1", "active"), snapshot("r2", "active")], [snapshot("r1", "active")], 7000);
    expect(events).toEqual([{ type: "cleared", ruleId: "r2", severity: "alarm", value: 7, at: 7000 }]);
  });

  it("emits active for brand-new rules and nothing for previously-absent cleared rules", () => {
    const events = snapshotTransitionEvents([], [snapshot("r9", "active"), snapshot("r8", "cleared")], 8000);
    expect(events).toEqual([{ type: "active", ruleId: "r9", severity: "alarm", value: 7, at: 8000 }]);
  });
});
