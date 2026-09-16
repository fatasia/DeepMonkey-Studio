import { afterEach, expect, it, vi } from "vitest";
import { renderDeep2dGpuFrame } from "./gpu.js";
import type { Deep2dGpuFrame } from "./frame.js";
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, COPY_DST: 2 });
  const destroyed: object[] = [], owned: object[] = [], scopes: string[] = [];
  const resource = () => { const r = { createView: () => ({}), destroy: () => { destroyed.push(r); } }; owned.push(r); return r; };
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(), draw: vi.fn(), end: vi.fn() };
  const device = { limits: { maxTextureDimension2D: 8192 },
    pushErrorScope: (kind: string) => { scopes.push(kind); }, popErrorScope: vi.fn(async () => { scopes.pop(); return null; }),
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createRenderPipelineAsync: vi.fn(async () => ({ getBindGroupLayout: () => ({}) })),
    createTexture: resource, createBuffer: resource, createSampler: () => ({}), createBindGroup: () => ({}),
    createCommandEncoder: () => ({ beginRenderPass: () => pass, finish: () => ({}) }),
    queue: { writeTexture: vi.fn(), writeBuffer: vi.fn(), submit: vi.fn(), onSubmittedWorkDone: vi.fn(async () => {}) },
  };
  const context = { getCurrentTexture: () => ({ createView: () => ({}) }) };
  const frame: Deep2dGpuFrame = { width: 16, height: 16, gpuBytes: 6000,
    atlases: new Map([["a", { bytes: new Uint8Array([255]), width: 1, height: 1, format: "r8unorm", sampling: "nearest" }]]),
    draws: [{ atlasKey: "a", vertices: new Float32Array(36) }] };
  const run = (signal = new AbortController().signal) => renderDeep2dGpuFrame(device as unknown as GPUDevice,
    context as unknown as GPUCanvasContext, "rgba8unorm-srgb", frame, signal);
  return { device, scopes, owned, destroyed, pass, run };
}
afterEach(() => vi.unstubAllGlobals());
it("owns real GPU API allocations until release and balances error scopes", async () => {
  const f = fixture(), lease = await f.run();
  expect(f.device.queue.submit).toHaveBeenCalledOnce(); expect(f.pass.draw).toHaveBeenCalledWith(3);
  expect(f.device.queue.writeTexture).toHaveBeenCalledOnce(); expect(f.scopes).toEqual([]);
  expect(f.destroyed).toHaveLength(0); lease.dispose(); lease.dispose();
  expect(f.destroyed).toHaveLength(3); expect(new Set(f.destroyed).size).toBe(3);
});
it("awaits cancelled submission before reclaiming resources instead of treating abort as completion", async () => {
  const f = fixture(), entered = deferred(), resume = deferred(), abort = new AbortController();
  f.device.queue.onSubmittedWorkDone.mockImplementation(async () => { entered.resolve(); await resume.promise; });
  const pending = f.run(abort.signal); await entered.promise; abort.abort();
  expect(f.destroyed).toHaveLength(0); resume.resolve();
  await expect(pending).rejects.toThrow(/candidate failed/);
  expect(f.destroyed).toHaveLength(3); expect(f.scopes).toEqual([]);
});
it("rejects late GPU validation and releases every allocation", async () => {
  const f = fixture(); f.device.popErrorScope.mockImplementationOnce(async () => { f.scopes.pop(); return { message: "validation" } as never; });
  await expect(f.run()).rejects.toThrow(/candidate failed/);
  expect(f.destroyed).toHaveLength(3); expect(f.scopes).toEqual([]);
});
it("settles all pipeline compilations before unwinding a failed candidate", async () => {
  const f = fixture(), entered = deferred(), resume = deferred();
  f.device.createRenderPipelineAsync.mockImplementationOnce(async () => { throw new Error("bad shader"); })
    .mockImplementationOnce(async () => { entered.resolve(); await resume.promise; return { getBindGroupLayout: () => ({}) }; });
  const pending = f.run(); await entered.promise;
  expect(f.device.popErrorScope).not.toHaveBeenCalled(); resume.resolve();
  await expect(pending).rejects.toThrow(/candidate failed/); expect(f.scopes).toEqual([]);
});
