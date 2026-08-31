import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { configureDirectionalShadow } from "./sceneShadowQuality";

describe("configureDirectionalShadow", () => {
  it("keeps industrial shadows legible without pure-black projection", () => {
    const light = new THREE.DirectionalLight();

    configureDirectionalShadow(light);

    expect(light.shadow.mapSize.toArray()).toEqual([1_024, 1_024]);
    expect(light.shadow.intensity).toBeLessThan(0.5);
    expect(light.shadow.radius).toBeGreaterThan(1);
    expect(light.shadow.normalBias).toBeGreaterThan(0);
  });
});
