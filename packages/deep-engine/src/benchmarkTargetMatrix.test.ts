import { describe, expect, it } from "vitest";
import { createEngineTargetMatrix, evaluateEngineTargetMatrix, REQUIRED_LOAD_CLASSES, TARGET_MATRIX_SCHEMA_VERSION,
  type EngineTargetMatrix, type TargetRunEvidence } from "./benchmarkTargetMatrix";

const REFERENCES = ["three", "babylon", "unity", "ue5", "godot"] as const;

/** 六类负载全覆盖 + 各域权重精确配平(rendering20/large-scene15/material10/animation10/
 *  sim-media-xr10/editor10/gui-chart10/script-api5/native5/diagnostics5,合计 100)。 */
function matrix(reference: (typeof REFERENCES)[number], overrides: Partial<EngineTargetMatrix> = {}): EngineTargetMatrix {
  return {
    schema: "deep-engine.benchmark-target-matrix",
    schemaVersion: TARGET_MATRIX_SCHEMA_VERSION,
    reference,
    engine: { version: "2026.1.0f1", renderer: "URP", platform: "windows-x64" },
    cases: [
      { id: "case.factory-draw", track: "common-baseline", critical: true, loadClass: "factory-instances", weight: 6, domain: "rendering", quality: "equivalent" },
      { id: "case.factory-streaming", track: "common-baseline", critical: false, loadClass: "factory-instances", weight: 6, domain: "rendering", quality: "equivalent" },
      { id: "case.rendering-best", track: "best-quality", critical: false, loadClass: "appearance-showcase", weight: 8, domain: "rendering", quality: "best" },
      { id: "case.bim-heterogeneous", track: "common-baseline", critical: true, loadClass: "heterogeneous-bim", weight: 8, domain: "large-scene", quality: "equivalent" },
      { id: "case.campus-far-origin", track: "common-baseline", critical: false, loadClass: "far-origin-campus", weight: 7, domain: "large-scene", quality: "equivalent" },
      { id: "case.workcell-dynamic", track: "common-baseline", critical: false, loadClass: "dynamic-workcell", weight: 6, domain: "animation", quality: "equivalent" },
      { id: "case.animation-best", track: "best-quality", critical: false, loadClass: "dynamic-workcell", weight: 4, domain: "animation", quality: "best" },
      { id: "case.dashboard-mixed", track: "common-baseline", critical: false, loadClass: "mixed-dashboard", weight: 10, domain: "gui-chart-text", quality: "equivalent" },
      { id: "case.material-common", track: "common-baseline", critical: false, loadClass: "appearance-showcase", weight: 5, domain: "material-vfx", quality: "equivalent" },
      { id: "case.material-best", track: "best-quality", critical: false, loadClass: "appearance-showcase", weight: 5, domain: "material-vfx", quality: "best" },
      { id: "case.workcell-sim", track: "common-baseline", critical: false, loadClass: "dynamic-workcell", weight: 10, domain: "simulation-media-xr", quality: "equivalent" },
      { id: "case.editor-edit", track: "common-baseline", critical: false, loadClass: "heterogeneous-bim", weight: 10, domain: "editor-workflow", quality: "equivalent" },
      { id: "case.script-replay", track: "common-baseline", critical: false, loadClass: "mixed-dashboard", weight: 5, domain: "script-plugin-api", quality: "equivalent" },
      { id: "case.diagnostics-recovery", track: "common-baseline", critical: false, loadClass: "factory-instances", weight: 5, domain: "diagnostics-reliability", quality: "equivalent" },
    ],
    requiredCapabilities: [{ id: "cap.offline-delivery", domain: "native-delivery", weight: 5, critical: true }],
    forbiddenRegressions: [{ id: "regression.selection-loss", description: "换页后选中构件丢失" }],
    exclusions: [{ id: "case.excluded-raytracing", reason: "重型光追在现交付线排除", ruling: "既有明确排除项,不进分母" }],
    ...overrides,
  } as EngineTargetMatrix;
}

function evidence(overrides: Partial<TargetRunEvidence> = {}): TargetRunEvidence {
  const pass = { status: "passed" as const, evidenceIds: ["evidence.1"] };
  return {
    cases: Object.fromEntries(createEngineTargetMatrix(matrix("unity")).cases.map(entry => [entry.id, pass])),
    capabilities: { "cap.offline-delivery": pass },
    regressions: { "regression.selection-loss": { observed: false, evidenceIds: ["evidence.2"] } },
    ...overrides,
  };
}

