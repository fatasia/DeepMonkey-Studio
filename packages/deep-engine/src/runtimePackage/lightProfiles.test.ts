import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseIesProfile } from "../lighting/iesProfile.js";
import { buildDeepRuntimePackage, type BuildDeepRuntimePackageInput } from "./index.js";
import { validateRuntimeEnvironment } from "./environment.js";
import { isOnIesAngleGrid, quantizeIesLightProfile, validateLightProfileShape } from "./lightProfiles.js";

/** 恒定 1000cd、0–90° 半球：单行 → horizontalSymmetry=1。 */
function coneFixture(candela = 1000): string {
  const vertical = Array.from({ length: 19 }, (_, i) => (i * 5).toFixed(1));
  return ["IESNA:LM-63-2002", "[TEST] UT-CONE", "TILT=NONE",
    "1 1000 1.0 19 1 1 1 1 1 0", "1.0 1.0 60", vertical.join(" "), "0",
    vertical.map(() => candela.toFixed(1)).join(" "), ""].join("\n");
}

/** 0–90° 等距水平扫描 ×3 行 → horizontalSymmetry=4（行距 45°）。 */
function quadFixture(multiplier = 1.0): string {
  const vertical = Array.from({ length: 19 }, (_, i) => (i * 5).toFixed(1));
  const horizontal = Array.from({ length: 3 }, (_, i) => (i * 45).toFixed(1));
  const row = (value: number) => vertical.map(() => value.toFixed(1)).join(" ");
  return ["IESNA:LM-63-1995", "TILT=NONE",
    `1 1000 ${multiplier} 19 3 1 1 1 1 0`, "1.0 1.0 60", vertical.join(" "), horizontal.join(" "),
    row(1000), row(500), row(250), ""].join("\n");
}

const solidEnv = (lighting: unknown) => ({ schema: "deep-engine.solid-environment", schemaVersion: 3,
  id: "scene.environment", revision: 1, kind: "solid-background-no-ibl",
  outputTransform: "native-aces-lights-v3", backgroundSrgb: [0, 0, 0], lighting });
const spot = (ies?: unknown) => ({ kind: "spot", position: [0, 4, 0], direction: [0, -1, 0], radiance: [4, 4, 4],
  range: 12, decay: 2, innerCos: 0.9, outerCos: 0.7, ...(ies === undefined ? {} : { ies }) });
const profileEntry = (overrides: Record<string, unknown> = {}) => ({
  profileId: "grid.cone", format: "LM-63-2002", verticalAngles: [0, 45, 90],
  candela: [[1000, 500, 100]], horizontalSymmetry: 1, totalLumens: 1234.5, ...overrides });
const check = (value: unknown) => validateRuntimeEnvironment(value, "scene.environment", 1, "$");
const lightingWith = (lights: unknown[], profiles?: unknown) => ({
  direction: [0, 1, 0], radiance: [0, 0, 0], exposure: 1.05, shadows: false, localLights: lights,
  ...(profiles === undefined ? {} : { lightProfiles: profiles }) });

