import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import type { Pipelines } from "./pipelines.js";
import { PbrOutputBindings } from "./pbrOutputBindings.js";

function fixture() {
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 64, COPY_DST: 8 });
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 });
  const owned = new Set<unknown>();
  const device = { limits: { maxTextureDimension2D: 8192 }, createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) })),
    createTexture: vi.fn(() => ({ width: 32, height: 16, createView: () => ({}), destroy: vi.fn() })),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })), createSampler: vi.fn(() => ({})),
    createBindGroup: vi.fn((_descriptor: unknown) => ({})), queue: { writeBuffer: vi.fn() } };
  const surface = {} as GPUTextureView;
  const context = { getCurrentTexture: vi.fn(() => ({ createView: () => surface })) };
  const session = { device, context, state: "ready", format: "bgra8unorm", own: (value: unknown) => { owned.add(value); return value; },
    release: vi.fn((value: unknown) => { owned.delete(value); }) } as unknown as DeviceSession;
  const pipelines = { output: { getBindGroupLayout: (index: number) => ({ index }) } } as unknown as Pipelines;
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() };
  const encoder = { beginRenderPass: vi.fn((_descriptor: unknown) => pass) };
  const source = { width: 32, height: 16, createView: vi.fn(() => ({})) } as unknown as GPUTexture;
  return { owned, device, context, session, pipelines, pass, encoder, source, surface };
}
afterEach(() => vi.unstubAllGlobals());

describe("PBR output pass ownership", () => {
  it("explicitly disabled spatial AA uses one display pass without intermediate allocation", () => {
    const f = fixture(), output = new PbrOutputBindings(f.session, f.pipelines, () => 0, false);
    const queries = {} as GPUQuerySet;
    output.encode(f.encoder as unknown as GPUCommandEncoder, f.source, f.surface, {}, queries);
    expect(f.device.createTexture).not.toHaveBeenCalled(); expect(f.pass.draw).toHaveBeenCalledOnce();
    expect(f.encoder.beginRenderPass).toHaveBeenCalledWith(expect.objectContaining({
      colorAttachments: [{ view: f.surface, loadOp: "clear", storeOp: "store" }],
      timestampWrites: { querySet: queries, endOfPassWriteIndex: 1 } }));
    output.dispose(); expect(f.owned.size).toBe(0);
  });
  it("owns both uniforms, caches source bindings and encodes display timestamps", () => {
    const f = fixture(), output = new PbrOutputBindings(f.session, f.pipelines, () => 0), queries = {} as GPUQuerySet;
    expect(f.owned.size).toBe(2);
    const present = output.present(f.encoder as unknown as GPUCommandEncoder, f.source, {}, false, queries);
    expect(present).toEqual({ view: f.surface, acquireMs: 0 });
    expect(f.encoder.beginRenderPass).toHaveBeenLastCalledWith(expect.objectContaining({
      timestampWrites: { querySet: queries, endOfPassWriteIndex: 1 } }));
    expect(f.pass.setBindGroup.mock.calls.map(call => call[0])).toEqual([0, 1, 0]);
    expect(f.pass.draw).toHaveBeenCalledWith(3); expect(f.pass.end).toHaveBeenCalledTimes(2);
    output.encode(f.encoder as unknown as GPUCommandEncoder, f.source, f.surface, {});
    expect(f.device.createBindGroup).toHaveBeenCalledTimes(3);
    expect(f.source.createView).toHaveBeenCalledOnce();
    output.dispose(); output.dispose(); expect(f.owned.size).toBe(0);
    expect(f.session.release).toHaveBeenCalledTimes(3);
    expect(() => output.acquirePresent(false)).toThrow("disposed");
  });
  it.each(["sampler", "author-binding"])("rolls back allocated uniforms if %s construction fails", point => {
    const f = fixture();
    if (point === "sampler") f.device.createSampler.mockImplementation(() => { throw new Error("failed"); });
    else f.device.createBindGroup.mockImplementation(() => { throw new Error("failed"); });
    expect(() => new PbrOutputBindings(f.session, f.pipelines, () => 0)).toThrow("failed");
    expect(f.owned.size).toBe(0);
  });
  it("retries failed source binding creation without opening a render pass", () => {
    const f = fixture(), output = new PbrOutputBindings(f.session, f.pipelines, () => 0);
    f.device.createBindGroup.mockImplementationOnce(() => { throw new Error("source unavailable"); });
    expect(() => output.encode(f.encoder as unknown as GPUCommandEncoder, f.source, f.surface, {})).toThrow("source unavailable");
    expect(f.encoder.beginRenderPass).not.toHaveBeenCalled();
    output.encode(f.encoder as unknown as GPUCommandEncoder, f.source, f.surface, {});
    expect(f.pass.draw).toHaveBeenCalledTimes(2); output.dispose();
  });
  it("ends an opened pass after draw failure without submitting work", () => {
    const f = fixture(), output = new PbrOutputBindings(f.session, f.pipelines, () => 0);
    f.pass.draw.mockImplementationOnce(() => { throw new Error("encode rejected"); });
    expect(() => output.encode(f.encoder as unknown as GPUCommandEncoder, f.source, f.surface)).toThrow("encode rejected");
    expect(f.pass.end).toHaveBeenCalledOnce(); output.dispose();
  });
});
