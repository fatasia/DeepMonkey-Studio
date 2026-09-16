import { afterEach, describe, expect, it, vi } from "vitest";
import { SpatialAaPresent } from "./spatialAaPresent.js";
import type { DeviceSession } from "./deviceSession.js";
function fixture() {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 });
  const owned = new Set<GPUTexture>();
  const device = { limits: { maxTextureDimension2D: 8192 }, createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) })), createSampler: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
    createTexture: vi.fn((d: GPUTextureDescriptor) => { const size = d.size as number[];
      return { width: size[0], height: size[1], createView: vi.fn(() => ({})), destroy: vi.fn() } as unknown as GPUTexture; }) };
  const raw = { state: "ready", format: "bgra8unorm", device,
    own: (r: GPUTexture) => { owned.add(r); return r; }, release: (r: GPUTexture) => { if (owned.delete(r)) r.destroy(); } };
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() };
  const encoder = { beginRenderPass: vi.fn(() => pass) } as unknown as GPUCommandEncoder;
  return { raw, device, owned, pass, encoder, session: raw as unknown as DeviceSession };
}
afterEach(() => vi.unstubAllGlobals());
describe("spatial AA presentation ownership", () => {
  it("reuses same-size target, transactionally resizes and releases everything once", () => {
    const f = fixture(), aa = new SpatialAaPresent(f.session), view = aa.prepare(32, 16);
    expect(aa.prepare(32, 16)).toBe(view); expect(f.owned.size).toBe(1);
    const old = [...f.owned][0]!; aa.prepare(64, 32); expect(old.destroy).toHaveBeenCalledOnce();
    expect(f.owned.size).toBe(1); aa.encode(f.encoder, {} as GPUTextureView);
    expect(f.pass.draw).toHaveBeenCalledWith(3); expect(f.pass.end).toHaveBeenCalledOnce();
    aa.dispose(); aa.dispose(); expect(f.owned.size).toBe(0);
    expect(() => aa.prepare(1, 1)).toThrow("disposed");
  });
  it.each(["allocation", "view", "binding"])("preserves previous target after failed %s during resize", point => {
    const f = fixture(), aa = new SpatialAaPresent(f.session), previous = aa.prepare(32, 16), old = [...f.owned][0]!;
    if (point === "allocation") f.device.createTexture.mockImplementationOnce(() => { throw Error("injected"); });
    if (point === "view") f.device.createTexture.mockImplementationOnce(() => ({ width: 64, height: 32, destroy: vi.fn(), createView: () => { throw Error("injected"); } }) as unknown as GPUTexture);
    if (point === "binding") f.device.createBindGroup.mockImplementationOnce(() => { throw Error("injected"); });
    expect(() => aa.prepare(64, 32)).toThrow("injected"); expect(aa.prepare(32, 16)).toBe(previous);
    expect(old.destroy).not.toHaveBeenCalled(); expect(f.owned.size).toBe(1); aa.dispose();
  });
  it("ends failed drawing, rejects unprepared targets and cleans up on loss", () => {
    const f = fixture(), aa = new SpatialAaPresent(f.session);
    expect(() => aa.encode(f.encoder, {} as GPUTextureView)).toThrow("not prepared");
    aa.prepare(2, 2); f.pass.draw.mockImplementationOnce(() => { throw Error("draw failed"); });
    expect(() => aa.encode(f.encoder, {} as GPUTextureView)).toThrow("draw failed"); expect(f.pass.end).toHaveBeenCalledOnce();
    f.raw.state = "lost"; expect(() => aa.prepare(2, 2)).toThrow("not ready"); expect(f.owned.size).toBe(0);
  });
  it("rejects automatic sRGB decoding and invalid dimensions before allocation", () => {
    const f = fixture(); f.raw.format = "bgra8unorm-srgb"; expect(() => new SpatialAaPresent(f.session)).toThrow("non-sRGB");
    f.raw.format = "rgba8unorm"; const aa = new SpatialAaPresent(f.session);
    for (const size of [0, -1, 1.5, 8193, NaN]) expect(() => aa.prepare(size, 1)).toThrow("dimensions");
    expect(f.device.createTexture).not.toHaveBeenCalled(); aa.dispose();
  });
});
