import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { projectStudioDirectionalShadow } from "./studioDeepDirectionalShadow";
import { configureDirectionalShadow } from "./sceneShadowQuality";

function fixture() {
  const light = new THREE.DirectionalLight();
  light.position.set(0, 0, 10); light.target.position.set(0, 0, 0);
  configureDirectionalShadow(light);
  light.updateMatrixWorld(true); light.target.updateMatrixWorld(true);
  return light;
}

describe("Studio author directional shadow projection", () => {
  it("keeps the exact authored defaults and does not mutate the light camera", () => {
    const light = fixture(), before = light.shadow.camera.toJSON();
    const result = projectStudioDirectionalShadow(light, THREE.PCFShadowMap);
    expect(light.shadow.map).toBeNull();
    expect(result).toMatchObject({ mapSize: 1024, bias: -0.0001, normalBias: 0.015, intensity: 0.38, radius: 3 });
    expect(light.shadow.camera.toJSON()).toEqual(before);
    const matrix = new THREE.Matrix4().fromArray(result.viewProjection);
    expect(new THREE.Vector3(0, 0, 10 - 0.1).applyMatrix4(matrix).z).toBeCloseTo(0, 12);
    expect(new THREE.Vector3(0, 0, 10 - 300).applyMatrix4(matrix).z).toBeCloseTo(1, 12);
  });
  it("preserves asymmetric author bounds instead of fitting the viewer camera", () => {
    const light = fixture(), camera = light.shadow.camera;
    camera.left = -2; camera.right = 6; camera.bottom = -3; camera.top = 5;
    camera.updateProjectionMatrix();
    const matrix = new THREE.Matrix4().fromArray(projectStudioDirectionalShadow(light, THREE.PCFShadowMap).viewProjection);
    expect(new THREE.Vector3(-2, -3, 0).applyMatrix4(matrix).toArray().slice(0, 2)).toEqual([-1, -1]);
    expect(new THREE.Vector3(6, 5, 0).applyMatrix4(matrix).toArray().slice(0, 2)).toEqual([1, 1]);
  });
  it("reads world light positions and does not apply clip conversion twice", () => {
    const light = fixture(), group = new THREE.Group(); group.position.x = 7;
    group.add(light, light.target); group.updateMatrixWorld(true);
    const webgl = projectStudioDirectionalShadow(light, THREE.PCFShadowMap).viewProjection;
    light.shadow.camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
    light.shadow.camera.updateProjectionMatrix();
    const webgpu = projectStudioDirectionalShadow(light, THREE.PCFShadowMap).viewProjection;
    webgpu.forEach((value, index) => expect(value).toBeCloseTo(webgl[index]!, 12));
  });
  it.each([THREE.BasicShadowMap, THREE.PCFSoftShadowMap, THREE.VSMShadowMap])("rejects unmatched shadow filtering %s", filter => {
    expect(() => projectStudioDirectionalShadow(fixture(), filter)).toThrow("PCFShadowMap");
  });
  it.each([NaN, Infinity, -1, 1.1])("rejects invalid shadow intensity %s", intensity => {
    const light = fixture(); light.shadow.intensity = intensity;
    expect(() => projectStudioDirectionalShadow(light, THREE.PCFShadowMap)).toThrow("无效");
  });
  it("rejects non-square maps and degenerate light direction", () => {
    const light = fixture(); light.shadow.mapSize.set(1024, 512);
    expect(() => projectStudioDirectionalShadow(light, THREE.PCFShadowMap)).toThrow("正方形");
    light.shadow.mapSize.set(1024, 1024); light.position.set(0, 0, 0); light.updateMatrixWorld(true);
    expect(() => projectStudioDirectionalShadow(light, THREE.PCFShadowMap)).toThrow("位置和目标");
  });
  it("rejects reversed depth and parented shadow cameras explicitly", () => {
    const light = fixture(); Object.defineProperty(light.shadow.camera, "reversedDepth", { value: true, configurable: true });
    expect(() => projectStudioDirectionalShadow(light, THREE.PCFShadowMap)).toThrow("反向深度");
    Object.defineProperty(light.shadow.camera, "reversedDepth", { value: false });
    new THREE.Group().add(light.shadow.camera);
    expect(() => projectStudioDirectionalShadow(light, THREE.PCFShadowMap)).toThrow("父节点");
  });
});
