import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { PbrTransparencyPass } from "./pbrTransparencyPass.js";

interface FakeTexture extends GPUTexture { destroy: ReturnType<typeof vi.fn>; createView: ReturnType<typeof vi.fn> }
function texture(width = 64, height = 32, label = "external"): FakeTexture {
  const value = { width, height, label, format: "rgba16float", destroy: vi.fn(), createView: vi.fn(() => ({ texture: value })) };
  return value as unknown as FakeTexture;
}
function fixture() {
  const owned = new Set<GPUTexture>(), textures: FakeTexture[] = [];
  const device = { limits: { maxTextureDimension2D: 8192 },
    createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})), createPipelineLayout: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})), createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const size = descriptor.size as GPUExtent3DDict, value = texture(Number(size.width), Number(size.height), descriptor.label);
      textures.push(value); return value;
    }) };
  const raw = { state: "ready", device, own<T extends GPUTexture>(value: T) { owned.add(value); return value; },
    release(value: GPUTexture) { if (owned.delete(value)) value.destroy(); } };
  const passes: Array<{ descriptor: GPURenderPassDescriptor; end: ReturnType<typeof vi.fn>; draw: ReturnType<typeof vi.fn> }> = [];
  const begin = vi.fn((descriptor: GPURenderPassDescriptor) => {
    const pass = { descriptor, end: vi.fn(), draw: vi.fn(), setPipeline: vi.fn(), setBindGroup: vi.fn() }; passes.push(pass); return pass;
  });
  const encoder = { beginRenderPass: begin } as unknown as GPUCommandEncoder;
  const owner = new PbrTransparencyPass(raw as unknown as DeviceSession);
  const input = (same = true, width = 64, height = 32) => {
    const hdrColor = texture(width, height), opaqueColor = same ? hdrColor : texture(width, height, "AO output");
    const views = new Map<GPUTexture, GPUTextureView>();
    const viewOf = (t: GPUTexture) => { if (!views.has(t)) views.set(t, t.createView()); return views.get(t)!; };
    return { encoder, hdrColor, opaqueColor, hdrView: viewOf(hdrColor), depthView: {} as GPUTextureView, viewOf,
      draw: vi.fn((_pass: GPURenderPassEncoder) => ({ drawCalls: 2, triangles: 7 })) };
  };
  return { owner, input, device, raw, owned, textures, passes, begin };
}
beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { FRAGMENT: 2 });
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4 });
  vi.stubGlobal("GPUColorWrite", { RED: 1, ALL: 15 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("PBR transparency composition ownership", () => {
  it("attempts scratch and both OIT releases even when destruction throws, then stays disposed", () => {
    const f = fixture(); f.owner.encode(f.input());
    for (const value of f.textures) value.destroy.mockImplementation(() => { throw Error("destroy failed"); });
    expect(() => f.owner.dispose()).toThrow(); expect(f.owner.currentColor).toBeUndefined();
    f.textures.forEach(value => expect(value.destroy).toHaveBeenCalledOnce()); expect(f.owned.size).toBe(0);
    expect(() => f.owner.dispose()).not.toThrow();
    expect(() => f.owner.encode(f.input())).toThrow("disposed");
  });
  it("keeps the new scratch allocation if retiring the old scratch throws", () => {
    const f = fixture(), old = f.owner.encode(f.input()).color as FakeTexture;
    old.destroy.mockImplementation(() => { throw Error("scratch retirement failed"); });
    expect(() => f.owner.encode(f.input(true, 128, 64))).toThrow("scratch retirement failed");
    expect(f.owner.currentColor).toBeUndefined(); expect(f.owned.size).toBe(3);
    const allocations = f.textures.length, next = f.owner.encode(f.input(true, 128, 64)).color;
    expect(next).not.toBe(old); expect(f.textures).toHaveLength(allocations);
    expect(next.destroy).not.toHaveBeenCalled(); expect(old.destroy).toHaveBeenCalledOnce();
    f.owner.dispose(); expect(f.owned.size).toBe(0);
  });
  it("AO off composites into a non-aliased HDR target with the actual opaque/accumulation/revealage bindings", () => {
    const f = fixture(), input = f.input(), result = f.owner.encode(input);
    expect(result.color).not.toBe(input.opaqueColor); expect(result.color.format).toBe("rgba16float");
    expect(result).toMatchObject({ drawCalls: 3, triangles: 8 }); expect(f.owner.currentColor).toBe(result.color);
    const entries = [...f.device.createBindGroup.mock.calls.at(-1)![0].entries];
    expect(entries[0]).toEqual({ binding: 0, resource: input.viewOf(input.opaqueColor) });
    const accumulation = [...f.passes[0]!.descriptor.colorAttachments];
    expect(entries[1]!.resource).toBe(accumulation[0]!.view); expect(entries[2]!.resource).toBe(accumulation[1]!.view);
    expect([...f.passes[1]!.descriptor.colorAttachments][0]!.view).not.toBe(input.hdrView);
    expect(f.passes[0]!.descriptor.depthStencilAttachment?.view).toBe(input.depthView);
    expect(f.passes[1]!.draw).toHaveBeenCalledWith(3); expect(f.owned.size).toBe(3);
    f.owner.dispose(); expect(f.owned.size).toBe(0); expect(input.hdrColor.destroy).not.toHaveBeenCalled();
  });
  it("AO on reuses external HDR without allocating a scratch target", () => {
    const f = fixture(), input = f.input(false), result = f.owner.encode(input);
    expect(result.color).toBe(input.hdrColor); expect(f.owned.size).toBe(2);
    expect([...f.passes[1]!.descriptor.colorAttachments][0]!.view).toBe(input.hdrView);
    expect([...f.device.createBindGroup.mock.calls.at(-1)![0].entries][0]!.resource).toBe(input.viewOf(input.opaqueColor));
    f.owner.dispose(); expect(input.hdrColor.destroy).not.toHaveBeenCalled();
  });
  it("reuses same-size accumulation and scratch allocations across frames", () => {
    const f = fixture(), first = f.owner.encode(f.input()).color;
    expect(f.owner.encode(f.input()).color).toBe(first); expect(f.device.createTexture).toHaveBeenCalledTimes(3);
    const next = f.owner.encode(f.input(true, 128, 64)).color;
    expect(next).not.toBe(first); expect(first.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(3);
    f.owner.dispose(); f.owner.dispose(); expect(f.owned.size).toBe(0);
  });
  it.each(["allocation", "view"])("keeps the previous scratch after failed resize %s and publishes no failed output", point => {
    const f = fixture(), first = f.owner.encode(f.input()).color;
    const original = f.device.createTexture.getMockImplementation()!;
    f.device.createTexture.mockImplementation(descriptor => {
      if (descriptor.label === "Deep OIT composite HDR") {
        if (point === "allocation") throw Error("scratch failed");
        const value = original(descriptor); value.createView.mockImplementation(() => { throw Error("scratch failed"); }); return value;
      }
      return original(descriptor);
    });
    expect(() => f.owner.encode(f.input(true, 128, 64))).toThrow("scratch failed");
    expect(first.destroy).not.toHaveBeenCalled(); expect(f.owner.currentColor).toBeUndefined(); expect(f.owned.size).toBe(3);
    f.device.createTexture.mockImplementation(original);
    expect(f.owner.encode(f.input()).color).toBe(first); f.owner.dispose(); expect(f.owned.size).toBe(0);
  });
  it("rolls back partial OIT resize allocation before opening another pass", () => {
    const f = fixture(), first = f.owner.encode(f.input()).color, prior = [...f.owned], opened = f.passes.length;
    const original = f.device.createTexture.getMockImplementation()!;
    f.device.createTexture.mockImplementation(descriptor => {
      if (descriptor.label === "Deep weighted OIT revealage") throw Error("revealage failed");
      return original(descriptor);
    });
    expect(() => f.owner.encode(f.input(true, 128, 64))).toThrow("revealage failed");
    expect(f.owned.size).toBe(3); prior.forEach(value => expect(value.destroy).not.toHaveBeenCalled());
    expect(f.passes).toHaveLength(opened); expect(f.owner.currentColor).toBeUndefined();
    f.device.createTexture.mockImplementation(original); expect(f.owner.encode(f.input()).color).toBe(first);
    f.owner.dispose(); expect(f.owned.size).toBe(0);
  });
  it.each(["draw", "composite"])("ends the opened %s pass and hides failed output", point => {
    const f = fixture(); f.owner.encode(f.input()); f.passes.length = 0;
    const input = f.input();
    if (point === "draw") input.draw.mockImplementation(() => { throw Error("draw failed"); });
    else {
      const original = f.begin.getMockImplementation()!;
      f.begin.mockImplementation(descriptor => { const pass = original(descriptor);
        if (descriptor.label === "Deep weighted OIT composite") pass.draw.mockImplementation(() => { throw Error("draw failed"); });
        return pass;
      });
    }
    expect(() => f.owner.encode(input)).toThrow("draw failed"); expect(f.owner.currentColor).toBeUndefined();
    expect(f.passes).toHaveLength(point === "draw" ? 1 : 2);
    f.passes.forEach(pass => expect(pass.end).toHaveBeenCalledOnce()); f.owner.dispose(); expect(f.owned.size).toBe(0);
  });
  it("hides output immediately on device loss and releases resources on the next encode", () => {
    const f = fixture(); f.owner.encode(f.input()); f.raw.state = "lost";
    expect(f.owner.currentColor).toBeUndefined(); expect(() => f.owner.encode(f.input())).toThrow("not ready");
    expect(f.owned.size).toBe(0); f.owner.dispose();
    expect(() => f.owner.encode(f.input())).toThrow("disposed");
  });
});
