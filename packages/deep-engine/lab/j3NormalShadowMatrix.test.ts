import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DeepRuntimePackageV1 } from "../src/runtimePackage/types.js";
import { buildJ3NormalShadowMatrix, type J3NormalShadowManifest } from "./j3NormalShadowMatrix.js";

const source = JSON.parse(readFileSync(new URL("../../deep-engine-native/tests/fixtures/runtime-package-v1.json", import.meta.url), "utf8")) as DeepRuntimePackageV1;
const manifest = JSON.parse(readFileSync(new URL("../fixtures/j3-hdr-flat-normal-v1.json", import.meta.url), "utf8")) as J3NormalShadowManifest;
const matrix = buildJ3NormalShadowMatrix(source, manifest);

describe("J3 normal/shadow common packet preflight", () => {
  it("reuses all 85 frozen points across two cameras, mirrored transforms and one/four cascade profiles", () => {
    expect(matrix.cases).toHaveLength(8);
    expect(matrix.cases.filter(row => row.cascadeCount === 1).reduce((sum, row) => sum + row.points.length, 0)).toBe(85);
    expect(matrix.cases.map(row => row.points.length)).toEqual([21, 21, 24, 24, 22, 22, 18, 18]);
    expect(matrix.packageHash).toBe(manifest.packageHash); expect(matrix.packetHash).toBe(manifest.packetHash);
    for (const row of matrix.cases) {
      const subset = manifest.cameras.find(camera => camera.id === row.cameraId)!.subsets.find(value => value.instanceId === row.instanceId)!;
      expect(row.points.map(point => point.pixel)).toEqual(subset.pixels);
      expect(row.splitDepths).toHaveLength(row.cascadeCount); expect(row.splitDepths.at(-1)).toBe(40);
      expect(row.scenarios).toEqual(["baseline", "cube-caster-disabled", "triangle-receiver-disabled"]);
    }
  });

  it("regular and mirrored X instances retain +Z world normals and rotate into the authored view", () => {
    for (const row of matrix.cases) for (const point of row.points) {
      expect(point.expectedWorldNormal).toEqual([0, 0, 1]);
      expect(Math.hypot(...point.expectedViewNormal)).toBeCloseTo(1, 12);
      if (row.cameraId === "axis") expect(point.expectedViewNormal).toEqual([0, 0, 1]);
      else {
        expect(point.expectedViewNormal[0]).toBeCloseTo(-3 / Math.sqrt(73), 6);
        expect(point.expectedViewNormal[1]).toBeCloseTo(-16 / Math.sqrt(73 * 77), 6);
        expect(point.expectedViewNormal[2]).toBeCloseTo(8 / Math.sqrt(77), 6);
      }
    }
    expect(matrix.profile.normalQuantizationAngleBoundDegrees).toBeLessThan(.4);
  });

  it("the authored ray actually encounters the existing cube and caster/receiver switches remove its shadow", () => {
    const points = matrix.cases.filter(row => row.cascadeCount === 1).flatMap(row => row.points);
    const blocked = points.filter(point => point.baselineOccluded);
    expect(blocked.length).toBeGreaterThan(0); expect(blocked.length).toBeLessThan(points.length);
    expect(new Set(blocked.map(point => point.blockerInstance))).toEqual(new Set(["golden-instance-second"]));
    expect(blocked.every(point => point.blockerDistance! > matrix.profile.rayOriginOffset)).toBe(true);
    expect(points.every(point => !point.casterDisabledOccluded && !point.receiverDisabledOccluded)).toBe(true);
  });

  it("does not turn a CPU matrix into actual GPU or current-run parity evidence", () => {
    expect(matrix.evidenceKind).toBe("cpu-contract-plan"); expect(matrix.currentRun).toBe(false);
    expect(matrix.actualNormalAttachments).toBe(false); expect(matrix.actualShadowAttachments).toBe(false);
    expect(matrix.productionAdmission).toBe("pending-normal-attachment-and-shadow-uniform-alignment");
  });

  it("rejects stale source identity before scene assembly", () => {
    expect(() => buildJ3NormalShadowMatrix(source, { ...manifest, packetHash: "0".repeat(64) })).toThrow("manifest mismatch");
    expect(() => buildJ3NormalShadowMatrix(source, { ...manifest, packageHash: "0".repeat(64) })).toThrow("manifest mismatch");
  });

  it("rejects invalid, duplicate and off-object mask points", () => {
    for (const pixels of [[-1], [manifest.width * manifest.height], [6991, 6991], [0]]) {
      const copy = { ...manifest, cameras: manifest.cameras.map((camera, index) => index !== 0 ? camera : {
        ...camera, subsets: camera.subsets.map((subset, subsetIndex) => subsetIndex !== 0 ? subset : { ...subset, pixels }),
      }) };
      expect(() => buildJ3NormalShadowMatrix(source, copy)).toThrow(/mask/);
    }
  });
});
