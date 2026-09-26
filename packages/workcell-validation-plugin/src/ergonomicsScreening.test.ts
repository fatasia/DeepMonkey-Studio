import type { WorkcellAuditObject, WorkcellErgonomicsProfile } from "@bim-studio/contracts";
import { validateCapabilityValue } from "@bim-studio/plugin-runtime";
import { describe, expect, it } from "vitest";
import { analyzeHumanErgonomics } from "./ergonomicsScreening.js";
import { createHumanPercentileFigure } from "./standardScores.js";
import { workcellAuditInputSchema } from "./workcellSchemas.js";

describe("human work planning screening", () => {
  it("keeps an unconfigured person in needs-data without population defaults", () => {
    const [check] = analyzeHumanErgonomics([{ id: "human-1", name: "人工装配", operatorObjectId: "person-1" }], objects());

    expect(check).toMatchObject({
      status: "needs-data",
      missingFields: expect.arrayContaining(["anthropometry-method", "stature", "work-point", "load-mass", "maximum-load"]),
      rules: expect.arrayContaining([expect.objectContaining({ id: "shoulder-reach", status: "needs-data" })]),
    });
    expect(check?.rules.some((item) => item.measuredValue === 0)).toBe(false);
  });

  it("returns pass and warning at explicit policy boundaries", () => {
    const profile = completeProfile();
    const passed = analyzeHumanErgonomics([profile], objects())[0]!;
    expect(passed.status).toBe("pass");
    expect(passed.evidenceCoverage).toBe(1);

    profile.task!.loadMassKg = 8;
    const warned = analyzeHumanErgonomics([profile], objects())[0]!;
    expect(warned.status).toBe("warn");
    expect(warned.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "manual-load", status: "warn", utilization: .8 }),
    ]));
  });

  it("keeps a proven reach or handling failure blocking when other evidence is missing", () => {
    const profile = completeProfile();
    profile.task!.loadMassKg = 12;
    delete profile.task!.durationMinutes;
    const result = analyzeHumanErgonomics([profile], objects())[0]!;

    expect(result.status).toBe("fail");
    expect(result.missingFields).toContain("duration");
    expect(result.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "manual-load", status: "fail" }),
    ]));
  });

  it("does not accept the operator object itself as a work point", () => {
    const profile = completeProfile();
    profile.task!.workPointObjectId = profile.operatorObjectId;
    const result = analyzeHumanErgonomics([profile], objects())[0]!;

    expect(result.status).toBe("needs-data");
    expect(result.missingFields).toContain("work-point");
    expect(result.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "shoulder-reach", status: "needs-data" }),
    ]));
  });

  it("requires references for imported evidence and rejects invalid numeric inputs at the schema boundary", () => {
    const profile = completeProfile();
    profile.anthropometry!.source = "imported";
    expect(analyzeHumanErgonomics([profile], objects())[0]?.missingFields).toContain("anthropometry-reference");
    const input = { sceneId: "scene", objects: objects(), ergonomicsProfiles: [completeProfile()] };
    expect(validateCapabilityValue(workcellAuditInputSchema, input)).toEqual([]);
    input.ergonomicsProfiles[0]!.policy!.warningUtilizationRatio = 1.2;
    expect(validateCapabilityValue(workcellAuditInputSchema, input)).not.toEqual([]);
  });
});

