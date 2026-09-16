import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../src/webgpu/deviceSession.js";
import { runSpatialAaProbe } from "./spatialAaProbe.js";
function fixture() {
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4, COPY_SRC: 8 });
  const owned = new Set<GPUTexture>();
  const device = { pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null), features: new Set(),
    createShaderModule: vi.fn(() => ({ getCompilationInfo: async () => ({ messages: [] }) })),
    createRenderPipelineAsync: vi.fn(async () => ({ getBindGroupLayout: () => ({}) })), createSampler: vi.fn(() => ({})),
    createTexture: vi.fn(() => ({ destroy: vi.fn() }) as unknown as GPUTexture) };
  const raw = { state: "ready", device, get resourceCount() { return owned.size; },
    own: (r: GPUTexture) => { owned.add(r); return r; }, release: (r: GPUTexture) => { if (owned.delete(r)) r.destroy(); } };
  return { raw, device, owned, session: raw as unknown as DeviceSession };
}
afterEach(() => vi.unstubAllGlobals());
describe("spatial AA GPU probe failure cleanup", () => {
  it("does not open scopes on a lost session", async () => {
    const f = fixture(); f.raw.state = "lost";
    await expect(runSpatialAaProbe(f.session)).rejects.toThrow("ready"); expect(f.device.pushErrorScope).not.toHaveBeenCalled();
  });
  it("pops its error scope exactly once on pipeline rejection", async () => {
    const f = fixture(); f.device.createRenderPipelineAsync.mockRejectedValueOnce(Error("pipeline failed"));
    await expect(runSpatialAaProbe(f.session)).rejects.toThrow("pipeline failed");
    expect(f.device.popErrorScope).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(0);
  });
  it("releases the input when output allocation fails", async () => {
    const f = fixture(), source = { destroy: vi.fn() } as unknown as GPUTexture;
    f.device.createTexture.mockReturnValueOnce(source).mockImplementationOnce(() => { throw Error("allocation failed"); });
    await expect(runSpatialAaProbe(f.session)).rejects.toThrow("allocation failed");
    expect(source.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(0); expect(f.device.popErrorScope).toHaveBeenCalledOnce();
  });
});
