import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrateSceneSnapshotV1, type DataConnectionRecord, type DataDatasetRecord, type DataPipelineDefinition,
  type ProjectAssetRecord, type SceneSnapshot } from "@bim-studio/contracts";
import { SqliteStore } from "./sqliteStore.js";

describe("SqliteStore", () => {
  it("persists the shared metadata document and reopens it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "bim-studio-sqlite-"));
    try {
      const store = new SqliteStore(directory);
      await store.init();
      const project = await store.createProject("SQLite 项目", "单机验证");
      const now = "2026-09-24T00:00:00.000Z";
      const connection: DataConnectionRecord = { id: "connection-local", projectId: project.id, name: "本地模拟源",
        type: "simulation", enabled: true, config: { url: "sim://telemetry?rows=10" }, createdAt: now, updatedAt: now };
      const dataset: DataDatasetRecord = { id: "dataset-local", projectId: project.id, connectionId: connection.id,
        name: "本地趋势", refreshSeconds: 10, fields: [], createdAt: now, updatedAt: now };
      const pipeline: DataPipelineDefinition = { id: "pipeline-local", projectId: project.id, name: "本地数据管道",
        nodes: [{ id: "source", type: "source", name: "来源", datasetId: dataset.id, position: { x: 0, y: 0 } },
          { id: "output", type: "output", name: "输出", position: { x: 200, y: 0 } }],
        edges: [{ id: "source-output", sourceNodeId: "source", targetNodeId: "output" }], createdAt: now, updatedAt: now };
      const asset: ProjectAssetRecord = { id: "image-local", projectId: project.id, kind: "image", name: "工艺图",
        fileName: "process.png", mimeType: "image/png", size: 5, url: "/assets/process.png", createdAt: now, updatedAt: now };
      const scene: SceneSnapshot = { schemaVersion: 1, id: "scene-local", projectId: project.id, name: "本地场景",
        camera: { position: { x: 8, y: 6, z: 8 }, target: { x: 0, y: 1, z: 0 }, mode: "orbit" },
        models: [], primitives: [], measurements: [], createdAt: now, updatedAt: now };
      await store.saveAsset(project.id, asset);
      await store.saveDataConnection(project.id, connection);
      await store.saveDataset(project.id, dataset);
      await store.saveDataPipeline(project.id, pipeline);
      await store.saveScene(scene);
      const application = migrateSceneSnapshotV1(scene);
      expect((await store.createApplicationDraft(project.id, application, now)).status).toBe("created");
      const reopened = new SqliteStore(directory);
      await reopened.init();
      expect(reopened.getProject(project.id)?.name).toBe("SQLite 项目");
      expect(reopened.listProjects()).toHaveLength(2);
      expect(reopened.listAssets(project.id)).toEqual([asset]);
      expect(reopened.listDataConnections(project.id)).toEqual([connection]);
      expect(reopened.listDatasets(project.id)).toEqual([dataset]);
      expect(reopened.listDataPipelines(project.id)).toEqual([pipeline]);
      expect(reopened.listScenes(project.id)).toEqual([scene]);
      expect(reopened.listApplications(project.id)).toHaveLength(1);
      expect(await readFile(path.join(directory, "database.sqlite"))).toBeTruthy();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
