import { describe, expect, it } from "vitest";
import { DeviceResourceMemory, estimateDeviceResource } from "./deviceResourceMemory.js";

const texture = (overrides: object = {}) => ({ width: 8, height: 8, depthOrArrayLayers: 1,
  mipLevelCount: 1, sampleCount: 1, dimension: "2d", format: "rgba8unorm", ...overrides });

describe("device allocation estimates", () => {
  it("counts mips, MSAA, array layers and shrinking 3D depth separately", () => {
    expect(estimateDeviceResource(texture({ mipLevelCount: 4, depthOrArrayLayers: 6 })))
      .toEqual({ kind: "texture", bytes: (64 + 16 + 4 + 1) * 4 * 6 });
    expect(estimateDeviceResource(texture({ sampleCount: 4 }))).toEqual({ kind: "texture", bytes: 1024 });
    expect(estimateDeviceResource(texture({ dimension: "3d", depthOrArrayLayers: 8, mipLevelCount: 4 })))
      .toEqual({ kind: "texture", bytes: (512 + 64 + 8 + 1) * 4 });
  });
  it("uses block rounding for compressed tails", () => {
    expect(estimateDeviceResource(texture({ format: "bc1-rgba-unorm", mipLevelCount: 4 })))
      .toEqual({ kind: "texture", bytes: 32 + 8 + 8 + 8 });
    expect(estimateDeviceResource(texture({ format: "bc6h-rgb-ufloat" })))
      .toEqual({ kind: "texture", bytes: 64 });
    expect(estimateDeviceResource(texture({ format: "astc-5x4-unorm" })))
      .toEqual({ kind: "texture", bytes: 64 });
    expect(estimateDeviceResource(texture({ format: "eac-rg11unorm" })))
      .toEqual({ kind: "texture", bytes: 64 });
  });
  it("reports undefined layouts and invalid sizes as unknown", () => {
    for (const resource of [{}, { size: NaN }, { size: -1 }, texture({ format: "depth24plus" }),
      texture({ mipLevelCount: 100000 }), texture({ width: Number.MAX_SAFE_INTEGER }), texture({ width: 0 })]) {
      expect(estimateDeviceResource(resource)).toBeUndefined();
    }
  });
  it("counts simultaneous old and candidate resources without duplicate ownership", () => {
    const memory = new DeviceResourceMemory(), old = { size: 32 }, candidate = { size: 64 }, shadow = texture(), query = {};
    memory.add(old); memory.add(old); memory.add(candidate); memory.add(shadow); memory.add(query);
    const peak = memory.snapshot;
    expect(peak).toEqual({ bufferBytes: 96, textureBytes: 256, estimatedBytes: 352,
      peakEstimatedBytes: 352, unknownResources: 1, resourceCount: 4 });
    memory.remove(candidate); memory.remove(candidate);
    expect(memory.snapshot.estimatedBytes).toBe(288);
    expect(peak.estimatedBytes).toBe(352);
    memory.remove(query); expect(memory.snapshot.unknownResources).toBe(0);
    memory.clear(); expect(memory.snapshot).toMatchObject({ estimatedBytes: 0, resourceCount: 0, peakEstimatedBytes: 352 });
  });
});