describe("IES light-profile quantization (producer)", () => {
  it("quantizes a rotationally symmetric cone with folded gain and zone-rule lumens", () => {
    const table = quantizeIesLightProfile("grid.cone", parseIesProfile(coneFixture()));
    expect(table.format).toBe("LM-63-2002");
    expect(table.horizontalSymmetry).toBe(1);
    expect(table.candela).toHaveLength(1);
    expect(table.candela[0]?.[0]).toBe(1000);
    expect(table.candela[0]?.[18]).toBe(1000);
    expect(table.totalLumens).toBeCloseTo(6283.185, 3);
  });

  it("normalizes a 0-90 sweep to symmetry 4 and folds multiplier into stored candela", () => {
    const table = quantizeIesLightProfile("grid.quad", parseIesProfile(quadFixture()));
    expect(table.horizontalSymmetry).toBe(4);
    expect(table.candela).toHaveLength(3);
    expect(table.candela[0]?.[0]).toBe(1000);
    expect(table.candela[2]?.[0]).toBe(250);
    const doubled = quantizeIesLightProfile("grid.quad", parseIesProfile(quadFixture(2.0)));
    expect(doubled.candela[0]?.[0]).toBe(2000);
    expect(doubled.totalLumens).toBeCloseTo(table.totalLumens * 2, 2);
  });

  it("rejects B/A photometry, off-grid angles, duplicates and asymmetric sweeps by name", () => {
    const parsed = parseIesProfile(coneFixture());
    expect(() => quantizeIesLightProfile("bad.ba", { ...parsed, photometricType: 2 })).toThrowError(/photometricType 2/);
    expect(() => quantizeIesLightProfile("bad.aa", { ...parsed, photometricType: 3 })).toThrowError(/photometricType 3/);
    expect(() => quantizeIesLightProfile("bad.grid", { ...parsed, verticalAngles: parsed.verticalAngles.map(v => v + 0.25) })).toThrowError(/0\.5° 网格/);
    expect(() => quantizeIesLightProfile("bad.neg", { ...parsed, verticalAngles: [-5, ...parsed.verticalAngles.slice(1)] })).toThrowError(/超出 \[0,180\]/);
    const duplicate = [...parsed.verticalAngles]; duplicate[5] = duplicate[4];
    expect(() => quantizeIesLightProfile("bad.dup", { ...parsed, verticalAngles: duplicate })).toThrowError(/严格升序/);
    const threeRows = [parsed.candela[0], parsed.candela[0], parsed.candela[0]];
    expect(() => quantizeIesLightProfile("bad.asym", { ...parsed, horizontalAngles: [0, 30, 60], candela: threeRows })).toThrowError(/等距/);
    expect(() => quantizeIesLightProfile("bad.huge", { ...parsed, candela: [parsed.verticalAngles.map(() => 2e6)] })).toThrowError(/合同上限/);
    expect(() => parseIesProfile(coneFixture().replace("TILT=NONE", "TILT=INCLUDE"))).toThrowError(/TILT=INCLUDE/);
  });

  it("keeps the angle-grid predicate exact on the half-degree lattice", () => {
    for (const value of [0, 0.5, 22.5, 90, 179.5, 180]) expect(isOnIesAngleGrid(value)).toBe(true);
    for (const value of [0.25, 22.75, 90.1, 1 / 3]) expect(isOnIesAngleGrid(value)).toBe(false);
  });
});

