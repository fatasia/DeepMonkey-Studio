import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probePbrMainSampleCount } from "./pbrMsaaCapability.js";

beforeEach(() => vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2 }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function probeDevice(popError: (scope: unknown) => Promise<unknown>) {
  const createTexture = vi.fn(() => ({ destroy: vi.fn() }));
  const device = { pushErrorScope: vi.fn(), popErrorScope: vi.fn(popError), createTexture };
  return { device: device as unknown as GPUDevice, createTexture, pushErrorScope: device.pushErrorScope };
}

describe("PBR main MSAA capability probe", () => {
  it("skips the probe entirely for an explicit 1x request", async () => {
    const { device, createTexture, pushErrorScope } = probeDevice(async () => null);
    await expect(probePbrMainSampleCount(device, 1)).resolves.toEqual({ sampleCount: 1 });
    expect(pushErrorScope).not.toHaveBeenCalled();
    expect(createTexture).not.toHaveBeenCalled();
  });

  it("resolves 4x when the probe textures validate cleanly", async () => {
    const { device, createTexture } = probeDevice(async () => null);
    await expect(probePbrMainSampleCount(device, 4)).resolves.toEqual({ sampleCount: 4 });
    // color(rgba16float)与 depth(depth32float)两张探针各创建一次并立即销毁。
    expect(createTexture).toHaveBeenCalledTimes(2);
    expect(createTexture.mock.calls[0]![0]).toMatchObject({ format: "rgba16float", sampleCount: 4 });
    expect(createTexture.mock.calls[1]![0]).toMatchObject({ format: "depth32float", sampleCount: 4 });
  });

  it("falls back to 1x with the adapter's validation message when 4x is rejected", async () => {
    const { device } = probeDevice(async () => ({ message: "sample count 4 unsupported for depth32float" }));
    await expect(probePbrMainSampleCount(device, 4)).resolves.toEqual({
      sampleCount: 1, fallbackReason: "sample count 4 unsupported for depth32float",
    });
  });

  it("falls back to 1x when the probe throws (synchronous rejection) and drains the scope", async () => {
    const device = {
      pushErrorScope: vi.fn(),
      popErrorScope: vi.fn(async () => null),
      createTexture: vi.fn(() => { throw new Error("destroyed device"); }),
    } as unknown as GPUDevice;
    await expect(probePbrMainSampleCount(device, 4)).resolves.toEqual({
      sampleCount: 1, fallbackReason: "destroyed device",
    });
    expect(device.popErrorScope).toHaveBeenCalledTimes(1);
  });
});
