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
});

class MemoryWorkspaceStore implements DesktopLocalWorkspaceStore {
  private state = createInitialWorkspaceState("2026-08-31T00:00:00.000Z");
  private readonly assets = new Map<string, Blob>();

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
