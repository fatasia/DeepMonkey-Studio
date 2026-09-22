import { expect, it, vi } from "vitest";
import { exportSceneStandaloneExecutable } from "./sceneStandaloneExecutable";
import type { SceneClientPackageOptions } from "./sceneClientPackage";
const mocks = vi.hoisted(() => ({ download: vi.fn(), save: vi.fn() }));
vi.mock("../api", () => ({ api: { downloadSceneExecutable: mocks.download } }));
vi.mock("../browserDownload", () => ({ downloadBlob: mocks.save }));
function input(): SceneClientPackageOptions {
  const scene: SceneClientPackageOptions["scene"] = { schemaVersion: 1, projectId: "p", id: "s", name: "Scene", models: [], primitives: [], measurements: [],
    camera: { mode: "orbit", position: { x: 0, y: 1, z: 2 }, target: { x: 0, y: 0, z: 0 } }, createdAt: "2026-09-18", updatedAt: "2026-09-18" };
  return { projectId: "p", scene, publication: { projectId: "p", sceneId: "s", version: 2, name: "Scene", publishedAt: "2026-09-18", snapshot: scene },
    target: "deep-native", renderer: "webgl", toolbarVisible: true };
}
it("downloads only the published version and preserves branding across pending transport", async () => {
  let finish!: (blob: Blob) => void; mocks.download.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const options = { ...input(), branding: { applicationName: "客户" } }, pending = exportSceneStandaloneExecutable(options);
  options.branding.applicationName = "mutated"; const blob = new Blob(["EXE"]); finish(blob);
  expect((await pending).fileName).toBe("客户.exe"); expect(mocks.save).toHaveBeenLastCalledWith(blob, "客户.exe");
  expect(mocks.download.mock.lastCall?.[4]).toEqual({ applicationName: "客户" });
});
it("rejects wrong target and missing publication without downloading", async () => {
  mocks.download.mockClear();
  await expect(exportSceneStandaloneExecutable({ ...input(), target: "three-webview" })).rejects.toThrow();
  const options = input(); delete options.publication;
  await expect(exportSceneStandaloneExecutable(options)).rejects.toThrow(); expect(mocks.download).not.toHaveBeenCalled();
});
it("never saves a late result after cancellation", async () => {
  mocks.save.mockClear(); const controller = new AbortController();
  mocks.download.mockImplementation(async () => { controller.abort(); return new Blob(["EXE"]); });
  await expect(exportSceneStandaloneExecutable({ ...input(), signal: controller.signal })).rejects.toThrow();
  expect(mocks.save).not.toHaveBeenCalled();
});
