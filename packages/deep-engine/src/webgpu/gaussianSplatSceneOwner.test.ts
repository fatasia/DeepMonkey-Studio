import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import type { SplatCloud } from "../gaussianSplat/decodeSplatPly.js";
import { GaussianSplatSceneOwner } from "./gaussianSplatSceneOwner.js";
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const frame = { viewMatrix: identity, viewProjectionMatrix: identity, cameraPosition: [0, 0, 0] as const,
  viewportPixels: [1920, 1080] as const, focalPixels: [900, 900] as const };
function cloud(): SplatCloud {
  const records = new Float32Array([0, 0, -2, .8, .2, .1, .1, 0, 0, 0, 0, 1, .1, .8, 1, .8,
    0, 0, -4, .8, .2, .1, .1, 0, 0, 0, 0, 1, 1, .2, .1, .8]);
  return { records, splatCount: 2, format: "splat-runtime-32b-v1", shDegree: 0, shRest: null, shRestCount: 0 };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function turns() { for (let n = 0; n < 16; n++) await Promise.resolve(); }
function fixture(reactive = false) {
  const owned = new Set<GPUBuffer>();
  const queue = { writeBuffer: vi.fn(), onSubmittedWorkDone: vi.fn(() => Promise.resolve()) };
  const device = { queue, limits: { maxBufferSize: 100_000, maxStorageBufferBindingSize: 100_000 },
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve(null as GPUError | null)),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({ ...descriptor, destroy: vi.fn() } as unknown as GPUBuffer)),
    createBindGroup: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})), createPipelineLayout: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})), createRenderPipeline: vi.fn(() => ({})) };
  const raw = { device, state: "ready", assertResourceAdmission: vi.fn(),
    own(buffer: GPUBuffer) { owned.add(buffer); return buffer; }, release(buffer: GPUBuffer) { if (owned.delete(buffer)) buffer.destroy(); } };
  const owner = new GaussianSplatSceneOwner(raw as unknown as DeviceSession, "rgba16float", "depth32float", reactive);
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() };
  const encoder = { beginRenderPass: vi.fn(() => pass) };
  const encode = () => owner.encode({ encoder: encoder as unknown as GPUCommandEncoder,
    color: {} as GPUTextureView, depth: {} as GPUTextureView, frame,
    ...(reactive ? { reactiveView: {} as GPUTextureView } : {}) });
  return { owner, owned, device, raw, queue, pass, encoder, encode };
}
beforeEach(() => { vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2, UNIFORM: 4 }); vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("Gaussian production cloud ownership", () => {
  it("uploads records once, caches ordering on an unchanged view, and uploads only u32 order after camera changes", async () => {
    const f = fixture(), source = cloud(); expect(await f.owner.stage(source)).toBe("staged");
    expect(f.owned.size).toBe(3); expect(f.queue.writeBuffer).toHaveBeenCalledTimes(1);
    source.records[2] = -100; // caller mutation after commit must not alter the scene's sort data.
    f.encode(); f.encode();
    const writes = f.queue.writeBuffer.mock.calls;
    expect(Array.from(writes[1]![2] as Uint32Array)).toEqual([1, 0]);
    expect(writes.filter(call => (call[2] as ArrayBufferView).byteLength === 128)).toHaveLength(1);
    expect(f.owner.current).toMatchObject({ sortCount: 1, orderUploads: 1, splatCount: 2, renderedShDegree: 0 });
    const moved = identity.slice(); moved[10] = -1;
    f.owner.encode({ encoder: f.encoder as unknown as GPUCommandEncoder, color: {} as GPUTextureView,
      depth: {} as GPUTextureView, frame: { ...frame, viewMatrix: moved } });
    expect(f.owner.current?.sortCount).toBe(2); expect(f.pass.draw).toHaveBeenCalledWith(4, 2);
    f.owner.dispose(); await turns(); expect(f.owned.size).toBe(0);
  });
  it("rejects invalid/over-budget records before allocation and retains the previous committed cloud", async () => {
    const f = fixture(); await f.owner.stage(cloud()); const before = f.owner.current;
    const invalid = cloud(); invalid.records[5] = NaN;
    await expect(f.owner.stage(invalid)).rejects.toThrow(/finite/);
    f.device.limits.maxStorageBufferBindingSize = 64;
    await expect(f.owner.stage(cloud())).rejects.toThrow(/budget/);
    expect(f.owner.current).toEqual(before); expect(f.owned.size).toBe(3); f.owner.dispose();
  });
  it("discards failed GPU candidates, retains old resources, and permits a later successful candidate", async () => {
    const f = fixture(); await f.owner.stage(cloud()); const before = f.owner.current;
    f.device.popErrorScope.mockResolvedValueOnce({ message: "bad Gaussian PSO" } as GPUError);
    await expect(f.owner.stage(cloud())).rejects.toThrow(/bad Gaussian PSO/);
    expect(f.owner.current).toEqual(before); expect(f.owned.size).toBe(3);
    const high = cloud(); high.shDegree = 3;
    expect(await f.owner.stage(high)).toBe("staged"); await turns();
    expect(f.owner.current).toMatchObject({ sourceShDegree: 3, renderedShDegree: 0, shFallbackReason: "higher-order-sh-stored-dc-rendered" });
    expect(f.device.createRenderPipeline).toHaveBeenCalledTimes(1); expect(f.owned.size).toBe(3); f.owner.dispose();
  });
  it("bounds reentrant GPU candidates, rejects pre-abort without allocation and retires superseded candidates", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    expect(await f.owner.stage(cloud(), controller.signal)).toBe("cancelled"); expect(f.owned.size).toBe(0);
    const scope = deferred<GPUError | null>(); f.device.popErrorScope.mockReturnValueOnce(scope.promise);
    const a = f.owner.stage(cloud()); await turns(); expect(f.owned.size).toBe(3);
    const b = f.owner.stage(cloud()); await turns(); expect(f.owned.size).toBe(3);
    scope.resolve(null); expect(await a).toBe("superseded"); expect(await b).toBe("staged");
    expect(f.owned.size).toBe(3); f.owner.dispose(); await turns(); expect(f.owned.size).toBe(0);
  });
  it("waits for submitted work before retiring a replaced or cleared cloud and rejects replaced devices", async () => {
    const f = fixture(); await f.owner.stage(cloud()); f.encode();
    const retired = deferred<void>(); f.queue.onSubmittedWorkDone.mockReturnValue(retired.promise);
    await f.owner.stage(cloud()); expect(f.owned.size).toBe(6);
    f.owner.clear(); expect(f.owner.current).toBeUndefined(); expect(f.owned.size).toBe(6);
    retired.resolve(); await turns(); expect(f.owned.size).toBe(0);
    f.raw.device = { ...f.device }; expect(() => f.encode()).toThrow(/epoch/); f.owner.dispose();
  });
  it("uses matching HDR/depth/TAA attachments and preserves an earlier reactive writer", async () => {
    const f = fixture(true); await f.owner.stage(cloud()); f.encode();
    expect(f.device.createRenderPipeline.mock.calls[0]![0]).toMatchObject({
      fragment: { entryPoint: "fsMainReactive", targets: [{ format: "rgba16float" }, { format: "r8unorm" }] },
      depthStencil: { depthWriteEnabled: false, depthCompare: "less-equal" } });
    expect(f.encoder.beginRenderPass.mock.calls[0]![0].colorAttachments[1]).toMatchObject({ loadOp: "clear", clearValue: [0, 0, 0, 0] });
    f.owner.encode({ encoder: f.encoder as unknown as GPUCommandEncoder, color: {} as GPUTextureView, depth: {} as GPUTextureView,
      frame, reactiveView: {} as GPUTextureView, clearReactive: false });
    expect(f.encoder.beginRenderPass.mock.calls[1]![0].colorAttachments[1].loadOp).toBe("load"); f.owner.dispose();
  });
});
