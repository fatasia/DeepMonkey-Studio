import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { ScenePostProcessingState } from "@bim-studio/contracts";
import { projectStudioDeepEnvironment } from "./studioDeepEnvironment";
import { projectStudioDeepLights } from "./studioDeepEnvironmentLights";

const post: ScenePostProcessingState = { enabled: false, smaa: false, ssao: false, ssaoIntensity: 1,
  bloom: false, bloomStrength: 0.35, bloomThreshold: 0.85 };
function fixture() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#123456");
  return { scene, postProcessing: { ...post }, exposure: 1.3, toneMapping: THREE.ACESFilmicToneMapping,
    floorColor: new THREE.Color("#345678") };
}

describe("Studio Deep author environment projection", () => {
  it("uses linear author colors and explicit empty lights, without built-in effects", () => {
    const input = fixture();
    const result = projectStudioDeepEnvironment(input);
    expect(result.issues).toEqual([]);
    expect(result.view.background).toEqual((input.scene.background as THREE.Color).toArray());
    expect(result.view.floor).toEqual(input.floorColor.toArray());
    expect(result.view.exposure).toBe(1.3);
    expect(result.view.lights).toEqual({ directional: [], points: [], spots: [] });
    expect(result.renderer.features).toMatchObject({ environment: false, fog: false, groundGrid: false,
      ambientOcclusion: false, screenSpaceReflection: false, temporalAa: false, bloom: false, vignette: false });
    input.floorColor.setRGB(1, 0, 0);
    expect(result.view.floor).not.toEqual(input.floorColor.toArray());
  });
  it("allocates SSR only for active authored Deep WebGPU state", () => {
    const input = fixture(); input.postProcessing = { ...post, enabled: true, screenSpaceReflection: true,
      ssrSteps: 64, ssrThickness: 0.02, ssrMaxDistance: 3 };
    expect(projectStudioDeepEnvironment(input).renderer.features?.screenSpaceReflection).toBe(true);
  });
  it("preserves authored intensity while reporting absent decoded IBL", () => {
    const input = fixture();
    input.scene.environment = new THREE.Texture();
    input.scene.environmentIntensity = 0.4;
    input.scene.environmentRotation.y = 0.5;
    const result = projectStudioDeepEnvironment(input);
    expect(result.renderer.environment).toBeUndefined();
    expect(result.view.environmentIntensity).toBe(0.4);
    expect(result.issues.map(issue => issue.code)).toEqual([
      "environment-source", "environment-rotation",
    ]);
  });
  it.each([0, 0.4, 1, 2, 64])("preserves environment intensity %s without altering author state", intensity => {
    const input = fixture();
    input.scene.environmentIntensity = intensity;
    const result = projectStudioDeepEnvironment(input);
    expect(result.view.environmentIntensity).toBe(intensity);
    expect(input.scene.environmentIntensity).toBe(intensity);
    expect(result.issues).toEqual([]);
  });
  it.each([-1, 64.001, NaN, Infinity, -Infinity])("rejects unsupported intensity %s instead of clamping", intensity => {
    const input = fixture();
    input.scene.environmentIntensity = intensity;
    expect(() => projectStudioDeepEnvironment(input)).toThrow("environmentIntensity");
  });
  it("does not replace arbitrary textures, transparent backgrounds or invalid exposure", () => {
    const input = fixture();
    input.scene.background = new THREE.Texture();
    expect(() => projectStudioDeepEnvironment(input)).toThrow("纯色背景");
    input.scene.background = null;
    expect(() => projectStudioDeepEnvironment(input)).toThrow("纯色背景");
    input.scene.background = new THREE.Color(); input.exposure = NaN;
    expect(() => projectStudioDeepEnvironment(input)).toThrow("曝光");
  });
  it("reports each enabled post-process mismatch, not just one feature", () => {
    const input = fixture();
    input.postProcessing = { ...post, enabled: true, smaa: true, ssao: true, bloom: true,
      vignette: true, colorGrading: true, contrast: 0.4, brightness: 0.2 };
    input.scene.fog = new THREE.FogExp2(input.floorColor, 0.004);
    const result = projectStudioDeepEnvironment(input);
    expect(result.issues.map(issue => issue.code)).toEqual([
      "fog-parameters", "post-smaa", "post-ssao", "post-bloom", "post-vignette", "post-color-grading",
    ]);
    expect(result.view.colorGrading).toBe("neutral");
    expect(input.postProcessing.contrast).toBe(0.4);
    input.postProcessing.enabled = false;
    expect(projectStudioDeepEnvironment(input).issues.map(issue => issue.code)).toEqual(["fog-parameters"]);
  });
});

