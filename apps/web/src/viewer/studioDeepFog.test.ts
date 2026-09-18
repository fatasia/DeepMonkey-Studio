import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { readStudioDeepFog } from "./studioDeepFog";

describe("Studio author fog", () => {
  it("explicitly disables Deep preview fog when the author has no fog", () => {
    expect(readStudioDeepFog(new THREE.Scene(), true)).toBeNull();
    expect(readStudioDeepFog(new THREE.Scene(), false)).toBeNull();
  });
  it("reads linear HDR color and exact Exp2 density without changing the author", () => {
    const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(new THREE.Color().setRGB(0.2, 0.3, 0.4), 0.007);
    const original = scene.fog.toJSON(), projected = readStudioDeepFog(scene, true);
    expect(projected).toEqual({ kind: "exp2", color: [0.2, 0.3, 0.4], density: 0.007 });
    expect(scene.fog.toJSON()).toEqual(original);
    scene.fog.color.r = 0.9; scene.fog.density = 0.01;
    expect(projected).toMatchObject({ color: [0.2, 0.3, 0.4], density: 0.007 });
  });
  it("preserves linear distances and rejects invalid author values", () => {
    const scene = new THREE.Scene(); scene.fog = new THREE.Fog(0xffffff, 2, 100);
    expect(readStudioDeepFog(scene, true)).toEqual({ kind: "linear", color: [1, 1, 1], near: 2, far: 100 });
    scene.fog.far = 2; expect(() => readStudioDeepFog(scene, true)).toThrow();
    scene.fog = new THREE.FogExp2(0xffffff, NaN); expect(() => readStudioDeepFog(scene, true)).toThrow();
  });
  it("does not reinterpret direct display fog as linear HDR", () => {
    const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(0xffffff);
    expect(() => readStudioDeepFog(scene, false)).toThrow("显示域");
  });
});
