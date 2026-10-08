import { describe, expect, it, vi } from "vitest";
import { createPbrPipelineSet } from "./pbrPipelineSet.js";
import { createPipelinesBuild, type PipelinesBuild } from "./pipelines.js";
import { resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";
import type { DeviceSession } from "./deviceSession.js";

vi.mock("./pipelines.js", () => ({ createPipelinesBuild: vi.fn() }));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("known pose bootstrap parallelism", () => {
  it("starts both shader builds before either resolves, waits for both critical sets and keeps background gated", async () => {
    const shader = gate(), staticCritical = gate(), poseCritical = gate();
    const background = new Promise<void>(() => {}), releaseStatic = vi.fn(), releasePose = vi.fn();
    vi.mocked(createPipelinesBuild).mockImplementationOnce(async () => {
      await shader.promise;
      return { pipelines: {}, criticalReady: staticCritical.promise, ready: background,
        releaseDeferredQueues: releaseStatic } as unknown as PipelinesBuild;
    }).mockImplementationOnce(async () => ({ pipelines: {}, criticalReady: poseCritical.promise,
      ready: background, releaseDeferredQueues: releasePose } as unknown as PipelinesBuild));
    const features = resolvePbrRendererFeatures({ textureArrays: false });
    const creating = createPbrPipelineSet({ device: {}, format: "bgra8unorm" } as DeviceSession,
      {} as GPUBindGroupLayout, { deformation: true, pipelines: { firstFrameMainKeys: [],
        deformationFirstFrameMainKeys: ["material/depth/ccw"], deferDeformation: false } }, features);
    expect(createPipelinesBuild).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createPipelinesBuild).mock.calls[0]![6]).toMatchObject({ firstFrameMainKeys: [] });
    expect(vi.mocked(createPipelinesBuild).mock.calls[1]![6]).toMatchObject({ deformation: true,
      firstFrameMainKeys: ["material/depth/ccw"] });
    shader.resolve();
    const set = await creating;
    let criticalSettled = false;
    void set.criticalReady.then(() => { criticalSettled = true; });
    staticCritical.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(criticalSettled).toBe(false);
    poseCritical.resolve(); await set.criticalReady; await set.deformation;
    expect(releaseStatic).not.toHaveBeenCalled(); expect(releasePose).not.toHaveBeenCalled();
    set.release();
    expect(releaseStatic).toHaveBeenCalledOnce(); expect(releasePose).toHaveBeenCalledOnce();
  });
});
