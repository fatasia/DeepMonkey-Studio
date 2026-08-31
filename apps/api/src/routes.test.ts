import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import pureFixture from "../../../test-fixtures/scene-v1-pure-3d.json";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { loadConfig } from "./config.js";
import { registerRoutes } from "./routes.js";
import { JsonStore } from "./store.js";
import { createApiServer } from "./serverOptions.js";

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

describe("legacy scene routes", () => {
  it("preserves SceneSnapshot v1 save, publish, public, and browse behavior", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-scene-routes-"));
    directories.push(dataDir);
    const store = new JsonStore(dataDir);
    await store.init();
    const app = createApiServer();
    await registerRoutes(app, {
      store,
      queue: undefined as never,
      objects: undefined as never,
      dataDir,
      config: loadConfig()
    });
    const scene = structuredClone(pureFixture) as unknown as SceneSnapshot;
    scene.projectId = "default";
    scene.publicationToolbarVisible = false;

    const save = await app.inject({
      method: "PUT",
      url: "/api/projects/default/scenes/scene-pure-3d",
      payload: scene
    });
    const publication = await app.inject({
      method: "POST",
      url: "/api/projects/default/scenes/scene-pure-3d/publish"
    });
    const firstPublishedAt = publication.json().publishedAt as string;
    scene.name = "纯三维 - 第二版";
    scene.publicationToolbarVisible = true;
    await app.inject({ method: "PUT", url: "/api/projects/default/scenes/scene-pure-3d", payload: scene });
    const secondPublication = await app.inject({ method: "POST", url: "/api/projects/default/scenes/scene-pure-3d/publish" });
    const versions = await app.inject({ method: "GET", url: "/api/projects/default/scenes/scene-pure-3d/publications" });
    const restore = await app.inject({ method: "POST", url: `/api/projects/default/scenes/scene-pure-3d/publications/${encodeURIComponent(firstPublishedAt)}/restore` });

    expect(save.statusCode).toBe(200);
    expect(save.json().schemaVersion).toBe(1);
    expect(publication.statusCode).toBe(201);
    expect(publication.json().snapshot.schemaVersion).toBe(1);
    expect(publication.json().snapshot.publicationToolbarVisible).toBe(false);
    expect(secondPublication.statusCode).toBe(201);
    expect(versions.json().map((item: { version: number }) => item.version)).toEqual([2, 1]);
    expect(restore.statusCode).toBe(201);
    expect(restore.json().version).toBe(3);
    expect(restore.json().snapshot.name).toBe("纯三维");
    expect(restore.json().snapshot.publicationToolbarVisible).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/public/scenes/scene-pure-3d" })).json().snapshot.name).toBe("纯三维");
    const restoredDraft = (await app.inject({ method: "GET", url: "/api/scenes/scene-pure-3d/browse" })).json().scene;
    expect(restoredDraft.schemaVersion).toBe(1);
    expect(restoredDraft.name).toBe("纯三维 - 第二版");
    expect(restoredDraft.publishedAt).toBe(restore.json().publishedAt);
    expect(restoredDraft.publicationToolbarVisible).toBe(false);

    for (const length of [100, 101, 128]) {
      expect((await app.inject({ method: "GET", url: `/api/projects/${"a".repeat(length)}` })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: "GET", url: `/api/projects/${"a".repeat(129)}` })).statusCode).toBe(400);

    await app.close();
  });

  it("rejects unsafe dataset formulas before persistence", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-data-routes-"));
    directories.push(dataDir);
    const store = new JsonStore(dataDir);
    await store.init();
    const app = createApiServer();
    await registerRoutes(app, {
      store,
      queue: undefined as never,
      objects: undefined as never,
      dataDir,
      config: loadConfig()
    });
    await app.inject({
      method: "POST",
      url: "/api/projects/default/data-connections",
      payload: { id: "connection-1", name: "测试接口", type: "http", config: { url: "http://localhost/test" } }
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/projects/default/datasets",
      payload: { name: "告警指标", connectionId: "connection-1", computedFields: [{ id: "field-1", key: "risk", label: "风险", type: "number", formula: "process.exit()" }] }
    });
    const valid = await app.inject({
      method: "POST",
      url: "/api/projects/default/datasets",
      payload: { name: "温度指标", connectionId: "connection-1", computedFields: [{ id: "field-2", key: "fahrenheit", label: "华氏温度", type: "number", formula: "ROUND(temperature * 1.8 + 32, 1)" }] }
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().message).toContain("位置");
    expect(valid.statusCode).toBe(201);
    expect(valid.json().computedFields[0].formula).toBe("ROUND(temperature * 1.8 + 32, 1)");

    await app.close();
  });

  it("persists a built-in Kafka connection but rejects an unimplemented protocol", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-kafka-routes-"));
    directories.push(dataDir);
    const store = new JsonStore(dataDir);
    await store.init();
    const app = createApiServer();
    await registerRoutes(app, {
      store,
      queue: undefined as never,
      objects: undefined as never,
      dataDir,
      config: loadConfig()
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/default/data-connections",
      payload: { name: "生产事件流", type: "kafka", config: { url: "kafka://broker:9092" } }
    });
    const unsupported = await app.inject({ method: "POST", url: "/api/projects/default/data-connections", payload: { name: "Legacy protocol", type: "legacy-protocol", config: { url: "legacy://device" } } });
    const industrial = await app.inject({ method: "POST", url: "/api/projects/default/data-connections", payload: { name: "BACnet HVAC", type: "bacnet", config: { url: "bacnet://device:47808" } } });

    expect(response.statusCode).toBe(201);
    expect(store.listDataConnections("default").some((connection) => connection.type === "kafka")).toBe(true);
    expect(unsupported.statusCode).toBe(501);
    expect(unsupported.json().message).toContain("尚未内置");
    expect(industrial.statusCode).toBe(201);
    const readOnlyWrite = await app.inject({ method: "POST", url: `/api/projects/default/data-connections/${response.json().id}/write`, payload: { address: "topic", value: true } });
    expect(readOnlyWrite.statusCode).toBe(405);

    await app.close();
  });

  it("runs a real connection health probe without persisting a synthetic dataset", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-connection-health-"));
    directories.push(dataDir);
    const store = new JsonStore(dataDir);
    await store.init();
    const app = createApiServer();
    await registerRoutes(app, { store, queue: undefined as never, objects: undefined as never, dataDir, config: loadConfig() });
    await app.inject({ method: "POST", url: "/api/projects/default/data-connections", payload: { id: "sim-1", name: "模拟设备", type: "simulation", config: { url: "sim://telemetry?rows=2&seed=1" } } });
    const health = await app.inject({ method: "POST", url: "/api/projects/default/data-connections/sim-1/test", payload: {} });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, status: "healthy", rowCount: 2, fieldCount: 7 });
    const write = await app.inject({ method: "POST", url: "/api/projects/default/data-connections/sim-1/write", payload: { address: "pump.start", value: true } });
    expect(write.statusCode).toBe(202);
    expect(write.json()).toMatchObject({ address: "pump.start", value: true });
    const diagnostics = await app.inject({ method: "GET", url: "/api/projects/default/data-connections/diagnostics" });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json()).toContainEqual(expect.objectContaining({ connectionId: "sim-1", status: "healthy", totalReads: 1, totalWrites: 1 }));
    expect(store.listDatasets("default").some((item) => item.id === "probe:sim-1")).toBe(false);
    await app.close();
  });

  it("persists valid data pipelines and protects referenced datasets", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-pipeline-routes-"));
    directories.push(dataDir);
    const store = new JsonStore(dataDir);
    await store.init();
    const app = createApiServer();
    await registerRoutes(app, {
      store,
      queue: undefined as never,
      objects: undefined as never,
      dataDir,
      config: loadConfig()
    });
    await app.inject({ method: "POST", url: "/api/projects/default/data-connections", payload: { id: "connection-1", name: "设备接口", type: "http", config: { url: "http://localhost/test" } } });
    await app.inject({ method: "POST", url: "/api/projects/default/datasets", payload: { id: "dataset-1", name: "设备数据", connectionId: "connection-1" } });

    const saved = await app.inject({
      method: "POST",
      url: "/api/projects/default/data-pipelines",
      payload: {
        id: "pipeline-1",
        name: "设备告警流",
        nodes: [
          { id: "source", type: "source", name: "设备数据", datasetId: "dataset-1", position: { x: 0, y: 0 } },
          { id: "filter", type: "filter", name: "告警过滤", formula: "temperature > 30", position: { x: 220, y: 0 } },
          { id: "output", type: "output", name: "告警输出", position: { x: 440, y: 0 } }
        ],
        edges: [
          { id: "edge-1", sourceNodeId: "source", targetNodeId: "filter" },
          { id: "edge-2", sourceNodeId: "filter", targetNodeId: "output" }
        ]
      }
    });
    const list = await app.inject({ method: "GET", url: "/api/projects/default/data-pipelines" });
    const endpoint = await app.inject({ method: "POST", url: "/api/projects/default/data-endpoints", payload: { id: "endpoint-1", name: "设备告警 API", kind: "rest", slug: "device-alerts", pipelineId: "pipeline-1", method: "GET", requestsPerMinute: 30 } });
    const endpointUpdate = await app.inject({ method: "POST", url: "/api/projects/default/data-endpoints", payload: { id: "endpoint-1", name: "设备告警 API", kind: "rest", slug: "device-alerts", pipelineId: "pipeline-1", method: "GET", requestsPerMinute: 30 } });
    const endpointList = await app.inject({ method: "GET", url: "/api/projects/default/data-endpoints" });
    const blockedPipelineDelete = await app.inject({ method: "DELETE", url: "/api/projects/default/data-pipelines/pipeline-1" });
    const blockedDelete = await app.inject({ method: "DELETE", url: "/api/projects/default/datasets/dataset-1" });

    expect(saved.statusCode).toBe(201);
    expect(list.json()).toHaveLength(1);
    expect(endpoint.statusCode).toBe(201);
    expect(endpoint.json().apiKey).toMatch(/^bsp_/);
    expect(endpointUpdate.statusCode).toBe(200);
    expect(endpointUpdate.json()).not.toHaveProperty("apiKey");
    expect(endpointList.json()[0].apiKeyHint).toMatch(/^••••/);
    expect(endpointList.body).not.toContain(endpoint.json().apiKey);
    expect(blockedPipelineDelete.statusCode).toBe(409);
    expect(blockedDelete.statusCode).toBe(409);
    expect(blockedDelete.json().message).toContain("设备告警流");

    await app.close();
  });
});
