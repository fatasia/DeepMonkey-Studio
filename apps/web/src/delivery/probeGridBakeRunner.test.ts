import { describe, expect, it } from "vitest";
import type { GlobalLightingState, ProjectRecord } from "@bim-studio/contracts";
import { runProbeGridBake } from "./probeGridBakeRunner";
import { probeGridBakeSourceHash, storeProbeGridBake, resetProbeGridBakeSessionForTest } from "./probeGridBakePublicationSession";
import { resolveProbeGridPayloadInput } from "./sceneClientPackage";

// 光照映射与模型加载走真实实现；runner 的 GPU 段（requestDevice/烘焙服务）由
// deep-engine 既有测试与真机取证覆盖，本文件不重复（真机全链列为未验证边界）。

const directionalLight = { id: "sun", name: "主方向光", type: "directional", color: "#ffffff",
  intensity: 2, enabled: true, castShadow: true,
  position: { x: 4, y: 8, z: 4 }, target: { x: 0, y: 0, z: 0 } } as never;

function lighting(overrides: Partial<GlobalLightingState> = {}): GlobalLightingState {
  return { enabled: true, intensity: 1, shadowsEnabled: false, reflectionsEnabled: false,
    globalIlluminationEnabled: false, lights: [directionalLight], ...overrides } as GlobalLightingState;
}

describe("probeRadianceLightingForBake（场景灯光 → 烘焙辐射源映射）", () => {
  it("方向光映射：direction 原样作为 surfaceToLightWorld（与 Native surface_to_light 同义）", async () => {
    const { probeRadianceLightingForBake } = await import("./probeGridBakeRunner");
    const result = probeRadianceLightingForBake(lighting(), "sunny");
    // compileSceneLighting：direction = normalize(position - target)，radiance 预乘强度。
    const length = Math.hypot(4, 8, 4);
    expect(result.primary?.surfaceToLightWorld).toEqual([4 / length, 8 / length, 4 / length]);
    expect(result.primary?.color).toEqual([2, 2, 2]);
    expect(result.primary?.intensity).toBe(1);
    expect(result.ambient).toEqual([0, 0, 0]);
  });

  it("非晴天天气 fail-closed（与发布编译同一拒绝口径）", async () => {
    const { probeRadianceLightingForBake } = await import("./probeGridBakeRunner");
    expect(() => probeRadianceLightingForBake(lighting(), "rain")).toThrow(/无法编译/);
  });

  it("灯光组合不满足发布编译要求（反射开）fail-closed", async () => {
    const { probeRadianceLightingForBake } = await import("./probeGridBakeRunner");
    expect(() => probeRadianceLightingForBake(lighting({ reflectionsEnabled: true }), "sunny"))
      .toThrow(/无法编译/);
  });

  it("直射光能量为零（全局关闭）提前报错，不发起 GPU 烘焙", async () => {
    const { probeRadianceLightingForBake } = await import("./probeGridBakeRunner");
    expect(() => probeRadianceLightingForBake(lighting({ enabled: false }), "sunny"))
      .toThrow(/直射光辐射源/);
  });
});

describe("runProbeGridBake 参数合同", () => {
  it("缺少模型资源时报出可操作的错误", async () => {
    const { buildSceneModelLoader } = await import("./probeGridBakeRunner");
    const loader = buildSceneModelLoader([
      { id: "asset", projectId: "project", status: "ready", name: "Box.glb",
        manifest: {} } as ProjectRecord["models"][number],
    ]);
    await expect(loader("asset", new AbortController().signal)).rejects.toThrow(/烘焙缺少模型资源/);
  });

  it("onPhase 按阶段推进；GPU 不可用时报浏览器支持提示", async () => {
    const phases: string[] = [];
    const input = { schemaVersion: 1, id: "scene", projectId: "project", name: "Scene", primitives: [],
      measurements: [], models: [], camera: { mode: "orbit", position: { x: 0, y: 2, z: 5 }, target: { x: 0, y: 0, z: 0 } },
      createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z",
      lighting: lighting() } as never as Parameters<typeof runProbeGridBake>[0]["scene"];
    await expect(runProbeGridBake({ scene: input, models: [], grid: { origin: [0, 0, 0], spacing: 4, gridSize: [2, 2, 2] },
      onPhase: phase => phases.push(phase) })).rejects.toThrow(/WebGPU/);
    // 光照映射先行：编译阶段之前已经 fail-fast 的场景不会推进任何阶段。
    expect(phases).toContain("compile-scene");
  });
});

describe("resolveProbeGridPayloadInput（发布会话态 → Deep Native 编译输入）", () => {
  it("会话态为空时不携带（null），包语义与历史一致", () => {
    resetProbeGridBakeSessionForTest();
    const scene = { schemaVersion: 1, id: "scene", projectId: "project", name: "Scene" } as never as Parameters<typeof probeGridBakeSourceHash>[0];
    expect(resolveProbeGridPayloadInput(scene)).toEqual({ irradianceProbes: null });
  });

  it("会话态命中时携带 bake", () => {
    resetProbeGridBakeSessionForTest();
    const scene = { schemaVersion: 1, id: "scene", projectId: "project", name: "Scene" } as never as Parameters<typeof probeGridBakeSourceHash>[0];
    const baked = { bake: { origin: [0, 0, 0] as const, spacing: 4, gridSize: [2, 2, 2] as const,
      probes: [{ irradiance: [1, 2, 3] as const, validity: 1, meanDistance: 0, distanceVariance: 0 }] },
      probeCount: 1, coveredCount: 1, bakedAt: "2026-09-22T00:00:00Z" };
    storeProbeGridBake(scene, baked);
    expect(resolveProbeGridPayloadInput(scene).irradianceProbes).toBe(baked.bake);
  });

  it("显式透传优先于会话态；显式 null 强制不带", () => {
    resetProbeGridBakeSessionForTest();
    const scene = { schemaVersion: 1, id: "scene", projectId: "project", name: "Scene" } as never as Parameters<typeof probeGridBakeSourceHash>[0];
    const baked = { bake: { origin: [0, 0, 0] as const, spacing: 4, gridSize: [2, 2, 2] as const,
      probes: [] }, probeCount: 0, coveredCount: 0, bakedAt: "2026-09-22T00:00:00Z" };
    storeProbeGridBake(scene, baked);
    const explicit = { origin: [1, 1, 1] as const, spacing: 2, gridSize: [2, 2, 2] as const, probes: [] };
    expect(resolveProbeGridPayloadInput(scene, explicit).irradianceProbes).toBe(explicit);
    expect(resolveProbeGridPayloadInput(scene, null).irradianceProbes).toBeNull();
  });
});
