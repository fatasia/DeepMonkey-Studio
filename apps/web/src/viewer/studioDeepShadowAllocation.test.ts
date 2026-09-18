import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { studioDeepShadowMapSize } from "./studioDeepShadowAllocation";

describe("Studio author shadow allocation", () => {
  function fixture() {
    const scene = new THREE.Scene(), light = new THREE.DirectionalLight();
    light.castShadow = true; light.shadow.mapSize.set(2048, 2048); scene.add(light);
    return { scene, light };
  }
  it("reserves author resolution without changing the light", () => {
    const { scene, light } = fixture(); const original = light.toJSON();
    expect(studioDeepShadowMapSize(scene, 1)).toBe(2048);
    expect(light.toJSON()).toEqual(original);
  });
  it("filters hidden parents, camera layers and non-casting lights", () => {
    const { scene, light } = fixture();
    light.layers.set(2); expect(studioDeepShadowMapSize(scene, 1)).toBe(1024);
    expect(studioDeepShadowMapSize(scene, 4)).toBe(2048);
    const parent = new THREE.Group(); parent.visible = false; scene.add(parent); parent.add(light);
    expect(studioDeepShadowMapSize(scene, 4)).toBe(1024);
    parent.visible = true; light.castShadow = false;
    expect(studioDeepShadowMapSize(scene, 4)).toBe(1024);
    light.castShadow = true; light.intensity = 0;
    expect(studioDeepShadowMapSize(scene, 4)).toBe(1024);
  });
  it.each([[32, 32], [NaN, NaN], [512, 1024], [32768, 32768], [64.5, 64.5]])(
    "does not allocate invalid inactive map %s × %s", (x, y) => {
      const { scene, light } = fixture(); light.shadow.mapSize.set(x, y);
      expect(studioDeepShadowMapSize(scene, 1)).toBe(1024);
    });
});
