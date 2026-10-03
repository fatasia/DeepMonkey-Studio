import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { GLOBAL_ILLUMINATION_STAND_IN_LIGHT_NAME, projectStudioDeepLights } from "./studioDeepEnvironmentLights";

/**
 * F5-L5 合同钉子:WebGL GI 站位光不得进入 Deep 光照投影。
 *
 * 机制链(封门哨兵 leakRatio 载体,实测证据 test-output/f5-l4-next-20261002/):
 * 站位光(HemisphereLight)进入 lights.hemisphere → packDiffuseIrradiance →
 * deepAuthoredDiffuse(无探针门控/无遮挡)与探针 GI 双重计账——三区 gi-on−gi-off
 * delta 全部蓝主异(B>G>R),与站位光天空色 0xbddcff 特征吻合。
 * Deep 端 GI 的唯一权威 = 探针体积;作者自建半球光不受影响。
 */
describe("projectStudioDeepLights excludes the WebGL GI stand-in light", () => {
  it("drops the named GI stand-in hemisphere light from the projection", () => {
    const scene = new THREE.Scene();
    const standIn = new THREE.HemisphereLight(0xbddcff, 0x75634d, 0.8);
    standIn.name = GLOBAL_ILLUMINATION_STAND_IN_LIGHT_NAME;
    scene.add(standIn);
    scene.updateMatrixWorld(true);
    const result = projectStudioDeepLights(scene);
    expect(result.issues).toEqual([]);
    expect(result.lights).not.toHaveProperty("hemisphere");
    expect(result.lights).toEqual({ directional: [], points: [], spots: [] });
  });

  it("still projects author-authored hemisphere lights", () => {
    const scene = new THREE.Scene();
    const standIn = new THREE.HemisphereLight(0xbddcff, 0x75634d, 0.8);
    standIn.name = GLOBAL_ILLUMINATION_STAND_IN_LIGHT_NAME;
    const authored = new THREE.HemisphereLight("#789abc", "#234567", 1.25);
    authored.position.set(0, 4, 0);
    scene.add(standIn, authored);
    scene.updateMatrixWorld(true);
    const result = projectStudioDeepLights(scene);
    expect(result.issues).toEqual([]);
    expect(result.lights.hemisphere).toHaveLength(1);
    expect(result.lights.hemisphere?.[0]).toMatchObject({ skyColor: authored.color.toArray(), intensity: 1.25 });
  });

  it("keeps the exclusion independent of the GI toggle path: a stand-in at intensity 0 stays excluded", () => {
    // GI 关闭时 rig 将该灯 visible=false/intensity 0;两种形态都必须不进投影。
    const scene = new THREE.Scene();
    const standIn = new THREE.HemisphereLight(0xbddcff, 0x75634d, 0);
    standIn.name = GLOBAL_ILLUMINATION_STAND_IN_LIGHT_NAME;
    scene.add(standIn);
    scene.updateMatrixWorld(true);
    expect(projectStudioDeepLights(scene).lights).toEqual({ directional: [], points: [], spots: [] });
    standIn.visible = false;
    expect(projectStudioDeepLights(scene).lights).toEqual({ directional: [], points: [], spots: [] });
  });
});
