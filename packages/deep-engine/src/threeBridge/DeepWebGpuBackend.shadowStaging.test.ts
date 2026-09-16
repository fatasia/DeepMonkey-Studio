import { describe, expect, it, vi } from "vitest";
import { bridge } from "./testFixture.js";
import { DeepWebGpuBackend, type DeepWebGpuRenderRuntime } from "./DeepWebGpuBackend.js";

function fixture() {
  const stage = vi.fn(async (_size: number, _signal?: AbortSignal): Promise<"staged" | "superseded"> => "staged");
  const runtime = { id: "deep-webgpu", stageShadowMapSize: stage, dispose: vi.fn() } as unknown as DeepWebGpuRenderRuntime;
  return { stage, runtime, backend: new DeepWebGpuBackend(runtime, bridge()) };
}

describe("DeepWebGpuBackend shadow map preparation", () => {
  it.each(["staged", "superseded"] as const)("forwards primitive size, cancellation and %s outcome", async result => {
    const f = fixture(), controller = new AbortController();
    let resolve!: (value: "staged" | "superseded") => void;
    f.stage.mockImplementation(() => new Promise(done => { resolve = done; }));
    let requestedSize = 2048;
    const pending = f.backend.stageShadowMapSize(requestedSize, controller.signal);
    requestedSize = 4096;
    controller.abort();
    expect(f.stage).toHaveBeenCalledWith(2048, controller.signal);
    expect(f.stage.mock.calls[0]![1]!.aborted).toBe(true);
    resolve(result);
    await expect(pending).resolves.toBe(result);
    expect(requestedSize).toBe(4096);
  });

  it.each([64, 1024, 16384])("accepts valid map size %s without coercion", async size => {
    const f = fixture();
    await expect(f.backend.stageShadowMapSize(size)).resolves.toBe("staged");
    expect(f.stage).toHaveBeenCalledWith(size, undefined);
  });

  it.each([0, 63, 16385, 1.5, NaN, Infinity, -Infinity, null, undefined, "1024", {}, new Number(1024)])
  ("rejects invalid map size %s before runtime preparation", async size => {
    const f = fixture();
    await expect(f.backend.stageShadowMapSize(size as number)).rejects.toThrow("Invalid exact shadow map size");
    expect(f.stage).not.toHaveBeenCalled();
  });

  it("rejects unsupported runtimes and disposed backends", async () => {
    const f = fixture();
    delete f.runtime.stageShadowMapSize;
    await expect(f.backend.stageShadowMapSize(1024)).rejects.toThrow("cannot stage shadow map");
    f.runtime.stageShadowMapSize = f.stage;
    f.backend.dispose();
    await expect(f.backend.stageShadowMapSize(1024)).rejects.toThrow("disposed");
    expect(f.stage).not.toHaveBeenCalled();
  });

  it("preserves runtime allocation failures", async () => {
    const f = fixture(), failure = new Error("Shadow allocation budget exceeded");
    f.stage.mockRejectedValue(failure);
    await expect(f.backend.stageShadowMapSize(8192)).rejects.toBe(failure);
  });
});
