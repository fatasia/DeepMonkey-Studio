import { describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { DesktopLocalApi } from "./desktopLocalApi.js";
import {
  createInitialWorkspaceState,
  type DesktopLocalWorkspaceState,
  type DesktopLocalWorkspaceStore,
} from "./desktopLocalWorkspaceStore.js";

describe("desktop local API", () => {
  it("creates, saves and reloads a scene without any server transport", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));
    const store = new MemoryWorkspaceStore();
    const firstSession = new DesktopLocalApi(store);
    const scene = fixtureScene();

    const saved = await firstSession.handle(`/api/projects/local-project/scenes/${scene.id}`, {
      method: "PUT",
      body: JSON.stringify(scene),
    });
    expect(saved.status).toBe(200);

    const restartedSession = new DesktopLocalApi(store);
    const browse = await restartedSession.handle(`/api/scenes/${scene.id}/browse`);
    expect(browse.status).toBe(200);
    expect(await browse.json()).toMatchObject({
      scene: { id: scene.id, name: "离线工作站" },
      project: { id: "local-project" },
    });
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("reports server-only capabilities instead of silently attempting the network", async () => {
    const api = new DesktopLocalApi(new MemoryWorkspaceStore());
    const response = await api.handle("/api/capabilities");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining("需要连接在线服务器") });
  });

  it("将上传的 ESM 依赖持久化，重启后仍可离线读取", async () => {
    const store = new MemoryWorkspaceStore();
    const body = new FormData();
    body.append("file", new File(["export const speed = 12;"], "motion.js", { type: "text/javascript" }));
    const installed = await new DesktopLocalApi(store).handle(
      "/api/projects/local-project/script-dependencies/upload?specifier=%40plant%2Fmotion",
      { method: "POST", body },
    );

    expect(installed.status).toBe(201);
    const metadata = await installed.json() as { id: string; specifier: string; integrity: string };
    expect(metadata).toMatchObject({ specifier: "@plant/motion", integrity: expect.stringMatching(/^sha256-/) });

    const content = await new DesktopLocalApi(store).handle(`/api/projects/local-project/script-dependencies/${metadata.id}/content`);
    expect(content.status).toBe(200);
    expect(await content.text()).toContain("export const speed = 12");
  });

  it("拒绝仍依赖外部模块的本地 JS，避免断网后运行失败", async () => {
    const body = new FormData();
    body.append("file", new File(["import value from 'remote'; export default value;"], "unsafe.js", { type: "text/javascript" }));
    const response = await new DesktopLocalApi(new MemoryWorkspaceStore()).handle(
      "/api/projects/local-project/script-dependencies/upload?specifier=unsafe",
      { method: "POST", body },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining("单文件 ESM") });
  });
});

class MemoryWorkspaceStore implements DesktopLocalWorkspaceStore {
  private state = createInitialWorkspaceState("2026-08-31T00:00:00.000Z");
  private readonly assets = new Map<string, Blob>();
  private readonly scriptDependencies = new Map<string, Blob>();

  async read(): Promise<DesktopLocalWorkspaceState> {
    return structuredClone(this.state);
  }

  async write(state: DesktopLocalWorkspaceState): Promise<void> {
    this.state = structuredClone(state);
  }

  async readModelAsset(modelId: string): Promise<Blob | undefined> {
    return this.assets.get(modelId);
  }

  async writeModelAsset(modelId: string, asset: Blob): Promise<void> {
    this.assets.set(modelId, asset);
  }

  async deleteModelAsset(modelId: string): Promise<void> {
    this.assets.delete(modelId);
  }

  async readScriptDependency(dependencyId: string): Promise<Blob | undefined> {
    return this.scriptDependencies.get(dependencyId);
  }

  async writeScriptDependency(dependencyId: string, asset: Blob): Promise<void> {
    this.scriptDependencies.set(dependencyId, asset);
  }

  async deleteScriptDependency(dependencyId: string): Promise<void> {
    this.scriptDependencies.delete(dependencyId);
  }
}

function fixtureScene(): SceneSnapshot {
  const now = "2026-08-31T00:00:00.000Z";
  return {
    schemaVersion: 1,
    id: "offline-scene",
    projectId: "local-project",
    name: "离线工作站",
    camera: { position: { x: 4, y: 3, z: 5 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    models: [],
    primitives: [],
    measurements: [],
    createdAt: now,
    updatedAt: now,
  };
}
