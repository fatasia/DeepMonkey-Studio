import { afterEach, describe, expect, it, vi } from "vitest";
import { loadViewerAssetBuffer, loadViewerAssetJson, loadViewerAssetText } from "./viewerAssetTransport.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("viewer asset transport", () => {
  it("does not start a cancelled request and propagates cancellation to an active asset read", async () => {
    const cancelled = new AbortController(); cancelled.abort();
    const request = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", request);
    await expect(loadViewerAssetBuffer("/model.glb", "模型", { signal: cancelled.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
    const active = new AbortController();
    const pending = loadViewerAssetBuffer("/model.glb", "模型", { signal: active.signal });
    active.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(request.mock.calls[0]![1].signal.aborted).toBe(true);
  });
  it("applies a bounded timeout to every asset response type", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
      .mockResolvedValueOnce(new Response("hierarchy"))
      .mockResolvedValueOnce(new Response('{"name":"pump"}', { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", request);

    await expect(loadViewerAssetBuffer("/pump.glb", "泵模型", { timeoutMs: 2_000 }))
      .resolves.toHaveProperty("byteLength", 3);
    await expect(loadViewerAssetText("/pump.tree.json", "层级")).resolves.toBe("hierarchy");
    await expect(loadViewerAssetJson<{ name: string }>("/pump.json", "属性")).resolves.toEqual({ name: "pump" });

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.every(([, init]) => init.credentials === "same-origin" && init.signal instanceof AbortSignal)).toBe(true);
  });

  it("turns a network timeout into an actionable Chinese error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    }));

    await expect(loadViewerAssetBuffer("/slow.glb", "大型模型", { timeoutMs: 1 }))
      .rejects.toThrow("大型模型 下载超时，请检查网络后重试");
  });

  it("keeps HTTP failures distinct from timeouts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));
    await expect(loadViewerAssetText("/missing.json", "属性文件")).rejects.toThrow("属性文件 下载失败：404");
  });
});
