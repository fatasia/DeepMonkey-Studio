import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  defaultTestMedium,
  henyeyGreensteinPhase,
  rayMarchVolumetricFog,
} from "./volumetricFog";

describe("G7 volumetric fog ray march (slice 1)", () => {
  it("Henyey-Greenstein phase matches the analytic forward/backward limits", () => {
    // g=0 时退化为各向同性 1/4π。
    expect(henyeyGreensteinPhase(1, 0)).toBeCloseTo(1 / (4 * Math.PI), 6);
    // g→0.99 前向峰值远大于后向。
    const forward = henyeyGreensteinPhase(1, 0.9);
    const backward = henyeyGreensteinPhase(-1, 0.9);
    expect(forward).toBeGreaterThan(backward * 100);
  });

  it("no fog: zero extinction medium yields no inscatter and full transmittance", () => {
    const result = rayMarchVolumetricFog(
      { baseExtinction: 0, scaleHeight: 8, anisotropy: 0, albedo: 0.8 },
      { direction: new THREE.Vector3(0, -1, 0), radiance: new THREE.Vector3(1, 1, 1) },
      { rayOrigin: new THREE.Vector3(0, 0, 0), rayDirection: new THREE.Vector3(0, 0, -1), near: 0, far: 100, stepCount: 16, shadowAttenuation: () => 1 },
    );
    expect(result.inscatter.lengthSq()).toBe(0);
    expect(result.transmittance).toBe(1);
  });

  it("is deterministic for identical inputs", () => {
    const input = {
      rayOrigin: new THREE.Vector3(0, 5, 0),
      rayDirection: new THREE.Vector3(0, -0.2, -1),
      near: 0, far: 200, stepCount: 64, shadowAttenuation: () => 1,
    };
    const light = { direction: new THREE.Vector3(0.3, -0.8, 0.2).normalize(), radiance: new THREE.Vector3(1, 0.95, 0.9) };
    const first = rayMarchVolumetricFog(defaultTestMedium(), light, input);
    const second = rayMarchVolumetricFog(defaultTestMedium(), light, input);
    expect(first.inscatter.toArray()).toEqual(second.inscatter.toArray());
    expect(first.transmittance).toBe(second.transmittance);
  });

  it("longer paths through fog reduce transmittance (Beer-Lambert behavior)", () => {
    const light = { direction: new THREE.Vector3(0, -1, 0), radiance: new THREE.Vector3(1, 1, 1) };
    const short = rayMarchVolumetricFog(defaultTestMedium(), light,
      { rayOrigin: new THREE.Vector3(0, 0, 0), rayDirection: new THREE.Vector3(0, 0, -1), near: 0, far: 10, stepCount: 32, shadowAttenuation: () => 1 });
    const long = rayMarchVolumetricFog(defaultTestMedium(), light,
      { rayOrigin: new THREE.Vector3(0, 0, 0), rayDirection: new THREE.Vector3(0, 0, -1), near: 0, far: 200, stepCount: 64, shadowAttenuation: () => 1 });
    expect(long.transmittance).toBeLessThan(short.transmittance);
    expect(long.inscatter.length()).toBeGreaterThan(short.inscatter.length());
  });

  it("shadow attenuation hook scales inscatter (occluded light contributes nothing)", () => {
    const light = { direction: new THREE.Vector3(0, -1, 0), radiance: new THREE.Vector3(1, 1, 1) };
    const input = { rayOrigin: new THREE.Vector3(0, 0, 0), rayDirection: new THREE.Vector3(0, 0, -1), near: 0, far: 100, stepCount: 32 };
    const lit = rayMarchVolumetricFog(defaultTestMedium(), light, { ...input, shadowAttenuation: () => 1 });
    const shadowed = rayMarchVolumetricFog(defaultTestMedium(), light, { ...input, shadowAttenuation: () => 0 });
    expect(shadowed.inscatter.lengthSq()).toBe(0);
    expect(lit.inscatter.length()).toBeGreaterThan(0);
  });

  it("early-exits when transmittance falls below the numerical floor", () => {
    const dense = { baseExtinction: 5, scaleHeight: 1000, anisotropy: 0, albedo: 0.9 };
    const light = { direction: new THREE.Vector3(0, -1, 0), radiance: new THREE.Vector3(1, 1, 1) };
    const result = rayMarchVolumetricFog(dense, light,
      { rayOrigin: new THREE.Vector3(0, 0, 0), rayDirection: new THREE.Vector3(0, 0, -1), near: 0, far: 1000, stepCount: 512, shadowAttenuation: () => 1 });
    expect(result.transmittance).toBeLessThan(1e-4);
  });
});
