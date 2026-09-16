import { describe, expect, it, vi } from "vitest";
import { resolvePbrPostProcessOverrides, validatePbrPostProcessOverrides } from "./pbrPostProcessOverrides.js";
import type { DeviceSession } from "./deviceSession.js";
import { PbrPostProcessChain, type PbrPostProcessInput } from "./pbrPostProcessChain.js";
import { validatePbrRenderView } from "./pbrRenderViewValidation.js";
import type { RenderView } from "./pbrRendererTypes.js";

const effects = vi.hoisted(() => ({ ao: vi.fn(), composite: vi.fn(), bloom: vi.fn(), dispose: vi.fn() }));
vi.mock("../postprocess/ambientOcclusion.js", () => ({ AmbientOcclusionPass: class {
  encode = effects.ao; dispose = effects.dispose;
} }));
vi.mock("../postprocess/ambientOcclusionComposite.js", () => ({ AmbientOcclusionCompositePass: class {
  encode = effects.composite; dispose = effects.dispose;
} }));
vi.mock("../postprocess/bloom.js", () => ({ BloomPass: class {
  encode = effects.bloom; dispose = effects.dispose;
} }));

describe("per-frame PBR post-process switches", () => {
  it("inherits legacy defaults and supports independent disabling", () => {
    const allocated = { ambientOcclusion: true, bloom: true };
    expect(resolvePbrPostProcessOverrides(undefined, allocated)).toEqual(allocated);
    expect(resolvePbrPostProcessOverrides({ bloom: false }, allocated)).toEqual({ ambientOcclusion: true, bloom: false });
  });

  it.each([null, [], 1, "off", { bloom: 1 }, { ambientOcclusion: null }, { bloom: undefined }, { vignette: true }])(
    "rejects malformed overrides %j", value => {
      expect(() => validatePbrPostProcessOverrides(value as never)).toThrow();
    });

  it("validates overrides at the render-view boundary", () => {
    const view = { eye: [0, 1, 2], target: [0, 0, 0], background: [0, 0, 0], floor: [1, 1, 1],
      extent: 10, exposure: 1, roughness: 1, width: 100, height: 100, pixelRatio: 1 } as RenderView;
    expect(() => validatePbrRenderView({ ...view, postProcess: { bloom: false } })).not.toThrow();
    expect(() => validatePbrRenderView({ ...view, postProcess: { bloom: "false" } as never })).toThrow("boolean");
  });

  it.each(["ambientOcclusion", "bloom"] as const)("rejects unallocated %s before any encode", key => {
    effects.ao.mockClear(); effects.composite.mockClear(); effects.bloom.mockClear();
    const chain = new PbrPostProcessChain({} as DeviceSession, {
      ambientOcclusion: false, bloom: false, temporalAa: false, occlusionCulling: false });
    const input = { postProcess: { [key]: true } } as PbrPostProcessInput;
    expect(() => chain.encodeOpaque(input)).toThrow("not allocated");
    expect(() => chain.encodeFinal(input, {} as GPUTexture)).toThrow("not allocated");
    expect(effects.ao).not.toHaveBeenCalled();
    expect(effects.composite).not.toHaveBeenCalled();
    expect(effects.bloom).not.toHaveBeenCalled();
  });

  it("hot switches without encoding disabled effects or losing the original color", () => {
    const color = {} as GPUTexture, aoColor = {} as GPUTexture, bloomColor = {} as GPUTexture;
    effects.ao.mockReset().mockReturnValue({});
    effects.composite.mockReset().mockReturnValue({ texture: aoColor });
    effects.bloom.mockReset().mockReturnValue({ texture: bloomColor, passCount: 20 });
    const chain = new PbrPostProcessChain({} as DeviceSession, {
      ambientOcclusion: true, bloom: true, temporalAa: false, occlusionCulling: false });
    const input = { encoder: {}, targets: { hdrTexture: color }, revision: 1,
      extent: 10, verticalFovRadians: 1, cameraCut: true, currentJitter: [0, 0], previousJitter: [0, 0],
    } as PbrPostProcessInput;
    const disabled = { ...input, postProcess: { ambientOcclusion: false, bloom: false } };
    const off = () => {
      expect(chain.encodeOpaque(disabled)).toEqual({ color, passCount: 0 });
      expect(chain.encodeFinal(disabled, color)).toEqual({ color, passCount: 0 });
    };
    off();
    expect(effects.ao).not.toHaveBeenCalled(); expect(effects.bloom).not.toHaveBeenCalled();
    expect(chain.encodeOpaque(input)).toEqual({ color: aoColor, passCount: 4 });
    expect(chain.encodeFinal(input, aoColor)).toEqual({ color: bloomColor, passCount: 20 });
    off();
    expect(effects.ao).toHaveBeenCalledTimes(1); expect(effects.composite).toHaveBeenCalledTimes(1);
    expect(effects.bloom).toHaveBeenCalledTimes(1);
    expect(chain.encodeFinal({ ...input, revision: 3, postProcess: { bloom: true } }, color).color).toBe(bloomColor);
    expect(effects.bloom).toHaveBeenCalledTimes(2);
    chain.dispose();
  });
});
