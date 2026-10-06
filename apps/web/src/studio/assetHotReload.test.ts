import type { ModelManifest, ModelRecord } from "@bim-studio/contracts";
import { describe, expect, it, vi } from "vitest";
import type { LoadedSceneModel } from "../viewer/ViewerEngine";
import {
  createAssetHotReloadService,
  loadedInstancesForModel,
  modelsReferencingAssetUrl,
  type AssetHotReloadEngine,
} from "./assetHotReload";

function manifest(modelId: string): ModelManifest {
  return { schemaVersion: 1, modelId, sourceName: `${modelId}.glb`, sourceFormat: "glb", viewerKind: "gltf", geometryUrl: `/assets/projects/p/models/${modelId}/output/geometry.glb`, createdAt: "now" };
}

function modelRecord(id: string, withManifest = true): ModelRecord {
  return { id, projectId: "p", name: id, status: "ready", ...(withManifest ? { manifest: manifest(id) } : {}) } as ModelRecord;
}

function loaded(id: string, assetModelId: string): LoadedSceneModel {
  return { id, assetModelId, name: id, object: {} as LoadedSceneModel["object"], kind: "model", visible: true, opacity: 1 };
}

function fakeEngine(instances: LoadedSceneModel[]) {
  const reloadCalls: Array<{ instanceId: string; modelId: string }> = [];
  const textureCalls: Array<{ url: string; token: string | number }> = [];
  let reloadError: Error | undefined;
  let textureResult = { url: "", refreshed: 0, failures: [] as string[] };
  const engine: AssetHotReloadEngine = {
    listModels: () => instances,
    reloadModelAsset: async (instanceId, manifest) => {
      if (reloadError) throw reloadError;
      reloadCalls.push({ instanceId, modelId: manifest.modelId });
      return instances.find(item => item.id === instanceId)!;
    },
    refreshManagedTextures: async (url, token) => {
      textureCalls.push({ url, token });
      return { ...textureResult, url };
    },
  };
  return { engine, reloadCalls, textureCalls, setReloadError: (error: Error | undefined) => { reloadError = error; }, setTextureResult: (result: { refreshed: number; failures: string[] }) => { textureResult = { ...textureResult, ...result }; } };
}

describe("asset hot reload propagation", () => {
  it("collects every running instance of one asset via the assetModelId index", () => {
    const legacy: LoadedSceneModel = { id: "legacy", name: "legacy", object: {} as LoadedSceneModel["object"], kind: "model", visible: true, opacity: 1 };
    const instances = [loaded("a", "asset"), loaded("b", "asset"), loaded("c", "other"), legacy];
    expect(loadedInstancesForModel(instances, "asset").map(item => item.id)).toEqual(["a", "b"]);
    expect(loadedInstancesForModel(instances, "legacy").map(item => item.id)).toEqual(["legacy"]);
  });

  it("reloads every instance of the model asset and reports the count", async () => {
    const instances = [loaded("a", "asset"), loaded("b", "asset")];
    const h = fakeEngine(instances);
    const service = createAssetHotReloadService(h.engine, [modelRecord("asset")]);
    const report = await service.reloadModelAssetInstances(modelRecord("asset"));
    expect(report).toMatchObject({ kind: "model", status: "updated", updated: 2, failures: [] });
    expect(h.reloadCalls.map(call => call.instanceId)).toEqual(["a", "b"]);
  });

  it("reports unused without touching the engine when no instance is mounted", async () => {
    const h = fakeEngine([]);
    const service = createAssetHotReloadService(h.engine, [modelRecord("asset")]);
    const report = await service.reloadModelAssetInstances(modelRecord("asset"));
    expect(report).toMatchObject({ kind: "model", status: "unused", updated: 0 });
    expect(h.reloadCalls).toEqual([]);
  });

  it("fails fast with a message when the asset has no usable manifest", async () => {
    const h = fakeEngine([loaded("a", "asset")]);
    const service = createAssetHotReloadService(h.engine, [modelRecord("asset")]);
    const report = await service.reloadModelAssetInstances(modelRecord("asset", false));
    expect(report.status).toBe("failed");
    expect(report.failures[0]).toContain("清单");
    expect(h.reloadCalls).toEqual([]);
  });

  it("keeps succeeded instances and discloses failures per instance (fail-closed)", async () => {
    const instances = [loaded("a", "asset"), loaded("b", "asset")];
    const h = fakeEngine(instances);
    const service = createAssetHotReloadService(h.engine, [modelRecord("asset")]);
    const originalReload = h.engine.reloadModelAsset.bind(h.engine);
    vi.spyOn(h.engine, "reloadModelAsset").mockImplementation(async (instanceId, manifest) => {
      if (instanceId === "b") throw new Error("结构不兼容");
      return originalReload(instanceId, manifest);
    });
    const report = await service.reloadModelAssetInstances(modelRecord("asset"));
    expect(report.status).toBe("updated");
    expect(report.updated).toBe(1);
    expect(report.failures[0]).toContain("b");
    expect(report.failures[0]).toContain("结构不兼容");
  });

  it("reports failed when every instance reload throws", async () => {
    const h = fakeEngine([loaded("a", "asset")]);
    h.setReloadError(new Error("network down"));
    const service = createAssetHotReloadService(h.engine, [modelRecord("asset")]);
    const report = await service.reloadModelAssetInstances(modelRecord("asset"));
    expect(report.status).toBe("failed");
    expect(report.failures[0]).toContain("network down");
  });

  it("coalesces concurrent reloads of the same asset into one engine pass", async () => {
    const h = fakeEngine([loaded("a", "asset")]);
    const service = createAssetHotReloadService(h.engine, [modelRecord("asset")]);
    const [first, second] = await Promise.all([
      service.reloadModelAssetInstances(modelRecord("asset")),
      service.reloadModelAssetInstances(modelRecord("asset")),
    ]);
    expect(h.reloadCalls).toHaveLength(1);
    expect(first.status).toBe("updated");
    expect(second.status).toBe("updated");
  });
});

