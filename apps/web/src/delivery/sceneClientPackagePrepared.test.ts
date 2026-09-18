import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import { exportSceneClientPackage, exportSceneClientDiagnosticPackage, prepareSceneClientPackage, type PreparedSceneClientPackage, type SceneClientPackageOptions } from "./sceneClientPackage";
import "./nativeSceneClientPayload";

const mocks = vi.hoisted(() => ({ project: vi.fn(), applications: vi.fn(), load: vi.fn(), download: vi.fn(), generate: vi.fn(), file: vi.fn() }));
vi.mock("../api", () => ({ api: { getProject: mocks.project, listApplications: mocks.applications } }));
vi.mock("../browserDownload", () => ({ downloadBlob: mocks.download }));
vi.mock("../viewer/viewerAssetTransport", () => ({ loadViewerAssetBuffer: mocks.load }));
vi.mock("jszip", () => ({ default: class { file = mocks.file; generateAsync = mocks.generate; } }));

function options(): SceneClientPackageOptions {
  return { projectId: "project", target: "three-webview", renderer: "webgl", toolbarVisible: true,
    scene: { schemaVersion: 1, id: "scene", projectId: "project", name: "Prepared", models: [], primitives: [], measurements: [],
      camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 }, target: { x: 0, y: 0, z: 0 } },
      createdAt: "2026-09-14", updatedAt: "2026-09-15" } as SceneSnapshot };
}
function modelReference(assetModelId: string): SceneSnapshot["models"][number] {
  return { modelId: `instance-${assetModelId}`, assetModelId, name: assetModelId, visible: true, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.project.mockResolvedValue({ id: "project", name: "Project", models: [] });
  mocks.applications.mockResolvedValue([]);
  mocks.generate.mockResolvedValue(new Blob(["zip"]));
});

