import { describe, expect, it } from "vitest";
import { computePbrFrameExecutionCoverage } from "./pbrFrameExecutionCoverage.js";
import { buildPbrFrameExecutionPlan } from "./pbrFramePlanExecutor.js";

const SURFACE = Object.freeze({ width: 1920, height: 1080 });
const plan = (transparency: boolean) => buildPbrFrameExecutionPlan(SURFACE, { transparency });

describe("pbr frame execution coverage", () => {
  it("computes the registered-vs-executed diff for a fully executed frame", () => {
    const subject = plan(false);
    const executed = new Set(subject.mappedPassIds);
    const coverage = computePbrFrameExecutionCoverage(subject, executed, 7);
    expect(coverage.frame).toBe(7);
    expect(coverage.planHash).toBe(subject.planHash);
    expect(coverage.registeredPassCount).toBe(subject.passOrder.length);
    expect(coverage.mappedPassCount).toBe(subject.mappedPassIds.length);
    expect(coverage.executedPassCount).toBe(executed.size);
    expect(coverage.notExecutedMappedPassIds).toEqual([]);
    expect(coverage.executedCoverageRatio).toBeCloseTo(executed.size / subject.passOrder.length, 12);
  });

  it("surfaces directClear-style partial execution as an explicit not-executed list, never as full coverage", () => {
    const subject = plan(false);
    const executed = new Set(["opaque", "present"]);
    const coverage = computePbrFrameExecutionCoverage(subject, executed, 1);
    expect(coverage.executedPassCount).toBe(2);
    for (const passId of ["opaque", "present"]) {
      expect(coverage.notExecutedMappedPassIds).not.toContain(passId);
    }
    expect(coverage.notExecutedMappedPassIds.length)
      .toBe(subject.mappedPassIds.length - executed.size);
    expect(coverage.executedCoverageRatio).toBeCloseTo(2 / subject.passOrder.length, 12);
    // 未映射槽位保留在差集读数之外(它们由 unmappedPassIds 单独披露),但计入登记分母。
    for (const passId of subject.unmappedPassIds) {
      expect(coverage.notExecutedMappedPassIds).not.toContain(passId);
      expect(subject.passOrder).toContain(passId);
    }
  });

  it("is frozen and stable across repeated computation of the same inputs", () => {
    const subject = plan(true);
    const executed = new Set(subject.mappedPassIds);
    const first = computePbrFrameExecutionCoverage(subject, executed, 3);
    const second = computePbrFrameExecutionCoverage(subject, executed, 3);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.notExecutedMappedPassIds)).toBe(true);
  });

  it("fail-closed rejects executed passes outside the mapped set", () => {
    const subject = plan(false);
    expect(() => computePbrFrameExecutionCoverage(subject, new Set(["opaque", "not-a-plan-pass"]), 0))
      .toThrow(/not-a-plan-pass/);
  });

  it("fail-closed rejects non-integer or negative frames", () => {
    const subject = plan(false);
    const executed = new Set<string>();
    expect(() => computePbrFrameExecutionCoverage(subject, executed, -1)).toThrow(RangeError);
    expect(() => computePbrFrameExecutionCoverage(subject, executed, 1.5)).toThrow(RangeError);
  });
});
