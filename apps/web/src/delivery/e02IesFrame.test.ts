import { describe, expect, it } from "vitest";
import { parseIesProfile } from "@bim-studio/deep-engine/lighting";
import { quantizeIesLightProfile } from "@bim-studio/deep-engine/runtime-package";
import { readFileSync } from "node:fs";
import { canonicalIesFrame, E02_IES_FRAME_CONTRACT, parseE02IesScenario } from "./e02IesFrame";

const profile = quantizeIesLightProfile("beam.narrow",
  parseIesProfile(readFileSync(new URL("../../../../packages/deep-engine/fixtures/ies/e02-quad-0-90.ies", import.meta.url), "utf8")));
const scenarioJson = {
  schema: "deep-monkey.e02-ies-scenario",
  schemaVersion: 1,
  id: "e02-ies-gate",
  lightProfiles: [JSON.parse(JSON.stringify(profile))],
  lights: [{ id: "spot-a", profileId: "beam.narrow", rotationDeg: 0, scaleFactor: 1 }],
  samples: { thetaDeg: [0, 45, 90], phiDeg: [0, 90] },
};

describe("E02 IES frame contract (e02-ies-frame-v1)", () => {
  it("parses the frozen scenario with a strict whitelist", () => {
    const scenario = parseE02IesScenario(scenarioJson);
    expect(scenario.id).toBe("e02-ies-gate");
    expect(scenario.lights[0]!.profileId).toBe("beam.narrow");
    expect(() => parseE02IesScenario({ ...scenarioJson, extra: 1 })).toThrow('unknown field "extra"');
    expect(() => parseE02IesScenario({ ...scenarioJson, lights: [{ id: "x", profileId: "missing" }] })).toThrow("undeclared profileId");
    expect(() => parseE02IesScenario({ ...scenarioJson, lights: [{ id: "x", profileId: "beam.narrow", rotationDeg: 45.25 }] })).toThrow("rotationDeg");
  });

  it("folds canonical and applied states to the same frame and keeps rot/scale variants distinct", () => {
    const scenario = parseE02IesScenario(scenarioJson);
    const canonical = canonicalIesFrame(scenario, [{ id: "spot-a", ies: { profileId: "beam.narrow" } }]);
    expect(canonical.startsWith(`${E02_IES_FRAME_CONTRACT}|scene=e02-ies-gate|`)).toBe(true);
    // applied 侧（真实引擎投影）与 canonical 相同状态 → 逐字节一致。
    const applied = canonicalIesFrame(scenario, [{ id: "spot-a", ies: { profileId: "beam.narrow", rotationDeg: 0, scaleFactor: 1 } }]);
    expect(applied).toBe(canonical);
    // applied 状态漂移必须失败（同 r3 applied≠contract 抛错纪律）。
    expect(() => canonicalIesFrame(scenario, [{ id: "spot-a", ies: { profileId: "beam.narrow", rotationDeg: 45 } }])).not.toThrow();
    expect(canonicalIesFrame(scenario, [{ id: "spot-a", ies: { profileId: "beam.narrow", rotationDeg: 45 } }]))
      .not.toBe(canonical);
    expect(canonicalIesFrame(scenario, [{ id: "spot-a", ies: { profileId: "beam.narrow", scaleFactor: 0.5 } }]))
      .not.toBe(canonical);
    // 缺 applied 状态 → 抛错（合同缺口不允许静默）。
    expect(() => canonicalIesFrame(scenario, [])).toThrow("missing ies state");
  });
});
