import { describe, expect, it, vi } from "vitest";
import { createModelSceneApi } from "./modelSceneApi";
import type { SceneSnapshot } from "@bim-studio/contracts";

describe("model scene directory cancellation", () => {
  it("passes the caller cancellation signal unchanged to the unified HTTP boundary", async () => {
    const controller = new AbortController();
    const request = vi.fn().mockResolvedValue([]);
    const api = createModelSceneApi(request);
    await expect(api.listScenes("project-1", { signal: controller.signal })).resolves.toEqual([]);
    expect(request).toHaveBeenCalledWith("/api/projects/project-1/scenes", { signal: controller.signal });
  });

  it("keeps the original no-options listing call valid", async () => {
    const request = vi.fn().mockResolvedValue([]);
    await expect(createModelSceneApi(request).listScenes("project-1")).resolves.toEqual([]);
    expect(request).toHaveBeenCalledWith("/api/projects/project-1/scenes", {});
  });

  it("sends the exact audited snapshot as the publication precondition", async () => {
    const request = vi.fn().mockResolvedValue({ version: 1 });
    const snapshot: SceneSnapshot = { schemaVersion: 1, id: "scene", projectId: "project", name: "草稿",
      camera: { mode: "orbit", position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } },
      models: [], primitives: [], measurements: [], createdAt: "created", updatedAt: "saved" };
    await createModelSceneApi(request).publishScene("project", "scene", snapshot);
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("/api/projects/project/scenes/scene/publish");
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(init.body)).toEqual({ expectedSnapshot: snapshot });
  });
});
