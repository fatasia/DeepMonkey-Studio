import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CASCADED_SHADOW_QUALITY_PROFILES } from "@bim-studio/deep-engine";
import { studioDeepShadowAllocation, studioDeepShadowMapSize, studioDeepShadowTier } from "./studioDeepShadowAllocation";

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
    light.layers.set(2); expect(studioDeepShadowMapSize(scene, 1)).toBe(2048);
    expect(studioDeepShadowMapSize(scene, 4)).toBe(2048);
    const parent = new THREE.Group(); parent.visible = false; scene.add(parent); parent.add(light);
    expect(studioDeepShadowMapSize(scene, 4)).toBe(2048);
    parent.visible = true; light.castShadow = false;
    expect(studioDeepShadowMapSize(scene, 4)).toBe(2048);
    light.castShadow = true; light.intensity = 0;
    expect(studioDeepShadowMapSize(scene, 4)).toBe(2048);
  });
  it.each([[32, 32], [NaN, NaN], [512, 1024], [32768, 32768], [64.5, 64.5]])(
    "does not allocate invalid inactive map %s × %s", (x, y) => {
      const { scene, light } = fixture(); light.shadow.mapSize.set(x, y);
      expect(studioDeepShadowMapSize(scene, 1)).toBe(2048);
    });
});

describe("Studio Deep shadow tier mapping (Z1 P1)", () => {
  it("maps every authored quality profile through the engine PROFILES table without drift", () => {
    // 与 adaptiveQuality.ts PROFILES 的 shadowTier 列逐项一致。
    expect(studioDeepShadowTier("performance")).toBe("performance");
    expect(studioDeepShadowTier("balanced")).toBe("balanced");
    expect(studioDeepShadowTier("quality")).toBe("high");
    expect(studioDeepShadowTier("ultra")).toBe("ultra");
  });

  it("resolves the zero-config tier to the audit's 4×2048 high profile", () => {
    for (const profile of [null, undefined] as const) {
      expect(studioDeepShadowTier(profile)).toBe("high");
    }
    expect(studioDeepShadowAllocation("high")).toBe(CASCADED_SHADOW_QUALITY_PROFILES.high.options);
    expect(studioDeepShadowAllocation("high")).toMatchObject({ cascadeCount: 4, shadowMapSize: 2048 });
    expect(studioDeepShadowAllocation("ultra")).toMatchObject({ cascadeCount: 4, shadowMapSize: 4096 });
    expect(studioDeepShadowAllocation("balanced")).toMatchObject({ cascadeCount: 3, shadowMapSize: 1536 });
    expect(studioDeepShadowAllocation("performance")).toMatchObject({ cascadeCount: 2, shadowMapSize: 1024 });
  });

  it("keeps the tier map size as the no-author-intent fallback only", () => {
    // 无作者阴影意图：兜底从 1024 提升为零配置档位尺寸（Z1 §4.1 2048）。
    const empty = new THREE.Scene();
    expect(studioDeepShadowMapSize(empty, 1)).toBe(2048);
    // 档位词汇驱动兜底：performance 档场景兜底 1024。
    expect(studioDeepShadowMapSize(empty, 1, studioDeepShadowAllocation("performance").shadowMapSize)).toBe(1024);
    // 作者显式配置优先于档位（引擎会话合同要求分配跟随作者值）。
    const { scene } = fixture();
    expect(studioDeepShadowMapSize(scene, 1, studioDeepShadowAllocation("performance").shadowMapSize)).toBe(2048);
  });

  function fixture() {
    const scene = new THREE.Scene(), light = new THREE.DirectionalLight();
    light.castShadow = true; light.shadow.mapSize.set(2048, 2048); scene.add(light);
    return { scene, light };
  }
});
