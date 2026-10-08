import { describe, expect, it, vi } from "vitest";
import { encodeRtReflectionsFrame, releaseRtReflectionFrameContribution } from "./pbrRtReflectionsFrame.js";
import type { PbrRendererFrameHost } from "./pbrRendererFrameHost.js";
const state = vi.hoisted(() => ({ ready: true, failure: undefined as Error | undefined, order: [] as string[] }));

vi.mock("../rayTracing/rayTraceClosestFramePass.js", () => ({
  RayTraceClosestFramePass: class {
    constructor(_device: unknown, readonly packed: unknown) {}
    get ready() { return state.ready; }
    get validationFailure() { return state.failure; }
    encodeValidated = vi.fn(() => { state.order.push("closest"); });
  },
}));
vi.mock("../rayTracing/rtSpecularFramePasses.js", () => ({
  RtSpecularIndirectionPass: class { encode = vi.fn(() => { state.order.push("indirection"); }); },
}));

describe("RT reflection frame texture admission", () => {
  it("allocates legal texture flags, sampled second records, and releases all five resources", () => {
    state.order = []; state.ready = true; state.failure = undefined;
    vi.stubGlobal("GPUTextureUsage", { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 });
    // Real buffer flags differ; the old STORAGE=128 allocation must be rejected.
    vi.stubGlobal("GPUBufferUsage", { COPY_SRC: 4, COPY_DST: 8, STORAGE: 128 });
    const admitted: Array<{ resourceId: string; usage: number }> = [];
    const pool = { acquire: vi.fn((request: { resourceId: string; usage: number }) => {
      if (request.usage & ~15) throw new Error("invalid texture usage");
      if (!(request.usage & 8)) throw new Error("missing storage binding");
      admitted.push(request); return { view: {}, resourceId: request.resourceId };
    }), release: vi.fn() };
    const host = { session: { device: {} }, rtShadows: { packedScene: {} }, transientTextures: pool,
      targets: { depthTexture: { createView: () => ({}) }, linearDepth: {}, normal: {} },
      environment: { current: { brdf: {} } }, environmentAmbient: [0.2, 0.2, 0.2] } as unknown as PbrRendererFrameHost;
    const frame = encodeRtReflectionsFrame(host, {} as GPUDevice, {} as GPUCommandEncoder,
      { width: 64, height: 64 }, { eye: [0, 0, 5], extent: 10, environmentIntensity: 1 } as never,
      { depthViewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        projection: { verticalFovRadians: 1 } } as never,
      { screenSpaceReflection: true } as never,
      { primary: { surfaceToLightWorld: [0, 1, 0], color: [1, 1, 1], intensity: 1 } } as never);
    expect(frame.metrics).toMatchObject({ dispatched: true, indirectDispatched: true });
    state.order.push("finish");
    expect(state.order).toEqual(["closest", "indirection", "finish"]);
    expect(admitted).toHaveLength(5);
    for (const id of ["rt-reflection-closest-2", "rt-reflection-bounce-shading-2"]) {
      expect(admitted.find(request => request.resourceId === id)!.usage & 4).toBe(4);
    }
    releaseRtReflectionFrameContribution(host, frame);
    expect(pool.release).toHaveBeenCalledTimes(5);
    state.ready = false;
    const waiting = encodeRtReflectionsFrame(host, {} as GPUDevice, {} as GPUCommandEncoder,
      { width: 64, height: 64 }, {} as never, {} as never, {} as never, {} as never);
    expect(waiting.metrics).toEqual({ dispatched: false, reason: "pipeline-validating" });
    expect(pool.acquire).toHaveBeenCalledTimes(5);
    state.failure = new Error("shader rejected");
    const failed = encodeRtReflectionsFrame(host, {} as GPUDevice, {} as GPUCommandEncoder,
      { width: 64, height: 64 }, {} as never, {} as never, {} as never, {} as never);
    expect(failed.metrics).toEqual({ dispatched: false, reason: "shader rejected" });
    expect(pool.acquire).toHaveBeenCalledTimes(5);
    releaseRtReflectionFrameContribution(host, frame);
    expect(pool.release).toHaveBeenCalledTimes(5);
    vi.unstubAllGlobals();
  });
});
