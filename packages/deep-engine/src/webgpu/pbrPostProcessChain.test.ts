import { describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { PbrPostProcessChain } from "./pbrPostProcessChain.js";
import { TemporalValidityProvider } from "../postprocess/temporalValidity.js";
import { DEFAULT_PBR_RENDERER_FEATURES } from "./pbrRendererFeatures.js";

describe("PBR post-process construction", () => {
  it("does not compile capabilities disabled by the author frame", () => {
    const session = new Proxy({}, { get: () => { throw new Error("unused capability touched GPU"); } }) as DeviceSession;
    const chain = new PbrPostProcessChain(session, { ambientOcclusion: true, screenSpaceReflection: true,
      volumetricFog: true, bloom: true, temporalAa: false, occlusionCulling: false });
    const color = {} as GPUTexture;
    expect(chain.encodeOpaque({ targets: { hdrTexture: color }, postProcess: { ambientOcclusion: false } } as never).color).toBe(color);
    expect(chain.encodeFinal({ authorDirectDisplay: true } as never, color).color).toBe(color);
    expect(() => chain.dispose()).not.toThrow();
  });
  it("bypasses allocated effects for direct display and starts fresh TAA when Composer returns", () => {
    const color = { width: 32, height: 16 } as GPUTexture, reset = vi.fn();
    const temporal = { reset, encode: vi.fn(() => ({ texture: color })) };
    const chain = Object.assign(Object.create(PbrPostProcessChain.prototype), {
      disposed: false, features: DEFAULT_PBR_RENDERER_FEATURES, temporalAa: temporal,
      temporalUpscale: { reset }, temporalValidity: new TemporalValidityProvider(),
    }) as PbrPostProcessChain;
    expect(chain.encodeFinal({ authorDirectDisplay: true } as never, color)).toEqual({ color, passCount: 0 });
    expect(temporal.encode).not.toHaveBeenCalled(); expect(reset).toHaveBeenCalledTimes(2);
    expect(chain.temporalPlan()).toBeUndefined();
    const input = { encoder: {}, targets: {}, revision: 1, extent: 5, verticalFovRadians: 1,
      cameraCut: false, currentJitter: [0, 0], previousJitter: [0, 0],
      postProcess: { ambientOcclusion: false, screenSpaceReflection: false, volumetricFog: false, bloom: false } };
    expect(chain.encodeFinal(input as never, color).passCount).toBe(1);
    expect(temporal.encode).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ cameraCut: true }), expect.anything());
  });
  it("does not touch the GPU when every allocative effect is disabled", () => {
    const session = new Proxy({}, {
      get: (_target, property) => {
        throw new Error(`Disabled post-process accessed session.${String(property)}.`);
      },
    }) as DeviceSession;
    const chain = new PbrPostProcessChain(session, {
      ambientOcclusion: false,
      temporalAa: false,
      occlusionCulling: false,
      bloom: false,
    });
    expect(() => chain.dispose()).not.toThrow();
  });
  it("constructs with the debug full-render comparison switch enabled without touching the GPU", () => {
    const session = new Proxy({}, {
      get: (_target, property) => {
        throw new Error(`Disabled post-process accessed session.${String(property)}.`);
      },
    }) as DeviceSession;
    const chain = new PbrPostProcessChain(session, {
      ambientOcclusion: false,
      temporalAa: false,
      occlusionCulling: false,
      bloom: false,
      debugForceFullRender: true,
    });
    expect(() => chain.dispose()).not.toThrow();
  });
});
