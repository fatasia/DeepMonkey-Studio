import type { SceneSnapshot } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import { filterAndSortScenes, sceneThumbnailItems } from "./sceneManagerPresentation";

function scene(name: string, updatedAt: string, objects: number, published = false): SceneSnapshot {
  return {
    schemaVersion: 1,
    id: name,
    projectId: "project-1",
    name,
    createdAt: updatedAt,
    updatedAt,
    camera: { position: [0, 0, 0], target: [0, 0, 0], mode: "orbit" },
    models: [],
    primitives: Array.from({ length: objects }, (_, index) => ({
      modelId: `${name}-${index}`,
      name: String(index),
      kind: "box",
      color: "#ffffff",
      visible: true,
      opacity: 1,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    })),
    measurements: [],
    annotations: [],
    ...(published ? { publishedAt: updatedAt } : {}),
  } as unknown as SceneSnapshot;
}

describe("filterAndSortScenes", () => {
  const scenes = [
    scene("厂区总览", "2026-09-01T10:00:00.000Z", 3, true),
    scene("机器人单元", "2026-09-02T10:00:00.000Z", 8),
    scene("物流车间", "2026-08-31T10:00:00.000Z", 12),
  ];

  it("filters by query and publication status", () => {
    expect(filterAndSortScenes(scenes, "厂区", "published", "updated").map((item) => item.name)).toEqual(["厂区总览"]);
    expect(filterAndSortScenes(scenes, "", "draft", "updated").map((item) => item.name)).toEqual(["机器人单元", "物流车间"]);
  });

  it("sorts by object count", () => {
    expect(filterAndSortScenes(scenes, "", "all", "objects").map((item) => item.name)).toEqual(["物流车间", "机器人单元", "厂区总览"]);
  });

  it("builds thumbnail items from visible scene content and explicit colors", () => {
    const source = scene("缩略图", "2026-09-02T10:00:00.000Z", 1);
    source.models = [
      {
        modelId: "model-1", name: "设备", visible: true, opacity: 1, color: "#ff0000", colorOverride: "#12ab34",
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      },
      {
        modelId: "model-2", name: "保留原始材质的设备", visible: true, opacity: 1, color: "#ff0000",
        transform: { position: { x: 5, y: 0, z: 2 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      },
      {
        modelId: "hidden", name: "隐藏设备", visible: false, opacity: 1, colorOverride: "#abcdef",
        transform: { position: { x: 8, y: 0, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      },
    ];
    source.primitives[0]!.color = "#3456ef";
    source.primitives[0]!.transform.position = { x: 10, y: 0, z: 4 };

    expect(sceneThumbnailItems(source)).toMatchObject([
      { id: "model-1", kind: "model", color: "#12ab34" },
      { id: "model-2", kind: "model", color: "#708892" },
      { id: "缩略图-0", kind: "box", color: "#3456ef" },
    ]);
  });
});