describe("prepared scene delivery", () => {
  it("rejects colliding output paths before returning a prepared handle", async () => {
    mocks.project.mockResolvedValue({ id: "project", name: "Project", models: [
      { id: "asset", projectId: "project", status: "ready", name: "Box.glb", manifest: { geometryUrl: "/a.glb" } },
      { id: "ASSET", projectId: "project", status: "ready", name: "box.glb", manifest: { geometryUrl: "/b.glb" } },
    ] });
    mocks.load.mockResolvedValue(new ArrayBuffer(1));
    const input = options(); input.scene.models = [modelReference("asset"), modelReference("ASSET")];
    await expect(prepareSceneClientPackage(input)).rejects.toThrow(/冲突|重复/);
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });
  it.each(["preparation", "delivery"])("retains %s cancellation through pending ZIP generation", async phase => {
    const input = options(), preparation = new AbortController(), delivery = new AbortController();
    const prepared = await prepareSceneClientPackage({ ...input, signal: preparation.signal });
    let finish!: (blob: Blob) => void;
    mocks.generate.mockReturnValueOnce(new Promise<Blob>(resolve => { finish = resolve; }));
    const running = exportSceneClientPackage({ ...input, prepared, signal: delivery.signal });
    const cancelled = expect(running).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledOnce());
    (phase === "preparation" ? preparation : delivery).abort(); finish(new Blob(["zip"])); await cancelled;
    expect(mocks.download).not.toHaveBeenCalled();
    await expect(exportSceneClientPackage({ ...input, prepared })).rejects.toThrow("已使用");
  });

  it("rejects diagnostic consumption and preparation chaining without consuming the formal handle", async () => {
    const input = options(), prepared = await prepareSceneClientPackage(input);
    await expect(exportSceneClientDiagnosticPackage({ ...input, target: "deep-native", prepared })).rejects.toThrow("不能消费正式预检结果");
    await expect(prepareSceneClientPackage({ ...input, prepared })).rejects.toThrow("已有预检结果");
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
    await exportSceneClientPackage({ ...input, prepared });
    expect(mocks.project).toHaveBeenCalledOnce(); expect(mocks.download).toHaveBeenCalledOnce();
  });

  it("retires the handle after identity rejection rather than allowing changed requests to reuse it", async () => {
    const input = options(), prepared = await prepareSceneClientPackage(input);
    await expect(exportSceneClientPackage({ ...input, toolbarVisible: false, prepared })).rejects.toThrow("已变化");
    await expect(exportSceneClientPackage({ ...input, prepared })).rejects.toThrow("已使用");
    expect(mocks.project).toHaveBeenCalledOnce(); expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("prepares without ZIP or download, then consumes once with actual publication timestamps", async () => {
    const input = options(), prepared = await prepareSceneClientPackage(input);
    expect(mocks.file).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
    input.scene.updatedAt = "2026-09-16"; input.scene.publishedAt = "2026-09-16";
    const delivery = { ...input, prepared };
    expect(await exportSceneClientPackage(delivery)).toMatchObject({ fileName: "Prepared.three-webview.bimscene.zip" });
    const files = new Map(mocks.file.mock.calls.map(([name, content]) => [name, content]));
    expect(JSON.parse(files.get("scene.json") as string).publishedAt).toBe("2026-09-16");
    expect(JSON.parse(files.get("manifest.json") as string).publishedAt).toBe("2026-09-16");
    expect(mocks.project).toHaveBeenCalledTimes(1); expect(mocks.applications).toHaveBeenCalledTimes(1);
    await expect(exportSceneClientPackage(delivery)).rejects.toThrow("已使用");
    expect(mocks.download).toHaveBeenCalledTimes(1);
  });

  it.each(["name", "camera", "project", "scene", "target", "renderer", "toolbar", "metadata"])("rejects changed %s without delivery or a replacement preparation", async field => {
    const input = options(), prepared = await prepareSceneClientPackage(input);
    if (field === "name") input.scene.name = "Changed";
    else if (field === "camera") input.scene.camera.position.x++;
    else if (field === "project") input.projectId = "different";
    else if (field === "scene") input.scene.id = "different";
    else if (field === "target") input.target = "deep-native";
    else if (field === "renderer") input.renderer = "webgpu-preferred";
    else if (field === "toolbar") input.toolbarVisible = false;
    else Object.assign(input.scene, { metadata: { updatedAt: "nested" } });
    await expect(exportSceneClientPackage({ ...input, prepared })).rejects.toThrow("已变化");
    expect(mocks.project).toHaveBeenCalledTimes(1); expect(mocks.download).not.toHaveBeenCalled();
  });

  it("does not accept fabricated or cloned handles", async () => {
    const input = options(), prepared = await prepareSceneClientPackage(input);
    for (const invalid of [{} as PreparedSceneClientPackage, structuredClone(prepared)]) {
      await expect(exportSceneClientPackage({ ...input, prepared: invalid })).rejects.toThrow("不存在");
    }
    await exportSceneClientPackage({ ...input, prepared });
    expect(mocks.project).toHaveBeenCalledTimes(1); expect(mocks.download).toHaveBeenCalledTimes(1);
  });

  it("prevents simultaneous consumption from generating two downloads", async () => {
    const input = options(), prepared = await prepareSceneClientPackage(input);
    const first = exportSceneClientPackage({ ...input, prepared });
    await expect(exportSceneClientPackage({ ...input, prepared })).rejects.toThrow("已使用");
    await first; expect(mocks.generate).toHaveBeenCalledTimes(1); expect(mocks.download).toHaveBeenCalledTimes(1);
  });

  it.each(["preparation", "delivery"])("honors %s cancellation after preparation without creating ZIP", async phase => {
    const input = options(), preparation = new AbortController(), delivery = new AbortController();
    const prepared = await prepareSceneClientPackage({ ...input, signal: preparation.signal });
    (phase === "preparation" ? preparation : delivery).abort();
    await expect(exportSceneClientPackage({ ...input, prepared, signal: delivery.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });

  it("holds copied resource bytes and metadata through publication without reading them again", async () => {
    const project = { id: "project", name: "Project", models: [{ id: "asset", projectId: "project", status: "ready", name: "Asset", manifest: { geometryUrl: "/asset.glb" } }] };
    const input = options(); input.scene.models = [modelReference("asset")];
    const applications = [migrateSceneSnapshotV1(input.scene)];
    applications[0]!.metadata.name = "Saved dashboard";
    const bytes = new Uint8Array([1, 2, 3]);
    mocks.project.mockResolvedValue(project); mocks.applications.mockResolvedValue(applications); mocks.load.mockResolvedValue(bytes.buffer);
    const prepared = await prepareSceneClientPackage(input);
    bytes[0] = 9; project.name = "Changed"; applications[0]!.metadata.name = "Changed";
    await exportSceneClientPackage({ ...input, prepared });
    expect(mocks.load).toHaveBeenCalledTimes(1); expect(mocks.project).toHaveBeenCalledTimes(1);
    const files = new Map(mocks.file.mock.calls.map(([name, content]) => [name, content]));
    expect(new Uint8Array(files.get("assets/model-asset-Asset") as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(JSON.parse(files.get("project.json") as string).name).toBe("Project");
    expect(JSON.parse(files.get("applications.json") as string)[0].metadata.name).toBe("Saved dashboard");
  });

  it("rejects real Native preflight without a handle, ZIP or download when evidence is missing", async () => {
    await expect(prepareSceneClientPackage({ ...options(), target: "deep-native" })).rejects.toMatchObject({ code: "publication-compatibility-blocked" });
    expect(mocks.file).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });
});
