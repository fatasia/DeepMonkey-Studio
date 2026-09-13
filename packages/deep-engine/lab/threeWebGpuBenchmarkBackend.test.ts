import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { planCascadedShadows } from "@bim-studio/deep-engine";
import { createBenchmarkScene, BENCHMARK_LIGHT } from "./benchmarkScene.js";
import { configureBenchmarkShadow } from "./threeWebGpuBenchmarkBackend.js";
import { deepBaselineShadowFilter } from "./threeBaselineShadowFilter.js";

describe("Three benchmark shadow parity", () => {
  it("publishes Deep's exact one-cascade camera and comparison kernel", () => {
    const fixture = createBenchmarkScene(1_024), sun = new THREE.DirectionalLight();
    const before = sun.shadow.camera.projectionMatrix.clone();
    configureBenchmarkShadow(sun, fixture, "baseline-equivalent");
    const plan = planCascadedShadows({ eye: fixture.view.eye, target: fixture.view.target,
      up: fixture.view.up!, verticalFovRadians: fixture.view.verticalFovRadians!,
      aspect: fixture.view.width / fixture.view.height, near: fixture.view.near!, far: fixture.view.far! },
    BENCHMARK_LIGHT.directionWorld, { cascadeCount: 1, shadowMapSize: 2048,
      splitLambda: 0, blendRatio: 0,
      ...(fixture.view.far === undefined ? {} : { maxShadowDistance: fixture.view.far }),
      depthPadding: fixture.extent * 0.2 });
    const slice = plan.cascades[0]!, camera = sun.shadow.camera;
    expect(camera.left).toBe(-slice.radius); expect(camera.right).toBe(slice.radius);
    expect(camera.top).toBe(slice.radius); expect(camera.bottom).toBe(-slice.radius);
    expect(camera.projectionMatrix.equals(before)).toBe(false);
    expect(sun.shadow.mapSize.toArray()).toEqual([2048, 2048]);
    expect(sun.shadow.normalBias).toBe(slice.texelWorldSize);
    expect((sun.shadow as THREE.DirectionalLightShadow & { filterNode: unknown }).filterNode)
      .toBe(deepBaselineShadowFilter);
  });

  it("keeps the native high-quality Three filter", () => {
    const sun = new THREE.DirectionalLight();
    configureBenchmarkShadow(sun, createBenchmarkScene(1_024), "high-native");
    expect((sun.shadow as THREE.DirectionalLightShadow & { filterNode?: unknown }).filterNode).toBeUndefined();
  });
});
