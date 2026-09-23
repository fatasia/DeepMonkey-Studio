import { describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { clearProbeGridBake, lookupProbeGridBake, probeGridBakeForPayload, probeGridBakeSourceHash,
  resetProbeGridBakeSessionForTest, storeProbeGridBake } from "./probeGridBakePublicationSession";

function scene(id = "scene", overrides: Partial<SceneSnapshot> = {}): SceneSnapshot {
  return { schemaVersion: 1, id, projectId: "project", name: "Scene", primitives: [], measurements: [],
    models: [], camera: { mode: "orbit", position: { x: 0, y: 2, z: 5 }, target: { x: 0, y: 0, z: 0 } },
    createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z", ...overrides } as SceneSnapshot;
}

function entry(probeCount = 8, coveredCount = 8) {
  return { bake: { origin: [0, 0, 0] as const, spacing: 4, gridSize: [2, 2, 2] as const,
    probes: Array.from({ length: probeCount }, () => ({ irradiance: [1, 2, 3] as const, validity: 1,
      meanDistance: 0, distanceVariance: 0 })) },
    probeCount, coveredCount, bakedAt: "2026-09-22T00:00:00Z" };
}


describe("probeGridBakePublicationSession（发布会话态承载）", () => {
  it("同场景存取一致； updatedAt/publishedAt 变化不改变键（与编译器投影同一口径）", () => {
    resetProbeGridBakeSessionForTest();
    const input = scene();
    storeProbeGridBake(input, entry());
    expect(lookupProbeGridBake(input)?.probeCount).toBe(8);
    expect(probeGridBakeForPayload(input)?.gridSize).toEqual([2, 2, 2]);
    const republished = scene("scene", { updatedAt: "2026-09-23T00:00:00Z", publishedAt: "2026-09-23T01:00:00Z" });
    expect(probeGridBakeSourceHash(republished)).toBe(probeGridBakeSourceHash(input));
    expect(probeGridBakeForPayload(republished)).toBeDefined();
  });

  it("发布决策字段（publishScene 写入 publication.snapshot 的三元组）不破坏键", () => {
    resetProbeGridBakeSessionForTest();
    const input = scene();
    storeProbeGridBake(input, entry());
    const published = scene("scene", { publicationMode: "webgpu-preferred",
      publicationPerformance: "standard", publicationToolbarVisible: false } as Partial<SceneSnapshot>);
    expect(probeGridBakeForPayload(published)).toBeDefined();
  });

  it("场景语义变化（灯光/模型）即失配：发布取不到，绝不携带陈旧烘焙", () => {
    resetProbeGridBakeSessionForTest();
    storeProbeGridBake(scene(), entry());
    const edited = scene("scene", { name: "Renamed" });
    // 名称属于编译源投影（只忽略 updatedAt/publishedAt），改名即失配。
    expect(probeGridBakeForPayload(edited)).toBeUndefined();
  });

  it("同场景重复烘焙覆盖旧结果；clearProbeGridBake 显式清除", () => {
    resetProbeGridBakeSessionForTest();
    const input = scene();
    storeProbeGridBake(input, entry(8, 8));
    storeProbeGridBake(input, entry(27, 20));
    expect(lookupProbeGridBake(input)?.probeCount).toBe(27);
    expect(lookupProbeGridBake(input)?.coveredCount).toBe(20);
    clearProbeGridBake(input);
    expect(probeGridBakeForPayload(input)).toBeUndefined();
  });

  it("会话上限内保留最近若干个场景，淘汰最旧（防长会话内存膨胀）", () => {
    resetProbeGridBakeSessionForTest();
    for (let index = 0; index < 6; index += 1) storeProbeGridBake(scene(`scene-${index}`), entry());
    // 上限 4：最早的 scene-0/scene-1 已被淘汰。
    expect(probeGridBakeForPayload(scene("scene-0"))).toBeUndefined();
    expect(probeGridBakeForPayload(scene("scene-1"))).toBeUndefined();
    expect(probeGridBakeForPayload(scene("scene-2"))).toBeDefined();
    expect(probeGridBakeForPayload(scene("scene-5"))).toBeDefined();
  });
});
