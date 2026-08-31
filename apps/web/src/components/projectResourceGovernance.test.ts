import { describe, expect, it } from "vitest";
import type { ApplicationDocument, ProjectRecord } from "@bim-studio/contracts";
import { analyzeProjectResourceGovernance } from "./projectResourceGovernance";

describe("analyzeProjectResourceGovernance", () => {
  it("tracks versions, dependencies, instance overrides, unused resources, and broken version references", () => {
    const project = {
      id: "project-1",
      models: [{ id: "model-1", name: "泵站模型" }],
      assets: [
        { id: "image-unused", name: "未使用背景", kind: "image", url: "/unused.png" },
        { id: "material-1", name: "工业钢板", kind: "pbr-material", url: "/steel/base.jpg", maps: [{ kind: "base-color", url: "/steel/base.jpg" }, { kind: "normal", url: "/steel/normal.jpg" }] },
        { id: "environment-1", name: "车间晨光", kind: "environment", url: "/environment.hdr", maps: [{ kind: "environment", url: "/environment.hdr" }] },
      ],
      unityResources: [{
        id: "unity-1",
        name: "产线交互包",
        activeVersionId: "unity-v2",
        versions: [{ id: "unity-v1", version: 1 }, { id: "unity-v2", version: 2 }],
      }],
    } as unknown as ProjectRecord;
    const application = {
      metadata: { id: "application-1", name: "泵站应用" },
      scenes: [{
        id: "scene-1",
        name: "泵站场景",
        models: [{
          modelId: "model-1",
          name: "主泵",
          visible: true,
          opacity: 0.8,
          material: { baseColorMapUrl: "/steel/base.jpg", normalMapUrl: "/steel/normal.jpg" },
          transform: {
            position: { x: 1, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
          },
        }],
        environment: { gridVisible: true, backgroundColor: "#101820", skybox: "studio", environmentMapUrl: "/environment.hdr" },
      }],
      pages: [{
        id: "page-1",
        name: "总览",
        nodes: [{
          id: "unity-widget",
          kind: "data-widget",
          name: "产线控制",
          widget: {
            title: "产线控制",
            unityResourceId: "unity-1",
            unityResourceVersionId: "missing-version",
            unityPropertyValues: { lightIntensity: 1.5 },
            unityDataBindings: [{ dataKey: "line.speed", layerKey: "speed" }],
          },
        }],
      }],
    } as unknown as ApplicationDocument;

    const report = analyzeProjectResourceGovernance(project, [application]);

    expect(report).toMatchObject({ definitionCount: 5, versionCount: 6, instanceCount: 4, overrideCount: 7, unusedCount: 1 });
    expect(report.resources.find((resource) => resource.id === "image-unused")?.unused).toBe(true);
    expect(report.resources.find((resource) => resource.id === "unity-1")?.versionLabel).toBe("v2");
    expect(report.resources.find((resource) => resource.id === "material-1")?.references[0]?.location).toContain("材质");
    expect(report.resources.find((resource) => resource.id === "environment-1")?.references[0]?.location).toContain("场景环境");
    expect(report.missingDependencies).toEqual([
      expect.objectContaining({ kind: "unity-version", resourceId: "missing-version", location: "总览 / 产线控制" }),
    ]);
  });
});
