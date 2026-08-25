import { describe, expect, it } from "vitest";
import { evaluateSceneColorRules, matchesSceneColorRule, type SceneColorRule } from "./sceneColorRules";

function rule(overrides: Partial<SceneColorRule>): SceneColorRule {
  return {
    field: "status",
    operator: "equals",
    value: "running",
    color: "#22c55e",
    priority: 0,
    enabled: true,
    ...overrides
  };
}

describe("scene color rules", () => {
  it("supports equality, containment, membership, and field existence", () => {
    const data = {
      status: "running",
      label: "AGV-07 / charging",
      tags: ["robot", "charging"],
      nullable: null
    };

    expect(matchesSceneColorRule(data, rule({ operator: "equals", value: "running" }))).toBe(true);
    expect(matchesSceneColorRule(data, rule({ operator: "notEquals", value: "offline" }))).toBe(true);
    expect(matchesSceneColorRule(data, rule({ field: "label", operator: "contains", value: "AGV-07" }))).toBe(true);
    expect(matchesSceneColorRule(data, rule({ field: "tags", operator: "contains", value: "charging" }))).toBe(true);
    expect(matchesSceneColorRule(data, rule({ operator: "in", value: ["idle", "running"] }))).toBe(true);
    expect(matchesSceneColorRule(data, rule({ field: "nullable", operator: "exists" }))).toBe(true);
    expect(matchesSceneColorRule(data, rule({ field: "missing", operator: "exists" }))).toBe(false);
  });

  it("supports numeric comparisons, numeric strings, and inclusive unordered ranges", () => {
    const data = { temperature: "42.5", cycleTime: 18 };

    expect(matchesSceneColorRule(data, rule({ field: "temperature", operator: "gt", value: 40 }))).toBe(true);
    expect(matchesSceneColorRule(data, rule({ field: "temperature", operator: "gte", value: 42.5 }))).toBe(true);
    expect(matchesSceneColorRule(data, rule({ field: "temperature", operator: "lt", value: 50 }))).toBe(true);
    expect(matchesSceneColorRule(data, rule({ field: "temperature", operator: "lte", value: "42.5" }))).toBe(true);
    expect(matchesSceneColorRule(data, rule({ field: "cycleTime", operator: "between", value: [20, 10] }))).toBe(true);
    expect(matchesSceneColorRule(data, rule({ field: "cycleTime", operator: "between", value: [19, 20] }))).toBe(false);
  });

  it("resolves nested fields while preferring an exact dotted key", () => {
    const data = {
      device: { metrics: { alarm: true } },
      "device.metrics.alarm": false
    };

    expect(matchesSceneColorRule(data, rule({ field: "device.metrics.alarm", value: false }))).toBe(true);
    expect(matchesSceneColorRule({ device: { metrics: { alarm: true } } }, rule({ field: "device.metrics.alarm", value: true }))).toBe(true);
  });

  it("selects the highest priority match and keeps declaration order for ties", () => {
    const low = rule({ color: "#3b82f6", priority: 1 });
    const firstHigh = rule({ color: "#ef4444", priority: 10 });
    const secondHigh = rule({ color: "#f97316", priority: 10 });
    const disabled = rule({ color: "#000000", priority: 100, enabled: false });

    const result = evaluateSceneColorRules({ status: "running" }, [low, firstHigh, secondHigh, disabled]);

    expect(result.color).toBe("#ef4444");
    expect(result.matchedRule?.ruleIndex).toBe(1);
    expect(result.matches.map((match) => match.ruleIndex)).toEqual([1, 2, 0]);
  });

  it("ignores missing fields and malformed rules without throwing", () => {
    const throwingRecord = Object.defineProperty({}, "status", {
      enumerable: true,
      get() {
        throw new Error("untrusted getter");
      }
    });
    const malformedRules: unknown[] = [
      null,
      {},
      { ...rule({}), operator: "unknown" },
      { ...rule({}), priority: Number.NaN },
      { ...rule({}), color: "   " },
      { ...rule({ operator: "between" }), value: [1] },
      { ...rule({ operator: "in" }), value: { invalid: true } }
    ];

    expect(() => evaluateSceneColorRules(throwingRecord, [rule({}), ...malformedRules])).not.toThrow();
    expect(evaluateSceneColorRules(throwingRecord, [rule({}), ...malformedRules])).toEqual({ matches: [] });
    expect(evaluateSceneColorRules(null, malformedRules)).toEqual({ matches: [] });
    expect(evaluateSceneColorRules({ status: "running" }, null)).toEqual({ matches: [] });
    expect(matchesSceneColorRule({ other: 1 }, rule({ operator: "notEquals", value: "offline" }))).toBe(false);

    const revokedRules = Proxy.revocable<unknown[]>([], {});
    revokedRules.revoke();
    expect(() => evaluateSceneColorRules({ status: "running" }, revokedRules.proxy)).not.toThrow();
    expect(evaluateSceneColorRules({ status: "running" }, revokedRules.proxy)).toEqual({ matches: [] });
  });

  it("returns normalized serializable rule data instead of mutating input", () => {
    const source = rule({ field: " status ", color: " #22c55e ", operator: "in", value: ["running"] });
    const result = evaluateSceneColorRules({ status: "running" }, [source]);

    expect(result.matchedRule?.rule).toEqual({ ...source, field: "status", color: "#22c55e" });
    expect(result.matchedRule?.rule).not.toBe(source);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(source.field).toBe(" status ");
  });
});