describe("Studio Deep resolved world light projection", () => {
  it("honors the renderer-wide shadow switch without mutating authored lights", () => {
    const scene = new THREE.Scene(), sun = new THREE.DirectionalLight();
    const point = new THREE.PointLight("#ffffff", 1, 20);
    const spot = new THREE.SpotLight("#ffffff", 1, 20);
    spot.userData.authorLightId = "spot-1"; spot.userData.shadowSoftness = 0.5;
    sun.castShadow = point.castShadow = spot.castShadow = true;
    spot.position.y = 4;
    scene.add(sun, sun.target, point, spot, spot.target); scene.updateMatrixWorld(true);
    const disabled = projectStudioDeepLights(scene, 0xffffffff, false);
    expect(disabled.issues).toEqual([]);
    expect(disabled.lights.directional?.[0]?.castShadow).toBe(false);
    expect(disabled.lights.points).toHaveLength(1);
    expect(disabled.lights.spots).toHaveLength(1);
    expect([sun.castShadow, point.castShadow, spot.castShadow]).toEqual([true, true, true]);
    const enabled = projectStudioDeepLights(scene, 0xffffffff, true);
    expect(enabled.issues.map(issue => issue.code)).toEqual(["point-shadow-policy"]);
    expect(enabled.lights.spots?.[0]?.shadow).toEqual({ key: "author:spot-1", softness: 0.5 });
  });
  it("preserves a non-shadowing authored sun without default shadow diagnostics", () => {
    const scene = new THREE.Scene(), sun = new THREE.DirectionalLight("#ffffff", 2);
    scene.add(sun, sun.target); scene.updateMatrixWorld(true);
    const result = projectStudioDeepLights(scene);
    expect(result.lights.directional?.[0]).toMatchObject({ intensity: 2, castShadow: false });
    expect(result.issues).toEqual([]);
    sun.castShadow = true;
    expect(projectStudioDeepLights(scene).issues).toEqual([]);
    expect(projectStudioDeepLights(scene).lights.directional?.[0]?.shadow).toMatchObject({ mapSize: 512 });
  });
  it("reserves the primary slot for the only caster without changing author order", () => {
    const scene = new THREE.Scene(), fill = new THREE.DirectionalLight(), sun = new THREE.DirectionalLight();
    fill.intensity = 0.25; sun.intensity = 2; sun.castShadow = true;
    scene.add(fill, sun, fill.target, sun.target); scene.updateMatrixWorld(true);
    const original = [...scene.children];
    const result = projectStudioDeepLights(scene);
    expect(result.issues).toEqual([]);
    expect(result.lights.directional?.map(light => light.intensity)).toEqual([2, 0.25]);
    expect(scene.children).toEqual(original);
    fill.castShadow = true;
    expect(projectStudioDeepLights(scene).issues.map(issue => issue.code)).toEqual(["directional-shadow-count"]);
    expect(projectStudioDeepLights(scene, 0xffffffff, false).issues).toEqual([]);
  });
  it("rejects unsupported filters only when an authored shadow is active", () => {
    const scene = new THREE.Scene(), sun = new THREE.DirectionalLight();
    sun.castShadow = true; scene.add(sun, sun.target); scene.updateMatrixWorld(true);
    expect(projectStudioDeepLights(scene, 0xffffffff, true, THREE.VSMShadowMap).issues[0]?.code)
      .toBe("directional-shadow-policy");
    expect(projectStudioDeepLights(scene, 0xffffffff, false, THREE.VSMShadowMap).issues).toEqual([]);
  });
  it("excludes lights outside the camera layer mask", () => {
    const scene = new THREE.Scene(), sun = new THREE.DirectionalLight();
    sun.layers.set(2); scene.add(sun, sun.target); scene.updateMatrixWorld(true);
    expect(projectStudioDeepLights(scene, 1).lights.directional).toEqual([]);
    expect(projectStudioDeepLights(scene, 4).lights.directional).toHaveLength(1);
  });
  it("reads world positions and already-scaled intensity without mutating matrices", () => {
    const scene = new THREE.Scene(), group = new THREE.Group();
    group.position.set(4, 2, 3);
    const point = new THREE.PointLight("#abcdef", 3.4, 20, 2);
    point.position.set(1, 2, 3); group.add(point); scene.add(group); scene.updateMatrixWorld(true);
    const before = point.matrixWorld.toArray();
    const result = projectStudioDeepLights(scene);
    expect(result.lights.points).toEqual([{ positionWorld: [5, 4, 6], range: 20,
      color: point.color.toArray(), intensity: 3.4, decay: 2 }]);
    expect(result.issues).toEqual([]);
    expect(point.matrixWorld.toArray()).toEqual(before);
  });
  it("preserves spot direction and penumbra while reporting shadow parameter gaps", () => {
    const scene = new THREE.Scene(), spot = new THREE.SpotLight("#eeeeee", 2, 10, Math.PI / 4, 0.5, 2);
    spot.position.set(0, 4, 0); spot.target.position.set(0, 0, 0); spot.castShadow = true;
    spot.userData.authorLightId = "spot-author"; spot.userData.shadowSoftness = 0.75;
    scene.add(spot, spot.target); scene.updateMatrixWorld(true);
    const result = projectStudioDeepLights(scene);
    expect(result.lights.spots?.[0]).toMatchObject({ directionWorld: [0, -1, 0],
      innerConeCos: Math.cos(Math.PI / 8), outerConeCos: Math.cos(Math.PI / 4) });
    expect(result.lights.spots?.[0]?.shadow).toEqual({ key: "author:spot-author", softness: 0.75 });
    expect(result.issues).toEqual([]);
  });
  it("does not invent ranges for infinite lights or include hidden ancestors", () => {
    const scene = new THREE.Scene(), group = new THREE.Group();
    group.visible = false; group.add(new THREE.AmbientLight()); scene.add(group);
    scene.add(new THREE.PointLight("#ffffff", 1, 0)); scene.updateMatrixWorld(true);
    const result = projectStudioDeepLights(scene);
    // 衰减合同升级：distance=0 表示无截止距离（range 原样透传 0，不虚构范围值），
    // decay 走 Three 默认 2；隐藏祖先经 traverseVisible 排除，ambient 键因此缺省。
    expect(result.lights.points).toEqual([{ positionWorld: [0, 0, 0], range: 0,
      color: [1, 1, 1], intensity: 1, decay: 2 }]);
    expect(result.lights.ambient).toBeUndefined();
    expect(result.issues).toEqual([]);
  });
  it("rejects unsupported and invalid lights without dropping diagnostics", () => {
    const scene = new THREE.Scene(), point = new THREE.PointLight();
    point.intensity = NaN;
    scene.add(point, new THREE.RectAreaLight());
    expect(projectStudioDeepLights(scene).issues.map(issue => issue.code)).toEqual([
      "invalid-light", "unsupported-light-type",
    ]);
  });
  it("projects ambient and hemisphere colors from resolved author state", () => {
    const scene = new THREE.Scene(), parent = new THREE.Group();
    const ambient = new THREE.AmbientLight("#abcdef", 0.75);
    const hemi = new THREE.HemisphereLight("#789abc", "#234567", 1.25);
    parent.position.set(3, 0, 0); hemi.position.set(0, 4, 0);
    parent.add(hemi); scene.add(ambient, parent); scene.updateMatrixWorld(true);
    const result = projectStudioDeepLights(scene);
    expect(result.issues).toEqual([]);
    expect(result.lights).toMatchObject({ ambient: [{ color: ambient.color.toArray(), intensity: 0.75 }],
      hemisphere: [{ directionWorld: [expect.closeTo(0.6, 12), expect.closeTo(0.8, 12), 0], skyColor: hemi.color.toArray(),
        groundColor: hemi.groundColor.toArray(), intensity: 1.25 }] });
    hemi.groundColor.setRGB(1, 0, 0); ambient.color.setRGB(0, 0, 1);
    expect(result.lights).not.toEqual(projectStudioDeepLights(scene).lights);
    expect(hemi.position.toArray()).toEqual([0, 4, 0]);
    hemi.visible = false; ambient.intensity = 0;
    expect(projectStudioDeepLights(scene).lights).toEqual({ directional: [], points: [], spots: [] });
  });
  it("rejects invalid hemisphere ground color and degenerate direction", () => {
    const scene = new THREE.Scene(), hemi = new THREE.HemisphereLight(); scene.add(hemi);
    scene.updateMatrixWorld(true); hemi.groundColor.r = NaN;
    expect(projectStudioDeepLights(scene).issues[0]?.code).toBe("invalid-light");
    hemi.groundColor.r = 0; hemi.position.set(0, 0, 0); scene.updateMatrixWorld(true);
    expect(projectStudioDeepLights(scene).issues[0]?.code).toBe("invalid-light-direction");
    expect(projectStudioDeepLights(scene).lights).not.toHaveProperty("hemisphere");
  });
  it("does not use a default direction for coincident position and target", () => {
    const scene = new THREE.Scene(), sun = new THREE.DirectionalLight();
    sun.position.set(0, 0, 0); scene.add(sun, sun.target); scene.updateMatrixWorld(true);
    const result = projectStudioDeepLights(scene);
    expect(result.lights.directional).toEqual([]);
    expect(result.issues[0]?.code).toBe("invalid-light-direction");
  });
});