describe("standard score layer (incremental, optional inputs)", () => {
  it("attaches NIOSH LI and OWAS category without changing existing rule semantics", () => {
    const profile = completeProfile();
    const check = analyzeHumanErgonomics(
      [profile],
      objects(),
      {
        humanFigure: createHumanPercentileFigure("ANSUR-II", 50, "male"),
        nioshLifting: { travelCm: 50 },
        owasPosture: { back: 2, arm: 1, leg: 1 },
      },
    )[0]!;

    // 场景推导:H=作业点水平距 0.35m→35cm;V=作业点高 1.08m→108cm;F=30 次/时→0.5;
    // 时长 45 分→short;耦合缺省 fair。RWL = 23×(25/35)×0.901×0.91×0.97×1.00 = 13.07 kg。
    expect(check.nioshLifting?.multipliers).toMatchObject({ hm: 0.7143, vm: 0.901, dm: 0.91, am: 1, fm: 0.97, cm: 1 });
    expect(check.nioshLifting?.recommendedWeightLimitKg).toBe(13.07);
    expect(check.nioshLifting?.liftingIndex).toBe(0.31);
    // OWAS 载荷缺省取任务载荷 4kg → 载荷组 1;弯背/双臂低/坐姿 → AC2。
    expect(check.owasPosture?.code).toBe("2111");
    expect(check.owasPosture?.actionCategory).toBe(2);
    expect(check.humanFigureApplied?.segmentLengthsMm.statureMm).toBe(1756);
    expect(check.declaration).toContain("标准分数层");

    // 既有字段语义不变:规则数量、覆盖度与状态完全由原逻辑决定。
    expect(check.rules).toHaveLength(7);
    expect(check.status).toBe("pass");
    expect(check.evidenceCoverage).toBe(1);
    expect(check.missingFields).toEqual([]);
  });

  it("does not invent a NIOSH result when the travel distance is not provided", () => {
    const check = analyzeHumanErgonomics([completeProfile()], objects(), { nioshLifting: {} })[0]!;
    expect(check.nioshLifting).toBeUndefined();
  });

  it("falls back to the percentile figure knuckle height for V when no operator is bound", () => {
    const profile: WorkcellErgonomicsProfile = {
      id: "human-2",
      name: "未绑定操作员",
      task: { workPoint: { x: 1, y: 1, z: 0 }, loadMassKg: 10, repetitionsPerHour: 120, durationMinutes: 90, source: "author-confirmed" },
    };
    const check = analyzeHumanErgonomics(
      [profile],
      objects(),
      { humanFigure: createHumanPercentileFigure("ANSUR-II", 50, "male"), nioshLifting: { horizontalCm: 30, travelCm: 40 } },
    )[0]!;
    // V 取 P50 男性指关节高 662mm→66.2cm;F=2、时长 90 分→moderate(V<75)。
    // RWL = 23×(25/30)×0.9736×0.9325×0.84×0.95 = 13.89 kg。
    expect(check.nioshLifting?.multipliers.vm).toBe(0.9736);
    expect(check.nioshLifting?.multipliers.fm).toBe(0.84);
    expect(check.nioshLifting?.recommendedWeightLimitKg).toBe(13.89);
    expect(check.nioshLifting?.liftingIndex).toBe(0.72);
  });

  it("keeps the legacy declaration and omits score fields when no options are given", () => {
    const check = analyzeHumanErgonomics([completeProfile()], objects())[0]!;
    expect(check.nioshLifting).toBeUndefined();
    expect(check.owasPosture).toBeUndefined();
    expect(check.humanFigureApplied).toBeUndefined();
    expect(check.declaration).toContain("不输出 NIOSH");
  });
});

function completeProfile(): WorkcellErgonomicsProfile {
  return {
    id: "human-1", name: "人工装配", operatorObjectId: "person-1",
    anthropometry: {
      method: "percentile", percentile: 50, statureMeters: 1.72, shoulderHeightMeters: 1.42,
      elbowHeightMeters: 1.08, functionalReachMeters: .75, source: "author-confirmed",
    },
    task: {
      workPointObjectId: "station-1", loadMassKg: 4, repetitionsPerHour: 30,
      durationMinutes: 45, source: "author-confirmed",
    },
    policy: {
      maximumLoadKg: 10, maximumRepetitionsPerHour: 60, maximumDurationMinutes: 60,
      neutralHeightToleranceMeters: .3, warningUtilizationRatio: .8, source: "author-confirmed",
    },
  };
}

function objects(): WorkcellAuditObject[] {
  return [
    { id: "person-1", name: "操作员", role: "equipment", position: { x: 0, y: 0, z: 0 } },
    { id: "station-1", name: "装配点", role: "target", position: { x: .35, y: 1.08, z: 0 } },
  ];
}
