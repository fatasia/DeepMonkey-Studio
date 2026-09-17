import { describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { DeviceResourceMemory } from "./deviceResourceMemory.js";
import { createAdmittedBuffer, createAdmittedTexture } from "./resourceAdmission.js";

function fixture() {
  const memory = new DeviceResourceMemory(64);
  const device = { createBuffer: vi.fn((d: GPUBufferDescriptor) => ({ size: d.size, destroy: vi.fn() })),
    createTexture: vi.fn((d: GPUTextureDescriptor) => ({ ...(d.size as object), dimension: d.dimension ?? "2d",
      mipLevelCount: d.mipLevelCount ?? 1, sampleCount: d.sampleCount ?? 1, format: d.format, destroy: vi.fn() })) };
  const session = { device, assertResourceAdmission: (d: object) => memory.assertCanAdd(d),
    own: (resource: object) => { memory.add(resource); return resource; } } as unknown as DeviceSession;
  return { memory, device, session };
}
describe("pre-allocation resource admission", () => {
  it("rejects candidates before createBuffer and preserves old allocations", () => {
    const f = fixture(); createAdmittedBuffer(f.session, { size: 48, usage: 1 });
    expect(() => createAdmittedBuffer(f.session, { size: 32, usage: 1 })).toThrow(/budget exceeded/);
    expect(f.device.createBuffer).toHaveBeenCalledOnce(); expect(f.memory.snapshot.estimatedBytes).toBe(48);
  });
  it("normalizes one-shot extents and applies the same byte estimator to texture admission", () => {
    const f = fixture();
    function* extent() { yield 4; yield 4; }
    createAdmittedTexture(f.session, { size: extent(), format: "rgba8unorm", usage: 1 });
    expect(f.device.createTexture.mock.calls[0]![0].size).toEqual({ width: 4, height: 4, depthOrArrayLayers: 1 });
    expect(f.memory.snapshot.estimatedBytes).toBe(64);
    expect(() => createAdmittedTexture(f.session, { size: [1], format: "rgba8unorm", usage: 1 })).toThrow(/budget exceeded/);
    expect(f.device.createTexture).toHaveBeenCalledOnce();
  });
  it("rejects unknown texture layouts before GPU allocation", () => {
    const f = fixture();
    expect(() => createAdmittedTexture(f.session, { size: [1, 1], format: "depth24plus", usage: 1 })).toThrow(/known resource sizes/);
    expect(f.device.createTexture).not.toHaveBeenCalled();
  });
});
