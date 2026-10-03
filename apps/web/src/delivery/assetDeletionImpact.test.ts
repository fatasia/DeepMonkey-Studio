import { describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { computeAssetDeletionImpact, describeAssetDeletionImpact } from "./assetDeletionImpact";

const baseScene = (overrides: Partial<SceneSnapshot> & { id: string; name: string }): SceneSnapshot =>
  ({
    schemaVersion: 1,
    projectId: "p1",
    camera: {} as SceneSnapshot["camera"],
    models: [],
    primitives: [],
    measurements: [],
    ...overrides,
  }) as unknown as SceneSnapshot;

describe("删除引用影响检查", () => {
  it("空输入与非法 targetId 合同", () => {
    expect(() => computeAssetDeletionImpact("", [])).toThrow(/targetId/);
    const impact = computeAssetDeletionImpact("asset-x", []);
    expect(impact.totalReferences).toBe(0);
    expect(impact.scenes).toEqual([]);
    expect(describeAssetDeletionImpact(impact)).toBeUndefined();
  });

  it("识别模型实例精确引用与资产 URL 引用,报告字段路径", () => {
    const scene = baseScene({
      id: "s1",
      name: "厂房",
      models: [
        { modelId: "asset-x", name: "目标模型" },
        { modelId: "asset-other", name: "无关" },
      ],
      environment: { settings: { backgroundUrl: "/api/projects/p1/assets/asset-x/file" } },
    } as never);
    const impact = computeAssetDeletionImpact("asset-x", [scene]);
    expect(impact.totalReferences).toBe(2);
    expect(impact.scenes[0]!.sceneName).toBe("厂房");
    expect(impact.scenes[0]!.references).toEqual(["environment.settings.backgroundUrl", "models[0].modelId"]);
    expect(describeAssetDeletionImpact(impact)).toContain("厂房");
    expect(describeAssetDeletionImpact(impact)).toContain("共 2 处引用");
  });

  it("嵌套数组/材质 map 引用与多场景汇总、无引用场景不出现", () => {
    const scenes = [
      baseScene({
        id: "s1", name: "A",
        models: [{ modelId: "keep", name: "k" }],
      } as never),
      baseScene({
        id: "s2", name: "B",
        models: [
          { modelId: "asset-y", name: "m1" },
          { modelId: "asset-y", name: "m2" },
        ],
      } as never),
      baseScene({
        id: "s3", name: "C",
        primitives: [{ materialMaps: { baseColor: "/api/projects/p/assets/asset-y/f" } }],
      } as never),
    ];
    const impact = computeAssetDeletionImpact("asset-y", scenes);
    expect(impact.scenes.map(scene => scene.sceneId)).toEqual(["s2", "s3"]);
    expect(impact.totalReferences).toBe(3);
    expect(impact.scenes[0]!.references).toEqual(["models[0].modelId", "models[1].modelId"]);
    const summary = describeAssetDeletionImpact(impact)!;
    expect(summary).toContain("「B」(2 处)");
    expect(summary).toContain("「C」(1 处)");
    expect(summary).not.toContain("等 2 个场景");
  });
});
