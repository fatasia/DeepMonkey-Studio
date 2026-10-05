import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { DEFAULT_DISPLAY_CONTRACT } from "@bim-studio/contracts";
import { DEFAULT_PBR_RENDERER_FEATURES, resolvePbrEnvironmentIntensity,
  resolvePbrRendererFeatures } from "@bim-studio/deep-engine/webgpu";
import { DEFAULT_ENVIRONMENT, DEFAULT_POST_PROCESSING } from "../appDefaults";
import { compileSceneLighting } from "../delivery/compileSceneLighting";
import { DISPLAY_THREE_SHADOW_MAP_TYPE, resolveDynamicExposure, resolveGlobalIlluminationIntensity, DISPLAY_THREE_TONE_MAPPING, threeOutputColorSpaceFor,
  threeShadowMapTypeFor, threeToneMappingFor } from "./displayContractThree";
import { configureDirectionalShadow } from "./sceneShadowQuality";
import { projectStudioDeepEnvironment } from "./studioDeepEnvironment";

const contract = DEFAULT_DISPLAY_CONTRACT;

describe("three <-> Deep default display parity", () => {
  it("Deep engine defaults equal the display contract", () => {
    expect(DEFAULT_PBR_RENDERER_FEATURES.toneMapping).toBe(contract.toneMapping.operator);
    expect(resolvePbrRendererFeatures().toneMapping).toBe(contract.toneMapping.operator);
    expect(resolvePbrEnvironmentIntensity(undefined)).toBe(contract.environment.environmentIntensity);
  });

  it("three renderer enums are derived from the contract", () => {
    expect(DISPLAY_THREE_TONE_MAPPING).toBe(threeToneMappingFor(contract.toneMapping.operator));
    expect(DISPLAY_THREE_TONE_MAPPING).toBe(THREE.ACESFilmicToneMapping);
    expect(threeOutputColorSpaceFor(contract.outputColorSpace)).toBe(THREE.SRGBColorSpace);
    expect(DISPLAY_THREE_SHADOW_MAP_TYPE).toBe(threeShadowMapTypeFor(contract.shadow.filter));
    expect(DISPLAY_THREE_SHADOW_MAP_TYPE).toBe(THREE.PCFShadowMap);
    // three r186:PCFSoftShadowMap 已废弃,PCFShadowMap 本身即软阴影,"pcf-soft" 合同值随之统一映射
    expect(threeShadowMapTypeFor("pcf-soft")).toBe(THREE.PCFShadowMap);
  });

  it("dynamic exposure at unit intensity reproduces the static exposure", () => {
    const { base, intensityScale, min, max } = contract.toneMapping.dynamicExposure;
    expect(base + intensityScale * contract.environment.environmentIntensity).toBeCloseTo(contract.toneMapping.exposure, 10);
    expect(contract.toneMapping.exposure).toBeGreaterThanOrEqual(min);
    expect(contract.toneMapping.exposure).toBeLessThanOrEqual(max);
  });

  it("app defaults and directional shadow come from the contract", () => {
    expect(DEFAULT_ENVIRONMENT.environmentIntensity).toBe(contract.environment.environmentIntensity);
    expect(DEFAULT_POST_PROCESSING).toMatchObject({ smaa: contract.antialias.smaa, fxaa: contract.antialias.fxaa,
      gtao: contract.antialias.gtao, gtaoIntensity: contract.antialias.gtaoIntensity, bloom: contract.bloom.enabled,
      bloomStrength: contract.bloom.strength, bloomThreshold: contract.bloom.threshold });
    const light = new THREE.DirectionalLight();
    configureDirectionalShadow(light);
    expect(light.shadow.mapSize.x).toBe(contract.shadow.mapSize);
    expect(light.shadow.bias).toBe(contract.shadow.bias);
    expect(light.shadow.normalBias).toBe(contract.shadow.normalBias);
    expect(light.shadow.radius).toBe(contract.shadow.radius);
  });

  it("Studio Deep projection selects the contract tone-mapping operator and accepts the three default", () => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#102030");
    const projection = projectStudioDeepEnvironment({ scene, postProcessing: { ...DEFAULT_POST_PROCESSING, enabled: false },
      exposure: contract.toneMapping.exposure, toneMapping: DISPLAY_THREE_TONE_MAPPING, floorColor: new THREE.Color("#808080") });
    expect(projection.renderer.features?.toneMapping).toBe(contract.toneMapping.operator);
    expect(projection.issues.filter(issue => issue.code === "tone-mapping")).toEqual([]);
  });

  describe("missing-field defaults agree between three and Deep compile", () => {
    const light = { id: "sun", name: "Sun", type: "directional", enabled: true, color: "#ffffff", intensity: 1,
      position: { x: 1, y: 2, z: 3 }, castShadow: true };
    const lighting = (extra: Record<string, unknown> = {}) => ({ enabled: true, intensity: 1, shadowsEnabled: true,
      reflectionsEnabled: true, globalIlluminationEnabled: true, lights: [light], ...extra });
    const compile = (state: unknown) => compileSceneLighting(state, undefined, undefined, true);

    it("GI intensity falls back to the contract on both sides", () => {
      const expected = contract.environment.globalIlluminationIntensity;
      expect(resolveGlobalIlluminationIntensity(undefined)).toBe(expected);
      expect(resolveGlobalIlluminationIntensity(0)).toBe(0);
      expect(compile(lighting())?.globalIlluminationIntensity).toBe(expected);
      expect(compile(lighting({ globalIlluminationIntensity: 0.9 }))?.globalIlluminationIntensity).toBe(0.9);
    });

    it("dynamic exposure formula is identical for three and Deep compile", () => {
      for (const intensity of [0, 0.2, 1, 2, 2.5, 16]) {
        expect(compile(lighting({ intensity }))?.exposure).toBeCloseTo(resolveDynamicExposure(true, intensity), 10);
      }
      expect(compile(lighting({ enabled: false }))?.exposure).toBe(resolveDynamicExposure(false, 1));
      expect(resolveDynamicExposure(true, 1)).toBeCloseTo(contract.toneMapping.exposure, 10);
      expect(resolveDynamicExposure(true, 100)).toBe(contract.toneMapping.dynamicExposure.max);
    });
  });
});