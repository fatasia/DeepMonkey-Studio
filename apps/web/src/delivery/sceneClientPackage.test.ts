import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { parseDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { exportSceneClientPackage as exportClientPackage, exportSceneClientDiagnosticPackage, type SceneClientPackageOptions } from "./sceneClientPackage";
// 在收集阶段转换真实编译器；用例计时覆盖导出行为，不包含 Vitest 模块转换排队。
import "./nativeSceneClientPayload";

const mocks = vi.hoisted(() => ({ project: vi.fn(), applications: vi.fn(), load: vi.fn(), download: vi.fn(), generate: vi.fn(), file: vi.fn() }));
vi.mock("../api", () => ({ api: { getProject: mocks.project, listApplications: mocks.applications } }));
vi.mock("../browserDownload", () => ({ downloadBlob: mocks.download }));
vi.mock("../viewer/viewerAssetTransport", () => ({ loadViewerAssetBuffer: mocks.load }));
vi.mock("jszip", () => ({ default: class { file = mocks.file; generateAsync = mocks.generate; } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const options = (signal?: AbortSignal) => ({ projectId: "project", scene: { schemaVersion: 1, id: "scene", projectId: "project", name: "Sample", models: [], primitives: [], measurements: [],
  camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 }, target: { x: 0, y: 0, z: 0 } }, createdAt: "", updatedAt: "" } as SceneSnapshot,
  target: "deep-native" as const, renderer: "webgpu-preferred" as const, toolbarVisible: true, ...(signal ? { signal } : {}) });
const activeExports = new Set<Promise<unknown>>();
let testCancellation = new AbortController();
function exportSceneClientPackage(input: SceneClientPackageOptions, diagnostic = false) {
  const signal = input.signal ? AbortSignal.any([input.signal, testCancellation.signal]) : testCancellation.signal;
  const pending = diagnostic ? exportSceneClientDiagnosticPackage({ ...input, signal, target: "deep-native" }) : exportClientPackage({ ...input, signal });
  activeExports.add(pending);
  void pending.then(() => activeExports.delete(pending), () => activeExports.delete(pending));
  return pending;
}
beforeEach(() => {
  testCancellation = new AbortController();
  vi.resetAllMocks();
  mocks.project.mockResolvedValue({ id: "project", name: "Project", models: [] });
  mocks.applications.mockResolvedValue([]);
  mocks.generate.mockResolvedValue(new Blob(["zip"]));
});
afterEach(async () => {
  testCancellation.abort();
  await Promise.allSettled(activeExports);
});

describe("client package cancellation", () => {
  it("rejects formal Native delivery before ZIP creation when real compilation lacks window evidence", async () => {
    await expect(exportSceneClientPackage(options())).rejects.toMatchObject({ code: "publication-compatibility-blocked" });
    expect(mocks.file).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("labels diagnostic downloads separately and does not return a formal delivery result", async () => {
    const result = await exportSceneClientPackage(options(), true);
    expect(result).toMatchObject({ kind: "scene-client-diagnostic", diagnosticFileName: "Sample.deep-native.diagnostic.bimscene.zip" });
    expect(result).not.toHaveProperty("fileName");
    const files = new Map(mocks.file.mock.calls.map(([name, content]) => [name, content]));
    expect(JSON.parse(files.get("manifest.json") as string).purpose).toBe("diagnostic");
    expect(files.get("README.txt")).toContain("不是已通过发布检查");
  });
  it("puts a real validated Native package and blocked capability evidence in the ZIP", async () => {
    await exportSceneClientPackage(options(), true);
    const files = new Map(mocks.file.mock.calls.map(([name, content]) => [name, content]));
    const packageJson = files.get("native/runtime-package.json") as string;
    expect(parseDeepRuntimePackage(packageJson)).toMatchObject({ valid: true, value: { schemaVersion: 3 } });
    const manifest = JSON.parse(files.get("manifest.json") as string);
    expect(manifest.nativeRuntime).toMatchObject({ path: "native/runtime-package.json", schemaVersion: 3, status: "blocked" });
    expect(manifest.nativeRuntime).not.toHaveProperty("conversionRequired");
    expect(manifest.capabilities).not.toHaveProperty("twoD");
    const evidence = JSON.parse(files.get("native/compilation-evidence.json") as string);
    expect(evidence.targetArtifactHash).toBe(createHash("sha256").update(packageJson).digest("hex"));
    const report = JSON.parse(files.get("native/compatibility-report.json") as string);
    expect(report.status).toBe("blocked");
    expect(report.items.some((item: { capability: string }) => item.capability === "deep.scene.camera.v1")).toBe(true);
    for (const entry of manifest.files) expect(entry.sha256).toBe(createHash("sha256").update(files.get(entry.path) as string).digest("hex"));
  });
  it("compiles downloaded GLB bytes once and isolates the requested scene during metadata loading", async () => {
    const input = options();
    input.scene.models = [{ modelId: "instance", assetModelId: "asset", name: "Model", visible: true, opacity: 1,
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }];
    mocks.project.mockImplementation(async () => {
      input.scene.name = "Changed"; input.scene.models = [];
      return { id: "project", models: [{ id: "asset", projectId: "project", status: "ready", name: "Box.glb", manifest: { geometryUrl: "/box.glb?token=private-token" } }] };
    });
    const bytes = readFileSync(new URL("../../../../packages/deep-engine/lab/assets/Box.glb", import.meta.url));
    mocks.load.mockResolvedValue(Uint8Array.from(bytes).buffer);
    await exportSceneClientPackage(input, true);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    const files = new Map(mocks.file.mock.calls.map(([name, content]) => [name, content]));
    const parsed = parseDeepRuntimePackage(files.get("native/runtime-package.json") as string);
    expect(parsed).toMatchObject({ valid: true });
    if (!parsed.valid) throw new Error("invalid package");
    expect(parsed.value.payloads[parsed.value.entrypoints.renderPacket]).toMatchObject({ instances: [expect.any(Object)] });
    expect(JSON.parse(files.get("scene.json") as string).name).toBe("Sample");
    expect(JSON.parse(files.get("project.json") as string).models[0]).toMatchObject({ name: "Box.glb", manifest: { geometryUrl: "assets/model-asset-Box.glb" } });
    expect([...files.values()].filter(value => typeof value === "string").join("\n")).not.toContain("private-token");
  });
  it("keeps Three WebView bundles free of Native compile requirements", async () => {
    const input = options(); input.scene.camera.position.x = NaN;
    await exportSceneClientPackage({ ...input, target: "three-webview" });
    expect(mocks.file.mock.calls.some(([path]) => path.startsWith("native/"))).toBe(false);
  });
  it("freezes the delivery brand and indexes its icon in the client archive", async () => {
    const iconDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/2Oa9WQAAAABJRU5ErkJggg==";
    await exportSceneClientPackage({ ...options(), target: "three-webview",
      branding: { applicationName: "Factory Viewer", iconDataUrl } });
    const files = new Map(mocks.file.mock.calls.map(([name, content]) => [name, content]));
    const manifest = JSON.parse(files.get("manifest.json") as string);
    expect(manifest.branding).toEqual({ applicationName: "Factory Viewer", iconPath: "branding/icon.png" });
    expect(files.get("branding/icon.png")).toBeInstanceOf(ArrayBuffer);
    expect(manifest.files).toContainEqual(expect.objectContaining({ path: "branding/icon.png", bytes: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  });
  it("uses one deterministic ZIP timestamp without transient folder entries", async () => {
    const input = options();
    input.scene.createdAt = "2026-09-20T10:50:01.999Z";
    await exportSceneClientPackage({ ...input, target: "three-webview" });
    const dates = mocks.file.mock.calls.map(([, , config]) => (config as { date: Date }).date.toISOString());
    expect(new Set(dates)).toEqual(new Set(["2026-09-20T10:50:00.000Z"]));
    expect(mocks.file.mock.calls.every(([, , config]) => (config as { createFolders: boolean }).createFolders === false)).toBe(true);
  });
  it("round-trips the downloaded archive through real ZIP encoding and verifies every indexed byte", async () => {
    const { default: JSZip } = await vi.importActual<{ default: typeof import("jszip") }>("jszip");
    const archive = new JSZip();
    mocks.file.mockImplementation((name, content) => archive.file(name, content));
    mocks.generate.mockImplementation(options => archive.generateAsync(options));
    const bytes = readFileSync(new URL("../../../../packages/deep-engine/lab/assets/Box.glb", import.meta.url));
    mocks.project.mockResolvedValue({ id: "project", name: "Project", models: [{ id: "asset", projectId: "project", status: "ready", name: "Box.glb", manifest: { geometryUrl: "/box.glb" } }] });
    mocks.load.mockResolvedValue(Uint8Array.from(bytes).buffer);
    const input = options();
    input.scene.models = [{ modelId: "instance", assetModelId: "asset", name: "Model", visible: true, opacity: 1,
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }];
    await exportSceneClientPackage(input, true);
    const blob = mocks.download.mock.calls[0]![0] as Blob;
    const restored = await JSZip.loadAsync(await blob.arrayBuffer(), { checkCRC32: true });
    const manifest = JSON.parse(await restored.file("manifest.json")!.async("string"));
    for (const entry of manifest.files) {
      const content = await restored.file(entry.path)!.async("uint8array");
      expect(content.byteLength).toBe(entry.bytes);
      expect(createHash("sha256").update(content).digest("hex")).toBe(entry.sha256);
    }
    expect(await restored.file("assets/model-asset-Box.glb")!.async("uint8array")).toEqual(Uint8Array.from(bytes));
    const packageJson = await restored.file(manifest.nativeRuntime.path)!.async("string");
    const parsed = parseDeepRuntimePackage(packageJson);
    expect(parsed).toMatchObject({ valid: true });
    if (!parsed.valid) throw new Error("invalid archived runtime package");
    expect(parsed.value.packageHash).toEqual(manifest.nativeRuntime.packageHash);
    const evidence = JSON.parse(await restored.file("native/compilation-evidence.json")!.async("string"));
    expect(evidence.targetArtifactHash).toBe(createHash("sha256").update(packageJson).digest("hex"));
    expect(JSON.parse(await restored.file(manifest.nativeRuntime.reportPath)!.async("string")).status).toBe("blocked");
  });
  it("downloads once and returns the result after successful generation", async () => {
    const progress = vi.fn();
    const result = await exportSceneClientPackage({ ...options(), target: "three-webview", progress });
    if (!("fileName" in result)) throw new Error("expected formal delivery");
    expect(result.fileName).toBe("Sample.three-webview.bimscene.zip");
    expect(mocks.download).toHaveBeenCalledExactlyOnceWith(expect.any(Blob), result.fileName);
    expect(progress).toHaveBeenLastCalledWith(`客户端包已下载：${result.fileName}`);
  });
  it("rejects a pre-aborted request before reading metadata", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(exportSceneClientPackage(options(controller.signal))).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.project).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });
  it("does not download a ZIP that completes after cancellation", async () => {
    const controller = new AbortController(), generated = deferred<Blob>(), entered = deferred<void>(), progress = vi.fn();
    mocks.generate.mockImplementation(() => { entered.resolve(); return generated.promise; });
    const pending = exportSceneClientPackage({ ...options(controller.signal), target: "three-webview", progress });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await entered.promise; controller.abort(); generated.resolve(new Blob(["late zip"]));
    await rejected;
    expect(mocks.download).not.toHaveBeenCalled();
    expect(progress.mock.calls.some(([message]) => message.startsWith("客户端包已下载"))).toBe(false);
    await exportSceneClientPackage(options(), true);
    expect(mocks.download).toHaveBeenCalledTimes(1);
  });
  it("honors cancellation from the generation progress callback before compression", async () => {
    const controller = new AbortController();
    await expect(exportSceneClientPackage({ ...options(controller.signal), target: "three-webview", progress(message) {
      if (message === "正在生成客户端包") controller.abort();
    } })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });
  it("rejects a late asset result even when the transport ignores abort", async () => {
    const controller = new AbortController(), loaded = deferred<ArrayBuffer>(), entered = deferred<void>();
    mocks.project.mockResolvedValue({ id: "project", models: [{ id: "asset", projectId: "project", status: "ready", name: "Asset", manifest: { geometryUrl: "/asset.glb" } }] });
    mocks.load.mockImplementation(() => { entered.resolve(); return loaded.promise; });
    const input = options(controller.signal);
    input.scene.models = [{ modelId: "instance", assetModelId: "asset", name: "Asset", visible: true, opacity: 1,
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }];
    const pending = exportSceneClientPackage(input);
    const outcome = pending.then(() => undefined, (error: unknown) => error);
    await Promise.race([entered.promise, outcome.then(error => { throw error ?? new Error("Export finished before asset read"); })]);
    controller.abort(); loaded.resolve(new ArrayBuffer(4));
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.file).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });
  it("does not report download success when compression fails", async () => {
    mocks.generate.mockRejectedValue(new Error("compression failed"));
    await expect(exportSceneClientPackage({ ...options(), target: "three-webview" })).rejects.toThrow("compression failed");
    expect(mocks.download).not.toHaveBeenCalled();
  });
});
