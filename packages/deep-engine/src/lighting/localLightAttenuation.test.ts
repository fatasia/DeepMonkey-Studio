import { describe, expect, it } from "vitest";
import { assignLightsToClusters } from "./clusterGrid.js";
import { FORWARD_PLUS_PBR_WGSL } from "./clusterLightingPbrWgsl.js";
import { FORWARD_PLUS_LIGHT_ABI_WGSL } from "./lightAbiWgsl.js";
import { evaluateForwardPlusPbrCpu, type ForwardPlusPbrSurface } from "./pbrLightingCpu.js";
import type { ClusteredLights } from "./types.js";

const grid = { viewportWidth: 1, viewportHeight: 1, tileSizeX: 1, tileSizeY: 1,
  zSlices: 1, near: 1, far: 16, verticalFovRadians: Math.PI / 2, maxLightsPerCluster: 8 } as const;
const surface: ForwardPlusPbrSurface = { fragmentCoordinate: [0.5, 0.5], positionView: [0, 0, -4],
  normalView: [0, 0, 1], baseColor: [0.8, 0.4, 0.2], metallic: 0.2, roughness: 0.5 };
const color = [1, 0.5, 0.25] as const;
const evaluate = (lights: ClusteredLights) => evaluateForwardPlusPbrCpu(
  assignLightsToClusters(grid, lights), lights, surface).color;

describe("local-light attenuation parity with Three r185 lights_pars_begin", () => {
  it.each([0, 1, 1.5, 2, 4])("preserves unlimited authored decay %s in point and spot contributions", decay => {
    const light = { positionView: [0,0,-2] as const, range: 0, decay, color, intensity: 1 };
    const reference = evaluate({ directional: [{ directionView: [0,0,-1], color, intensity: 1 }] });
    const point = evaluate({ points: [light] });
    const spot = evaluate({ spots: [{ ...light, directionView: [0,0,-1], outerConeCos: .8, innerConeCos: .8 }] });
    reference.forEach((value, index) => {
      expect(point[index]! / value).toBeCloseTo(1 / 2 ** decay, 10);
      expect(spot[index]! / value).toBeCloseTo(1 / 2 ** decay, 10);
    });
  });
  // Directional and local lights share the BRDF; their radiance ratio isolates attenuation.
  const direct = () => evaluate({ directional: [{ directionView: [0, 0, -1], color, intensity: 1 }] });

  it.each([0, 0.001, 0.05, 0.099, 0.1, 0.101, 0.5, 2, 3.999, 4, 5])(
    "matches inverse-square falloff with the 0.01 floor and cutoff at distance %s", distance => {
      const range = 4;
      const actual = evaluate({ points: [{ positionView: [0, 0, -4 + distance], range, color, intensity: 1 }] });
      const expectedFalloff = Math.max(0, 1 - (distance / range) ** 4) ** 2 / Math.max(distance ** 2, 0.01);
      direct().forEach((value, channel) => expect(actual[channel]! / value).toBeCloseTo(expectedFalloff, 9));
    });

  it.each([
    [0.4, 0], [0.5, 0], [0.6, 0.15625], [0.7, 0.5], [0.8, 0.84375], [0.9, 1], [1, 1],
  ])("uses cubic smoothstep at cone cosine %s (weight %s)", (coneCos, expectedWeight) => {
    const point = { positionView: [0, 0, -2] as const, range: 4, color, intensity: 1 };
    const pointColor = evaluate({ points: [point] });
    const spotColor = evaluate({ spots: [{ ...point,
      directionView: [Math.sqrt(1 - coneCos! ** 2), 0, -coneCos!], outerConeCos: 0.5, innerConeCos: 0.9 }] });
    pointColor.forEach((value, channel) => expect(spotColor[channel]! / value).toBeCloseTo(expectedWeight!, 12));
  });

  it("keeps WGSL falloff and cubic cone interpolation in the shared GPU path", () => {
    expect(FORWARD_PLUS_PBR_WGSL).toContain("return window * window / max(distanceSquared, 0.01);");
    // The range-normalization guard is a separate policy and is intentionally unchanged.
    expect(FORWARD_PLUS_PBR_WGSL).toContain("distanceSquared / max(range * range, 0.0001)");
    expect(FORWARD_PLUS_LIGHT_ABI_WGSL).toContain(
      "let coneWeight = clamp((coneCos - light.directionOuterCos.w) * light.radianceConeScale.w, 0.0, 1.0);");
    expect(FORWARD_PLUS_LIGHT_ABI_WGSL).toContain("return coneWeight * coneWeight * (3.0 - 2.0 * coneWeight);");
  });
});