describe("asset hot reload by changed url", () => {
  it("dispatches model instances when a manifest references the url", async () => {
    const record = modelRecord("asset");
    const h = fakeEngine([loaded("a", "asset")]);
    const service = createAssetHotReloadService(h.engine, [record]);
    const report = await service.reloadAssetByUrl(`${record.manifest!.geometryUrl}`);
    expect(report.kind).toBe("model");
    expect(report.status).toBe("updated");
    expect(h.reloadCalls.map(call => call.modelId)).toEqual(["asset"]);
    expect(h.textureCalls).toEqual([]);
  });

  it("falls back to the managed-texture path for non-manifest urls", async () => {
    const h = fakeEngine([]);
    h.setTextureResult({ refreshed: 2, failures: [] });
    const service = createAssetHotReloadService(h.engine, [modelRecord("asset")]);
    const report = await service.reloadAssetByUrl("/assets/projects/p/assets/img/tex.png");
    expect(report).toMatchObject({ kind: "texture", status: "updated", updated: 2 });
    expect(h.textureCalls).toHaveLength(1);
    expect(h.textureCalls[0]!.url).toBe("/assets/projects/p/assets/img/tex.png");
  });

  it("reports unused textures without failing", async () => {
    const h = fakeEngine([]);
    const service = createAssetHotReloadService(h.engine, []);
    const report = await service.reloadAssetByUrl("/assets/projects/p/assets/img/unused.png");
    expect(report).toMatchObject({ kind: "texture", status: "unused", updated: 0 });
  });

  it("propagates texture refresh failures", async () => {
    const h = fakeEngine([]);
    h.setTextureResult({ refreshed: 0, failures: ["sRGB 纹理重取失败：502"] });
    const service = createAssetHotReloadService(h.engine, []);
    const report = await service.reloadAssetByUrl("/tex.png");
    expect(report.status).toBe("failed");
    expect(report.failures[0]).toContain("502");
  });

  it("maps urls to referencing models through the manifest index", () => {
    const record = modelRecord("asset");
    const lodUrl = "/assets/projects/p/models/asset/output/geometry-low.glb";
    const records = [{ ...record, manifest: { ...record.manifest!, lods: [{ level: "low" as const, ratio: 0.5, url: lodUrl }] } }];
    expect(modelsReferencingAssetUrl(records, lodUrl).map(item => item.id)).toEqual(["asset"]);
    expect(modelsReferencingAssetUrl(records, "/unrelated.glb")).toEqual([]);
  });
});
