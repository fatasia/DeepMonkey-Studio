import { describe, expect, it, vi } from "vitest";
import { createModelSceneApi } from "./modelSceneApi";

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
});
