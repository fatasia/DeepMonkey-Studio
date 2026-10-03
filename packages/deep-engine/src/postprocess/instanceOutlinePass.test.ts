import { afterEach, describe, expect, it, vi } from "vitest";
import { InstanceOutlinePass } from "./instanceOutline.js";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { PbrTransientTexturePool } from "../webgpu/pbrTransientTexturePool.js";

function fixture() {
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, COMPUTE: 4 });
  vi.stubGlobal("GPUTextureUsage", { COPY_SRC: 1, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 64, COPY_DST: 8 });
  const owned = new Set<unknown>();
  const view = (texture: unknown) => ({ texture });
  const createTexture = vi.fn((descriptor: GPUTextureDescriptor) => {
    const size = descriptor.size as GPUExtent3DDict;
    return { width: size.width, height: size.height, format: descriptor.format, usage: descriptor.usage, destroy: vi.fn(),
      createView: vi.fn(function(this: unknown) { return view(this); }) } as unknown as GPUTexture;
  });
  const device = { queue: { writeBuffer: vi.fn() },
    createShaderModule: vi.fn((d: unknown) => d), createBindGroupLayout: vi.fn((d: unknown) => d),
    createPipelineLayout: vi.fn((d: unknown) => d),
    createRenderPipeline: vi.fn((d: unknown) => d), createComputePipeline: vi.fn((d: unknown) => d),
    createSampler: vi.fn((d: unknown) => d), createBindGroup: vi.fn((d: unknown) => d),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })), createTexture };
  const session = { state: "ready", device,
    own<T>(value: T): T { owned.add(value); return value; },
    release(value: { destroy(): void }) { if (owned.delete(value)) value.destroy(); } };
  const pool = new PbrTransientTexturePool(session as unknown as DeviceSession);
  const events: string[] = [];
  const raster = { setBindGroup: vi.fn(), setPipeline: vi.fn((p: GPURenderPipelineDescriptor) => events.push(`pipeline:${p.label}`)), end: vi.fn() };
  const computes: Array<{ label?: string; dispatch?: number[] }> = [];
  const encoder = {
    beginRenderPass: vi.fn((d: GPURenderPassDescriptor) => { events.push("raster"); (raster as { descriptor?: unknown }).descriptor = d; return raster; }),
    beginComputePass: vi.fn((d: { label?: string }) => { const entry: typeof computes[number] = { label: d.label }; computes.push(entry);
      return { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: (x: number, y: number) => { entry.dispatch = [x, y]; }, end: vi.fn() }; }),
  };
  return { device, session: session as unknown as DeviceSession, pool, encoder, raster, computes, events, createTexture, owned,
    color: createTexture({ size: { width: 33, height: 17 }, format: "rgba16float", usage: 0 } as GPUTextureDescriptor) };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("InstanceOutlinePass", () => {
  it("builds nothing until constructed: only shader, 2 raster + 2 compute pipelines and 2 tiny buffers", () => {
    const f = fixture();
    expect(f.device.createRenderPipeline).not.toHaveBeenCalled();
    const pass = new InstanceOutlinePass(f.session, f.pool);
    expect(f.device.createShaderModule).toHaveBeenCalledTimes(1);
    expect(f.device.createRenderPipeline).toHaveBeenCalledTimes(2);
    expect(f.device.createComputePipeline).toHaveBeenCalledTimes(2);
    expect(f.device.createBuffer).toHaveBeenCalledTimes(2);
    const visible = f.device.createRenderPipeline.mock.calls[1]![0] as GPURenderPipelineDescriptor;
    expect(visible.depthStencil).toMatchObject({ depthCompare: "less-equal", depthWriteEnabled: false });
    expect(visible.depthStencil!.depthBias).toBeLessThan(0);
    expect((visible.fragment!.targets[0] as GPUColorTargetState).writeMask).toBe(2);
    pass.dispose(); expect(f.owned.size).toBe(0);
  });

  it("encodes silhouette then visible draws into one mask pass, then half-res edge and full-res compose", () => {
    const f = fixture(), pass = new InstanceOutlinePass(f.session, f.pool);
    const draw = vi.fn(() => ({ drawCalls: 3, skippedBatches: 1 }));
    f.pool.beginFrame();
    const depthView = {} as GPUTextureView;
    const result = pass.encode(f.encoder as unknown as GPUCommandEncoder, { color: f.color, depthView,
      viewProjection: new Float32Array(16), options: { strength: 4 }, draw });
    f.pool.endFrame(true);
    expect(f.events).toEqual(["raster", "pipeline:Deep instance outline silhouette", "pipeline:Deep instance outline visible"]);
    expect(draw).toHaveBeenCalledTimes(2);
    const descriptor = (f.raster as unknown as { descriptor: GPURenderPassDescriptor }).descriptor;
    expect(descriptor.depthStencilAttachment).toMatchObject({ view: depthView, depthReadOnly: true });
    expect((descriptor.colorAttachments as GPURenderPassColorAttachment[])[0]).toMatchObject({ clearValue: [1, 1, 0, 0], loadOp: "clear" });
    expect(f.computes.map(entry => entry.dispatch)).toEqual([[3, 2], [5, 3]]);
    expect(result).toMatchObject({ width: 33, height: 17, passCount: 3, drawCalls: 6, skippedBatches: 1 });
    expect(result.texture).not.toBe(f.color);
    expect(result.texture).toMatchObject({ format: "rgba16float" });
    const labels = f.createTexture.mock.calls.map(call => (call[0] as GPUTextureDescriptor).label);
    expect(labels).toEqual(expect.arrayContaining(["Deep transient outline-mask", "Deep transient outline-edge", "Deep transient outline-hdr"]));
    const edge = f.createTexture.mock.calls.find(call => (call[0] as GPUTextureDescriptor).label === "Deep transient outline-edge")![0] as GPUTextureDescriptor;
    expect(edge.size).toMatchObject({ width: 17, height: 9 });
  });

  it("rejects use outside an open pool frame, a bad matrix, and after disposal", () => {
    const f = fixture(), pass = new InstanceOutlinePass(f.session, f.pool);
    const input = { color: f.color, depthView: {} as GPUTextureView, viewProjection: new Float32Array(16), draw: () => ({ drawCalls: 0, skippedBatches: 0 }) };
    expect(() => pass.encode(f.encoder as unknown as GPUCommandEncoder, input)).toThrow(/open frame/);
    f.pool.beginFrame();
    expect(() => pass.encode(f.encoder as unknown as GPUCommandEncoder, { ...input, viewProjection: [1, 2] })).toThrow(/4x4/);
    f.pool.endFrame(false);
    pass.dispose();
    expect(() => pass.encode(f.encoder as unknown as GPUCommandEncoder, input)).toThrow(/disposed/);
  });
});
