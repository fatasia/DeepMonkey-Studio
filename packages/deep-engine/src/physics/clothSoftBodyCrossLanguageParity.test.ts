import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ClothSolver } from "./clothSolver.js";
import { SoftBodySolver } from "./softBodySolver.js";
import { fingerprintFloat64 } from "./physicsTypes.js";

// J3 Gate C 扩族:布料/软体跨端指纹对拍的 TS 侧持续校验。
// 共享 fixture(packages/deep-engine-native/tests/fixtures/cloth-softbody-solver-parity-v1.json)
// 由 F6 基线求解器生成一次,这里用同一真实求解器重放:指纹若漂移,TS 侧先红,
// Rust 镜像(packages/deep-engine-native/tests/cloth_softbody_solver_parity.rs)随之对拍失败。
// 场景参数与 clothSolver.test.ts / softBodySolver.test.ts(F6 d03d8c60)逐项一致。

const FIXTURE = JSON.parse(readFileSync(
  new URL("../../../deep-engine-native/tests/fixtures/cloth-softbody-solver-parity-v1.json", import.meta.url),
  "utf8",
)) as {
  schema: string;
  cloth: {
    config: ConstructorParameters<typeof ClothSolver>[0];
    windConfig: ConstructorParameters<typeof ClothSolver>[0];
    pinned: ReadonlyArray<readonly [number, number]>;
    noWind: ScenarioFingerprints;
    wind: ScenarioFingerprints;
  };
  softBody: {
    config: ConstructorParameters<typeof SoftBodySolver>[0];
    zeroGravityConfig: ConstructorParameters<typeof SoftBodySolver>[0];
    cubeGravity: SoftScenarioFingerprints;
    cubeZeroGravity: SoftScenarioFingerprints;
  };
};

interface ScenarioFingerprints {
  readonly initialFingerprint: string;
  readonly fingerprint: string;
  readonly ticks: number;
  readonly constraints: number;
}

interface SoftScenarioFingerprints {
  readonly initialFingerprint: string;
  readonly fingerprint: string;
  readonly ticks: number;
  readonly tets: number;
  readonly edges: number;
}

function stateFingerprint(solver: ClothSolver | SoftBodySolver): string {
  const snap = solver.capture();
  const n = snap.px.length;
  const all = new Float64Array(n * 6);
  all.set(snap.px, 0);
  all.set(snap.py, n);
  all.set(snap.pz, 2 * n);
  all.set(snap.vx, 3 * n);
  all.set(snap.vy, 4 * n);
  all.set(snap.vz, 5 * n);
  return fingerprintFloat64(all);
}

describe("cloth/soft body cross-language fingerprint parity (J3 Gate C)", () => {
  it("fixture stays pinned to the committed schema", () => {
    expect(FIXTURE.schema).toBe("deep-engine.cloth-softbody-solver-parity");
  });

  it("replays the cloth scenarios onto the committed TS fingerprints", () => {
    for (const [key, configKey] of [
      ["noWind", "config"],
      ["wind", "windConfig"],
    ] as const) {
      const scenario = FIXTURE.cloth[key];
      const solver = new ClothSolver({ ...FIXTURE.cloth[configKey] });
      for (const [col, row] of FIXTURE.cloth.pinned) solver.setPinned(col, row, true);
      expect(stateFingerprint(solver)).toBe(scenario.initialFingerprint);
      for (let i = 0; i < scenario.ticks; i += 1) solver.step();
      expect(stateFingerprint(solver)).toBe(scenario.fingerprint);
      expect(solver.constraintCount).toBe(scenario.constraints);
    }
  });

  it("replays the soft body scenarios onto the committed TS fingerprints", () => {
    for (const [key, configKey] of [
      ["cubeGravity", "config"],
      ["cubeZeroGravity", "zeroGravityConfig"],
    ] as const) {
      const scenario = FIXTURE.softBody[key];
      const solver = new SoftBodySolver({ ...FIXTURE.softBody[configKey] });
      expect(stateFingerprint(solver)).toBe(scenario.initialFingerprint);
      for (let i = 0; i < scenario.ticks; i += 1) solver.step();
      expect(stateFingerprint(solver)).toBe(scenario.fingerprint);
      expect(solver.tetCount).toBe(scenario.tets);
    }
  });

  it("keeps the T18 acceptance bands that the fingerprinted scenarios were audited under", () => {
    const cloth = new ClothSolver({ ...FIXTURE.cloth.windConfig });
    for (const [col, row] of FIXTURE.cloth.pinned) cloth.setPinned(col, row, true);
    for (let i = 0; i < FIXTURE.cloth.wind.ticks; i += 1) cloth.step();
    expect(cloth.measureStretch().maxRatio).toBeLessThanOrEqual(0.05);

    const soft = new SoftBodySolver({ ...FIXTURE.softBody.config });
    for (let i = 0; i < FIXTURE.softBody.cubeGravity.ticks; i += 1) soft.step();
    const stats = soft.measureVolumeError();
    expect(stats.maxTetRatio).toBeLessThanOrEqual(0.05);
    expect(stats.totalRatio).toBeLessThanOrEqual(0.05);
  });
});
