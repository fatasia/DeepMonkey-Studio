import { describe, expect, it } from "vitest";
import type { ProjectRecord, PublishedSceneRecord } from "@bim-studio/contracts";
import { createPublishedSceneBrowseRecord } from "./publishedSceneBundle.js";

describe("published scene browse boundary", () => {
  it("keeps only referenced render assets and excludes project integrations", () => {
    const publishedAt = "2026-08-31T08:00:00.000Z";
    const publication = {
      sceneId: "scene-1",
      projectId: "project-1",
      name: "装配线",
      publishedAt,
      snapshot: {
        id: "scene-1",
        projectId: "project-1",
        name: "装配线",
        schemaVersion: 1,
        models: [{ modelId: "model-used", name: "机器人", visible: true }],
        primitives: [],
        measurements: [],
        objects: [],
        layers: [],
        settings: {},
        camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
        environment: { environmentMapUrl: "/assets/projects/project-1/assets/env/factory.hdr" },
        createdAt: publishedAt,
        updatedAt: publishedAt,
        publishedAt,
      },
    } as PublishedSceneRecord;
    const project = {
      id: "project-1",
      name: "工厂",
      description: "",
      models: [
        { id: "model-used", projectId: "project-1", name: "机器人", format: "glb", size: 1, status: "ready", progress: 100, message: "", sourceUrl: "/assets/robot.glb", createdAt: publishedAt, updatedAt: publishedAt },
        { id: "model-unused", projectId: "project-1", name: "未使用", format: "glb", size: 1, status: "ready", progress: 100, message: "", sourceUrl: "/assets/unused.glb", createdAt: publishedAt, updatedAt: publishedAt },
      ],
      assets: [
        { id: "env", projectId: "project-1", kind: "image", name: "环境", fileName: "factory.hdr", mimeType: "image/vnd.radiance", size: 1, url: "/assets/projects/project-1/assets/env/factory.hdr", createdAt: publishedAt, updatedAt: publishedAt },
        { id: "unused", projectId: "project-1", kind: "image", name: "未使用", fileName: "unused.png", mimeType: "image/png", size: 1, url: "/assets/unused.png", createdAt: publishedAt, updatedAt: publishedAt },
      ],
      dataConnections: [{ id: "private" }],
      createdAt: publishedAt,
      updatedAt: publishedAt,
    } as ProjectRecord;

    const result = createPublishedSceneBrowseRecord(publication, project);

    expect(result.project.models.map((model) => model.id)).toEqual(["model-used"]);
    expect(result.project.assets?.map((asset) => asset.id)).toEqual(["env"]);
    expect(result.project.dataConnections).toBeUndefined();
  });
});
