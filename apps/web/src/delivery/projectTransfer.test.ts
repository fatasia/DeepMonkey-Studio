import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertApplicationDocument, migrateSceneSnapshotV1, type ApplicationDocument, type ModelRecord, type ProjectRecord, type SceneSnapshot } from "@bim-studio/contracts";
import sceneFixture from "../../../../test-fixtures/scene-v1-dashboard.json";
import { createProjectTransfer, sanitizeTransferContent, validateProjectTransfer } from "./projectTransferModel";
import { readProjectTransfer, transferSha256, type ProjectTransferArchive } from "./projectTransferArchive";
import { ProjectTransferImport } from "./projectTransferImport";

const disk = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../studio/recoveryDatabase", () => ({
  readRecoveryRecord: vi.fn(async (key: string) => structuredClone(disk.get(key))),
  writeRecoveryRecord: vi.fn(async (value: { key: string }) => { disk.set(value.key, structuredClone(value)); }),
}));
beforeEach(() => disk.clear());

function sample() {
  const scene = structuredClone(sceneFixture) as unknown as SceneSnapshot;
  scene.models = [{ modelId: "instance-A", assetModelId: "asset-old", name: "设备", visible: true, opacity: 1,
    transform: { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }];
  const project = { id: scene.projectId, name: "交付原项目", description: "离线示例", createdAt: scene.createdAt, updatedAt: scene.updatedAt,
    models: [{ id: "asset-old", name: "设备.ifc", status: "ready", sourceUrl: "/original.ifc", manifest: { geometryUrl: "/assets/model.glb" } }],
    assets: [{ id: "image-old", projectId: scene.projectId, kind: "image", name: "工艺图", fileName: "process.png",
      mimeType: "image/png", size: 5, url: "/assets/process.png", createdAt: scene.createdAt, updatedAt: scene.updatedAt }],
    dataConnections: [{ id: "connection-old", projectId: scene.projectId, name: "生产连接", type: "postgresql", enabled: true,
      config: { password: "private-secret", passwordEnv: "DB_SECRET", url: "postgres://private" }, createdAt: scene.createdAt, updatedAt: scene.updatedAt }],
    datasets: [{ id: "dataset-old", projectId: scene.projectId, connectionId: "connection-old", name: "趋势", refreshSeconds: 10, fields: [], createdAt: scene.createdAt, updatedAt: scene.updatedAt }],
    dataPipelines: [{ id: "pipeline-old", projectId: scene.projectId, name: "生产趋势",
      nodes: [{ id: "source", type: "source", name: "来源", datasetId: "dataset-old", position: { x: 0, y: 0 } },
        { id: "output", type: "output", name: "输出", position: { x: 200, y: 0 } }],
      edges: [{ id: "source-output", sourceNodeId: "source", targetNodeId: "output" }], createdAt: scene.createdAt, updatedAt: scene.updatedAt }],
  } as unknown as ProjectRecord;
  const application = migrateSceneSnapshotV1(scene);
  application.scriptDependencies = [{ id: "dependency-old", specifier: "@plant/math", source: "upload", requested: "@plant/math",
    fileName: "plant-math.mjs", assetUrl: "/api/projects/original/script-dependencies/dependency-old/content",
    integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=", size: 18, installedAt: scene.createdAt }];
  const document = createProjectTransfer(project, [scene], [application]);
  const contents = new Map(document.files.map(file => [file.id, new File([
    document.dependencies.some(item => item.fileId === file.id) ? "export const sum=1" : file.name.endsWith(".png") ? "image" : "model",
  ], file.name)]));
  return { project, scene, application, document, archive: { document, files: contents } satisfies ProjectTransferArchive };
}

function client() {
  const projects = new Map<string, ProjectRecord>(); const applications = new Map<string, ApplicationDocument>();
  const savedScenes: SceneSnapshot[] = [];
  const result = {
    createProject: vi.fn(async (name: string) => { const id = `new-project-${projects.size}`; const value = { id, name, models: [] } as unknown as ProjectRecord; projects.set(id, value); return value; }),
    getProject: vi.fn(async (id: string) => { const value = projects.get(id); if (!value) throw new Error("404"); return value; }),
    uploadModel: vi.fn(async (id: string) => { const model = { id: `new-model-${projects.get(id)!.models.length}`, status: "ready" } as ModelRecord; projects.get(id)!.models.push(model); return model; }),
    renameModel: vi.fn(async () => undefined),
    createDataConnection: vi.fn(async (_id: string, _value: unknown) => undefined), createDataset: vi.fn(async (_id: string, _value: unknown) => undefined), saveDataPipeline: vi.fn(async () => undefined),
    saveScene: vi.fn(async (scene: SceneSnapshot) => { savedScenes.push(scene); return scene; }),
    getApplication: vi.fn(async (_project: string, id: string) => { const value = applications.get(id); if (!value) throw new Error("404"); return value; }),
    createApplication: vi.fn(async (document: ApplicationDocument) => { assertApplicationDocument(document); applications.set(document.metadata.id, document); return document; }),
    saveApplication: vi.fn(async (document: ApplicationDocument) => { applications.set(document.metadata.id, document); return document; }),
    uploadImageAsset: vi.fn(async (id: string, file: File) => ({ id: "new-image-0", projectId: id, kind: "image", name: file.name,
      fileName: file.name, mimeType: file.type || "image/png", size: file.size, url: "/assets/new-process.png", createdAt: "now", updatedAt: "now" })),
    uploadVideoAsset: vi.fn(), uploadEnvironmentMap: vi.fn(), uploadMaterialAsset: vi.fn(),
    uploadScriptDependency: vi.fn(async (_id: string, specifier: string, file: File) => ({ id: "new-dependency-0", specifier,
      source: "upload", requested: specifier, fileName: file.name, assetUrl: "/script-dependencies/new-dependency-0/content",
      integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=", size: file.size, installedAt: "now" })),
    renameAsset: vi.fn(),
  };
  return { result, projects, applications, savedScenes, api: result as unknown as ConstructorParameters<typeof ProjectTransferImport>[1] };
}

describe("project transfer", () => {
  it("exports an allowlist and removes credentials while keeping page content and stable object identities", () => {
    const { document, application, project } = sample();
    expect(document.applications[0]?.pages).toEqual(application.pages);
    expect(JSON.stringify(document)).not.toMatch(/private-secret|DB_SECRET|postgres:\/\/private/);
    expect(document.runtime.connections[0]).toMatchObject({ enabled: false, config: {} });
    expect(document.files[0]?.name).toBe("设备.glb");
    expect(document.models).toHaveLength(1);
    expect(document.assets).toEqual([expect.objectContaining({ originalId: "image-old", kind: "image" })]);
    expect(document.dependencies).toEqual([expect.objectContaining({ originalId: "dependency-old", specifier: "@plant/math" })]);
    expect(document.runtime.datasets).toEqual([expect.objectContaining({ id: "dataset-old", connectionId: "connection-old" })]);
    expect(document.runtime.pipelines).toEqual([expect.objectContaining({ id: "pipeline-old", projectId: project.id })]);
    expect(sanitizeTransferContent({ url: "https://user:pw@host/path?token=secret&x=1", headers: { Authorization: "secret" } }))
      .toEqual({ url: "https://host/path?x=1" });
    validateProjectTransfer(document);
  });

  it("verifies archive contents, flags absent files and rejects hash tampering or undeclared paths", async () => {
    const { document } = sample(); const file = document.files[0]!;
    const bytes = new TextEncoder().encode("model").buffer; file.bytes = bytes.byteLength; file.sha256 = await transferSha256(bytes);
    const zip = new JSZip().file("project.json", JSON.stringify(document)).file(file.path, bytes);
    const packed = new File([await zip.generateAsync({ type: "arraybuffer" })], "project.bimproject");
    expect((await readProjectTransfer(packed)).files.size).toBe(1);
    zip.remove(file.path);
    expect((await readProjectTransfer(new File([await zip.generateAsync({ type: "arraybuffer" })], "missing.bimproject"))).files.size).toBe(0);
    zip.file(file.path, "wrong");
    await expect(readProjectTransfer(new File([await zip.generateAsync({ type: "arraybuffer" })], "bad.bimproject"))).rejects.toThrow("校验失败");
    file.path = "../bad"; expect(() => validateProjectTransfer(document)).toThrow("路径无效");
  });

  it("imports independent IDs, retains instance bindings and resumes a failed run without duplicating uploaded models", async () => {
    const { archive, project } = sample(); const fake = client();
    fake.result.saveScene.mockRejectedValueOnce(new Error("503"));
    const importOne = new ProjectTransferImport(archive, fake.api);
    await expect(importOne.run("交付副本", new AbortController().signal, vi.fn())).rejects.toThrow("503");
    const reloaded = new ProjectTransferImport(archive, fake.api);
    const imported = await reloaded.run("交付副本", new AbortController().signal, vi.fn());
    expect(imported.id).not.toBe(project.id); expect(fake.result.createProject).toHaveBeenCalledTimes(1);
    expect(fake.result.uploadModel).toHaveBeenCalledTimes(1);
    expect(fake.savedScenes[0]?.models[0]).toMatchObject({ modelId: "instance-A", assetModelId: "new-model-0" });
    expect(fake.result.createDataConnection).toHaveBeenCalledWith(imported.id, expect.objectContaining({ enabled: false, config: {} }));
    expect(fake.result.uploadImageAsset).toHaveBeenCalledTimes(1);
    expect(fake.result.uploadScriptDependency).toHaveBeenCalledWith(imported.id, "@plant/math", expect.any(File), { prepared: true });
    expect(fake.result.saveDataPipeline).toHaveBeenCalledWith(imported.id, expect.objectContaining({ projectId: imported.id,
      id: expect.not.stringMatching(/^pipeline-old$/), nodes: [expect.objectContaining({ datasetId: expect.not.stringMatching(/^dataset-old$/) }), expect.anything()] }));
    const saved = [...fake.applications.values()][0]!;
    expect(saved.metadata.projectId).toBe(imported.id);
    expect(saved.scenes[0]?.models[0]?.modelId).toBe("instance-A");
    expect(fake.result.createDataset.mock.calls[0]?.[0]).toBe(imported.id);
    expect(fake.result.getProject.mock.calls.every(([id]) => id !== project.id)).toBe(true);
    // A completed package can create another independent copy; only unfinished imports resume.
    await new ProjectTransferImport(archive, fake.api).run("交付副本二", new AbortController().signal, vi.fn());
    expect(fake.result.createProject).toHaveBeenCalledTimes(2);
  });

  it("uses the same import contract in both local and SaaS directions", async () => {
    const local = client(); const saas = client();
    const localResult = await new ProjectTransferImport(sample().archive, local.api).run("本地副本", new AbortController().signal, vi.fn());
    const saasResult = await new ProjectTransferImport(sample().archive, saas.api).run("服务器副本", new AbortController().signal, vi.fn());
    for (const target of [local, saas]) {
      expect(target.result.uploadModel).toHaveBeenCalledTimes(1);
      expect(target.result.uploadImageAsset).toHaveBeenCalledTimes(1);
      expect(target.result.uploadScriptDependency).toHaveBeenCalledTimes(1);
      expect(target.result.createDataConnection).toHaveBeenCalledTimes(1);
      expect(target.result.createDataset).toHaveBeenCalledTimes(1);
      expect(target.result.saveDataPipeline).toHaveBeenCalledTimes(1);
      expect(target.result.saveScene).toHaveBeenCalledTimes(1);
      expect(target.result.createApplication).toHaveBeenCalledTimes(1);
    }
    expect(localResult.name).toBe("本地副本");
    expect(saasResult.name).toBe("服务器副本");
  });

  it("blocks missing files and cancellation before creation", async () => {
    const { archive } = sample(); const fake = client(); archive.files.clear();
    await expect(new ProjectTransferImport(archive, fake.api).run("x", new AbortController().signal, vi.fn())).rejects.toThrow("补齐");
    expect(fake.result.createProject).not.toHaveBeenCalled();
    archive.files.set(archive.document.files[0]!.id, new File(["model"], "model.glb"));
    const signal = AbortSignal.abort();
    await expect(new ProjectTransferImport(archive, fake.api).run("x", signal, vi.fn())).rejects.toThrow();
    expect(fake.result.createProject).not.toHaveBeenCalled();
  });

  it("detects replacement files after a refresh and rewrites already completed scenes before retrying the application", async () => {
    const { archive } = sample(); const fake = client();
    fake.result.createApplication.mockRejectedValueOnce(new Error("503 application"));
    await expect(new ProjectTransferImport(archive, fake.api).run("copy", new AbortController().signal, vi.fn())).rejects.toThrow("503");
    const reloaded = new ProjectTransferImport(archive, fake.api);
    reloaded.replaceFile(archive.document.files[0]!.id, new File(["replacement geometry"], "replacement.glb"));
    await reloaded.run("copy", new AbortController().signal, vi.fn());
    expect(fake.result.createProject).toHaveBeenCalledTimes(1); expect(fake.result.uploadModel).toHaveBeenCalledTimes(2);
    expect(fake.savedScenes.at(-1)?.models[0]).toMatchObject({ modelId: "instance-A", assetModelId: "new-model-1" });
    expect([...fake.applications.values()][0]?.scenes[0]?.models[0]?.assetModelId).toBe("new-model-1");
  });
});
