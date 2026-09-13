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
    dataConnections: [{ id: "connection-old", projectId: scene.projectId, name: "生产连接", type: "postgresql", enabled: true,
      config: { password: "private-secret", passwordEnv: "DB_SECRET", url: "postgres://private" }, createdAt: scene.createdAt, updatedAt: scene.updatedAt }],
    datasets: [{ id: "dataset-old", projectId: scene.projectId, connectionId: "connection-old", name: "趋势", refreshSeconds: 10, fields: [], createdAt: scene.createdAt, updatedAt: scene.updatedAt }],
  } as unknown as ProjectRecord;
  const application = migrateSceneSnapshotV1(scene);
  const document = createProjectTransfer(project, [scene], [application]);
  return { project, scene, application, document, archive: { document, files: new Map([[document.files[0]!.id, new File(["model"], "设备.glb")]]) } satisfies ProjectTransferArchive };
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
    uploadImageAsset: vi.fn(), uploadVideoAsset: vi.fn(), uploadEnvironmentMap: vi.fn(), uploadMaterialAsset: vi.fn(), uploadScriptDependency: vi.fn(), renameAsset: vi.fn(),
  };
  return { result, projects, applications, savedScenes, api: result as unknown as ConstructorParameters<typeof ProjectTransferImport>[1] };
}

describe("project transfer", () => {
  it("exports an allowlist and removes credentials while keeping page content and stable object identities", () => {
    const { document, application } = sample();
    expect(document.applications[0]?.pages).toEqual(application.pages);
    expect(JSON.stringify(document)).not.toMatch(/private-secret|DB_SECRET|postgres:\/\/private/);
    expect(document.runtime.connections[0]).toMatchObject({ enabled: false, config: {} });
    expect(document.files[0]?.name).toBe("设备.glb");
    expect(document.models).toHaveLength(1);
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
    const saved = [...fake.applications.values()][0]!;
    expect(saved.metadata.projectId).toBe(imported.id);
    expect(saved.scenes[0]?.models[0]?.modelId).toBe("instance-A");
    expect(fake.result.createDataset.mock.calls[0]?.[0]).toBe(imported.id);
    expect(fake.result.getProject.mock.calls.every(([id]) => id !== project.id)).toBe(true);
    // A completed package can create another independent copy; only unfinished imports resume.
    await new ProjectTransferImport(archive, fake.api).run("交付副本二", new AbortController().signal, vi.fn());
    expect(fake.result.createProject).toHaveBeenCalledTimes(2);
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
