import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { isModelLoadSuperseded, waitForModelReady } from "./appModelLoading";

vi.mock("./api", () => ({ api: { getProject: vi.fn() } }));

const getProject = vi.mocked(api.getProject);
function project(status: string, id = "model-a") {
  return { id: "project-a", models: [{ id, status, message: "转换失败详情" }] } as Awaited<ReturnType<typeof api.getProject>>;
}

describe("model readiness polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout });
    getProject.mockReset();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("returns the authoritative ready project without scheduling another poll", async () => {
    const ready = project("ready");
    getProject.mockResolvedValue(ready);
    expect(await waitForModelReady("project-a", "model-a")).toBe(ready);
    expect(getProject).toHaveBeenCalledExactlyOnceWith("project-a");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("polls pending conversion at 250ms until ready", async () => {
    getProject.mockResolvedValueOnce(project("processing")).mockResolvedValue(project("ready"));
    const pending = waitForModelReady("project-a", "model-a");
    await vi.advanceTimersByTimeAsync(249);
    expect(getProject).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).models[0]?.status).toBe("ready");
    expect(getProject).toHaveBeenCalledTimes(2);
  });

  it.each(["failed", "waiting_converter"])("stops on %s and preserves the converter reason", async status => {
    getProject.mockResolvedValue(project(status));
    await expect(waitForModelReady("project-a", "model-a")).rejects.toThrow("转换失败详情");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a missing model instead of treating another model as ready", async () => {
    getProject.mockResolvedValue(project("ready", "other"));
    await expect(waitForModelReady("project-a", "model-a")).rejects.toThrow("导入的模型资源不存在");
  });

  it("propagates transport failure without leaving timers", async () => {
    const failure = new Error("network unavailable");
    getProject.mockRejectedValue(failure);
    await expect(waitForModelReady("project-a", "model-a")).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops pending conversion after its 60 second deadline", async () => {
    getProject.mockResolvedValue(project("processing"));
    const assertion = expect(waitForModelReady("project-a", "model-a")).rejects.toThrow("模型资源处理超时");
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(getProject).toHaveBeenCalledTimes(240);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps simultaneous model requests independent", async () => {
    getProject.mockResolvedValueOnce(project("processing", "model-a"))
      .mockResolvedValueOnce(project("ready", "model-b"))
      .mockResolvedValueOnce(project("ready", "model-a"));
    const first = waitForModelReady("project-a", "model-a");
    const second = waitForModelReady("project-a", "model-b");
    expect((await second).models[0]?.id).toBe("model-b");
    await vi.advanceTimersByTimeAsync(250);
    expect((await first).models[0]?.id).toBe("model-a");
  });

  it("recognizes supersession only for named errors", () => {
    const superseded = new Error("cancelled");
    superseded.name = "ModelLoadSupersededError";
    expect(isModelLoadSuperseded(superseded)).toBe(true);
    for (const value of [undefined, null, "ModelLoadSupersededError", new Error("other"), { name: superseded.name }]) {
      expect(isModelLoadSuperseded(value)).toBe(false);
    }
  });
});
