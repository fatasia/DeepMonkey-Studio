import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { PbrPostProcessChain, type PbrPostProcessInput } from "./pbrPostProcessChain.js";

const mocks = vi.hoisted(() => ({ march: vi.fn(), composite: vi.fn(), disposeMarch: vi.fn(), disposeComposite: vi.fn() }));
vi.mock("../fog/volumetricFogPass.js", () => ({ VolumetricFogPass: class {
  encode = mocks.march; dispose = mocks.disposeMarch;
} }));
vi.mock("../fog/volumetricFogComposite.js", () => ({ VolumetricFogCompositePass: class {
  encode = mocks.composite; dispose = mocks.disposeComposite;
} }));

describe("G7 production post-process integration", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.march.mockReturnValue({ texture: {}, passCount: 1, revision: 9 });
    mocks.composite.mockReturnValue({ texture: { label: "fog-hdr" }, passCount: 1 });
  });

  it("marches real linear depth and composites before later post effects", () => {
    const chain = new PbrPostProcessChain({} as DeviceSession, { volumetricFog: true,
      ambientOcclusion: false, screenSpaceReflection: false, temporalAa: false, occlusionCulling: false, bloom: false });
    const color = { label: "source" } as unknown as GPUTexture;
    const depth = { label: "linear-depth" } as unknown as GPUTexture;
    const input = { encoder: {}, targets: { linearDepthTexture: depth }, revision: 9, extent: 50,
      verticalFovRadians: 1, cameraCut: false, currentJitter: [0, 0], previousJitter: [0, 0],
      postProcess: { volumetricFog: true, volumetricFogProfile: {
        medium: { baseExtinction: 0.01, scaleHeight: 30, anisotropy: 0.2, albedo: 0.9 },
        light: { direction: [0, -1, 0], radiance: [2, 2, 2] }, steps: 64,
      } },
    } as PbrPostProcessInput;
    expect(chain.encodeFinal(input, color)).toEqual({ color: { label: "fog-hdr" }, passCount: 2 });
    expect(mocks.march).toHaveBeenCalledWith(input.encoder, {
      depth, revision: 9, depthEncoding: "linear-view-depth-positive",
    }, expect.objectContaining({ verticalFovRadians: 1, steps: 64, maxDistance: 200 }));
    expect(mocks.composite).toHaveBeenCalledWith(input.encoder,
      expect.objectContaining({ color, revision: 9, colorEncoding: "linear-hdr" }));
    chain.dispose(); expect(mocks.disposeMarch).toHaveBeenCalledOnce(); expect(mocks.disposeComposite).toHaveBeenCalledOnce();
  });

  it("keeps the effect off by default and rejects an unallocated hot enable", () => {
    const chain = new PbrPostProcessChain({} as DeviceSession, { volumetricFog: false,
      ambientOcclusion: false, temporalAa: false, occlusionCulling: false, bloom: false });
    const input = { postProcess: { volumetricFog: true } } as PbrPostProcessInput;
    expect(() => chain.encodeFinal(input, {} as GPUTexture)).toThrow("not allocated");
    expect(mocks.march).not.toHaveBeenCalled(); chain.dispose();
  });
});