describe("engine target matrix construction", () => {
  it("builds five independently judgeable matrices with all load classes and exact weights", () => {
    for (const reference of REFERENCES) {
      const frozen = createEngineTargetMatrix(matrix(reference));
      expect(frozen.schemaVersion).toBe(2);
      expect(new Set(frozen.cases.map(entry => entry.loadClass))).toEqual(new Set(REQUIRED_LOAD_CLASSES));
    }
  });

  it("rejects tampered weights, empty denominators, missing load classes and unlocked identities", () => {
    const tampered = matrix("three", { cases: [matrix("three").cases[0]!] });
    expect(() => createEngineTargetMatrix(tampered)).toThrow(/weights total/);
    expect(() => createEngineTargetMatrix(matrix("three", { requiredCapabilities: [] }))).toThrow(/denominator/);
    expect(() => createEngineTargetMatrix(matrix("three", { cases: [] }))).toThrow(/load class/);
    expect(() => createEngineTargetMatrix(matrix("three", { engine: { version: " ", renderer: "r", platform: "p" } }))).toThrow(/version/);
    // 公共基线赛道混入最佳质量口径
    const mixed = matrix("three");
    (mixed.cases[0] as { quality: string }).quality = "best";
    expect(() => createEngineTargetMatrix(mixed)).toThrow(/common baseline/);
  });
});

describe("engine target matrix verdicts", () => {
  it("passes only with full verified evidence, locked identity and no regression", () => {
    for (const reference of REFERENCES) {
      const verdict = evaluateEngineTargetMatrix(createEngineTargetMatrix(matrix(reference)), evidence());
      expect(verdict.valid).toBe(true);
      expect(verdict.passed).toBe(true);
      expect(verdict.denominator).toBe(15);
      expect(verdict.passedCount).toBe(15);
    }
  });

  it("keeps unverified entries in the denominator and fails critical gaps", () => {
    const partial = evidence();
    delete (partial.cases as Record<string, unknown>)["case.factory-draw"];
    (partial.capabilities as Record<string, unknown>)["cap.offline-delivery"] = { status: "unverified", evidenceIds: [] };
    const verdict = evaluateEngineTargetMatrix(createEngineTargetMatrix(matrix("unity")), partial);
    expect(verdict.passed).toBe(false);
    expect(verdict.unverified).toEqual(["case.factory-draw", "cap.offline-delivery"]);
    expect(verdict.denominator).toBe(15);
    expect(verdict.issues.join()).toContain("critical case case.factory-draw is unverified");
  });

  it("rejects evidence-free passes, fired regressions and scored exclusions", () => {
    const noEvidence = evidence();
    (noEvidence.cases as Record<string, unknown>)["case.campus-far-origin"] = { status: "passed", evidenceIds: [] };
    const verdict = evaluateEngineTargetMatrix(createEngineTargetMatrix(matrix("unity")), noEvidence);
    expect(verdict.passed).toBe(false);
    expect(verdict.issues.join()).toContain("passed without evidence");

    const regressed = evidence({ regressions: { "regression.selection-loss": { observed: true, evidenceIds: ["evidence.3"] } } });
    const regressionVerdict = evaluateEngineTargetMatrix(createEngineTargetMatrix(matrix("unity")), regressed);
    expect(regressionVerdict.regressionViolations).toEqual(["regression.selection-loss"]);
    expect(regressionVerdict.passed).toBe(false);

    const scoredExclusion = evidence({ cases: { ...evidence().cases, "case.excluded-raytracing": { status: "passed", evidenceIds: ["evidence.4"] } } });
    const exclusionVerdict = evaluateEngineTargetMatrix(createEngineTargetMatrix(matrix("unity")), scoredExclusion);
    expect(exclusionVerdict.passed).toBe(false);
    expect(exclusionVerdict.issues.join()).toContain("must not carry scored evidence");
  });

  it("never passes an unlocked identity and invalidates malformed matrices instead of scoring them", () => {
    const unlocked = evaluateEngineTargetMatrix(createEngineTargetMatrix(matrix("godot",
      { engine: { version: "unlocked", renderer: "Forward+", platform: "windows-x64" } })), evidence());
    expect(unlocked.valid).toBe(true);
    expect(unlocked.passed).toBe(false);

    const tampered = structuredClone(matrix("ue5"));
    (tampered as { schemaVersion: number }).schemaVersion = 1;
    const invalid = evaluateEngineTargetMatrix(tampered as EngineTargetMatrix, evidence());
    expect(invalid.valid).toBe(false);
    expect(invalid.denominator).toBe(0);
    expect(invalid.issues.join()).toContain("schema identity mismatch");
  });
});