describe("IES lighting integration (consumer)", () => {
  it("accepts a v3 environment with closed ies references", () => {
    const value = solidEnv(lightingWith([spot({ profileId: "grid.cone", rotationDeg: 45, scaleFactor: 0.5 })], [profileEntry()]));
    expect(() => check(value)).not.toThrow();
  });

  it("fails by name when a profileId is missing, duplicated or malformed", () => {
    const missing = lightingWith([spot({ profileId: "missing.profile" })], [profileEntry()]);
    expect(() => check(solidEnv(missing))).toThrowError(/missing\.profile/);
    expect(() => check(solidEnv(lightingWith([spot()], [profileEntry(), profileEntry()])))).toThrowError(/Duplicate profileId/);
    expect(() => check(solidEnv(lightingWith([spot()], [profileEntry({ verticalAngles: [0, 45, 90.25] })])))).toThrowError(/0\.5° grid/);
    expect(() => check(solidEnv(lightingWith([spot()], [profileEntry({ candela: [[1000.0005, 500, 100]] })])))).toThrowError(/1e-3 quantization grid/);
    expect(() => check(solidEnv(lightingWith([spot()], [profileEntry({ horizontalSymmetry: 3 })])))).toThrowError(/horizontalSymmetry/);
    expect(() => check(solidEnv(lightingWith([spot()], [profileEntry({ candela: [[1000, 500]] })])))).toThrowError(/row width/);
    expect(() => check(solidEnv(lightingWith([spot({ profileId: "grid.cone", rotationDeg: 45.25 })], [profileEntry()])))).toThrowError(/rotationDeg/);
    expect(() => check(solidEnv(lightingWith([spot({ profileId: "grid.cone", scaleFactor: 10.5 })], [profileEntry()])))).toThrowError(/scaleFactor/);
    expect(() => check(solidEnv(lightingWith([spot()], [profileEntry({ totalLumens: -1 })])))).toThrowError(/totalLumens/);
    // ies 引用而 lightProfiles 节缺失：同样按名拒绝，不静默降级为全向灯。
    expect(() => check(solidEnv(lightingWith([spot({ profileId: "ghost.profile" })])))).toThrowError(/ghost\.profile/);
  });

  it("rejects symmetry row-shape mismatches at validation time", () => {
    expect(() => check(solidEnv(lightingWith([spot()], [profileEntry({ candela: [[1000, 500, 100], [1000, 500, 100]] })])))).toThrowError(/exactly one row/);
    // 对称 2 需要 (rows−1) 整除 360 半度：8 行 → 360%7≠0 → 拒绝。
    const eightRows = Array.from({ length: 8 }, () => [1000, 500, 100]);
    expect(() => check(solidEnv(lightingWith([spot()], [profileEntry({ horizontalSymmetry: 2, candela: eightRows })])))).toThrowError(/evenly covering/);
    expect(() => validateLightProfileShape(profileEntry({ horizontalSymmetry: 2, verticalAngles: [0, 90, 180],
      candela: [[1000, 500, 100], [1000, 500, 100], [1000, 500, 100]] }) as unknown as Record<string, unknown>, "$.p")).not.toThrow();
  });

  it("builds a runtime package and reports ies closure failures with payload paths", () => {
    const nativeRoot = new URL("../../../deep-engine-native/", import.meta.url);
    const packet = JSON.parse(readFileSync(new URL("fixtures/render_packet_v1.json", nativeRoot), "utf8")) as {
      geometries: { vertices: number[]; indices: number[] }[];
      instances: { transform: number[] }[];
    };
    delete (packet as Record<string, unknown>).schema; delete (packet as Record<string, unknown>).version;
    for (const geometry of packet.geometries) {
      geometry.vertices = new Float32Array(geometry.vertices) as unknown as number[];
      geometry.indices = new Uint32Array(geometry.indices) as unknown as number[];
    }
    for (const instance of packet.instances) instance.transform = new Float32Array(instance.transform) as unknown as number[];
    const input = (environment: unknown): BuildDeepRuntimePackageInput => ({
      packageId: "deep.runtime.ies", packageVersion: "0.1.0", renderPacket: { id: "scene.main", revision: 3, value: packet as never },
      environment: environment as BuildDeepRuntimePackageInput["environment"],
    });
    const good = solidEnv(lightingWith([spot({ profileId: "grid.cone" })], [profileEntry()]));
    expect(() => buildDeepRuntimePackage(input(good))).not.toThrow();
    const broken = solidEnv(lightingWith([spot({ profileId: "ghost.profile" })], [profileEntry()]));
    try {
      buildDeepRuntimePackage(input(broken));
      expect.unreachable("ies closure must fail the build");
    } catch (error) {
      expect((error as Error).message).toContain("$.payloads.scene.environment.lighting");
      expect((error as Error).message).toContain("ghost.profile");
    }
  });

  it("leaves payloads without ies byte-identical (no new keys)", () => {
    const value = solidEnv(lightingWith([spot()]));
    expect(() => check(value)).not.toThrow();
    expect(JSON.stringify(value)).not.toContain("\"ies\"");
    expect(JSON.stringify(value)).not.toContain("lightProfiles");
    // 白名单放宽不改变既有拒绝行为：未知字段仍被拒。
    expect(() => check(solidEnv({ ...lightingWith([spot()]), unknownField: 1 }))).toThrowError(/Unknown field/);
    expect(() => check(solidEnv(lightingWith([spot({ bogus: true })])))).toThrowError(/Unknown field/);
  });
});
