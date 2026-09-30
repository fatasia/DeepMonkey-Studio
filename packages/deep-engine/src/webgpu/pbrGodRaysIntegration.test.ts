import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { PbrPostProcessChain, type PbrPostProcessInput } from "./pbrPostProcessChain.js";
import { DEFAULT_PBR_VOLUMETRIC_FOG_PROFILE, resolvePbrPostProcessOverrides, validatePbrPostProcessOverrides } from "./pbrPostProcessOverrides.js";
import { buildPbrFrameExecutionPlan, collectActualPbrFramePasses, assertPlanMatchesActual } from "./pbrFramePlanExecutor.js";
import { resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";
import { pbrGodRaysFrame } from "./pbrGodRaysFrame.js";
import { resolvePbrSceneLighting } from "../lighting/pbrSceneLighting.js";
import type { GodRaysShadowSource } from "../fog/volumetricGodRaysPassTypes.js";

const mock = vi.hoisted(() => ({ god: vi.fn(), fog: vi.fn(), composite: vi.fn(), construct: vi.fn(), dispose: vi.fn() }));
vi.mock("../fog/volumetricGodRaysPass.js", () => ({ VolumetricGodRaysPass: class {
  constructor() { mock.construct(); } encode = mock.god; dispose = mock.dispose;
} }));
vi.mock("../fog/volumetricFogPass.js", () => ({ VolumetricFogPass: class { encode = mock.fog; dispose() {} } }));
vi.mock("../fog/volumetricFogComposite.js", () => ({ VolumetricFogCompositePass: class { encode = mock.composite; dispose() {} } }));
const features = resolvePbrRendererFeatures({ volumetricFog: true, ambientOcclusion: false,
  screenSpaceReflection: false, temporalAa: false, occlusionCulling: false, bloom: false });
const shadows = { uniform: {}, view: {}, sampler: {}, enabled: false } as GodRaysShadowSource;
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function input(strength?: number): PbrPostProcessInput {
  return { encoder: {}, targets: { linearDepthTexture: {} }, revision: 1, extent: 9999, verticalFovRadians: 1,
    cameraCut: false, currentJitter: [0, 0], previousJitter: [0, 0],
    godRays: { shadows, viewToWorld: identity, light: { direction: [0, -1, 0], radiance: [8, 4, 2] } },
    postProcess: { volumetricFog: true, volumetricFogProfile: { ...DEFAULT_PBR_VOLUMETRIC_FOG_PROFILE,
      ...(strength === undefined ? {} : { godRaysStrength: strength }) } } } as PbrPostProcessInput;
}
describe("I-C18 production god rays", () => {
  beforeEach(() => {
    Object.values(mock).forEach(fn => fn.mockReset());
    mock.god.mockReturnValue({ texture: { label: "shadowed" } }); mock.fog.mockReturnValue({ texture: { label: "fog" } });
    mock.composite.mockReturnValue({ texture: { label: "composite" } });
  });
  it("allocates lazily, replaces one fog march, preserves zero and borrows actual frame source", () => {
    const chain = new PbrPostProcessChain({} as DeviceSession, features);
    chain.encodeFinal(input(), {} as GPUTexture); expect(mock.construct).not.toHaveBeenCalled();
    const frame = input(0); chain.encodeFinal(frame, {} as GPUTexture);
    expect(mock.god).toHaveBeenCalledWith(frame.encoder, expect.objectContaining({ depth: frame.targets.linearDepthTexture }),
      shadows, expect.objectContaining({ strength: 0, maxDistance: 1000, viewToWorld: identity, light: frame.godRays!.light }));
    chain.encodeFinal(input(2), {} as GPUTexture); expect(mock.construct).toHaveBeenCalledOnce();
    chain.encodeFinal(input(), {} as GPUTexture); expect(mock.fog).toHaveBeenCalledTimes(2);
    expect(mock.composite).toHaveBeenCalledTimes(4); chain.dispose(); chain.dispose(); expect(mock.dispose).toHaveBeenCalledOnce();
  });
  it("rejects missing frame source before allocating a god pass", () => {
    const chain = new PbrPostProcessChain({} as DeviceSession, features);
    const { godRays: _, ...frame } = input(1);
    expect(() => chain.encodeFinal(frame, {} as GPUTexture)).toThrow("prepared CSM");
    expect(mock.construct).not.toHaveBeenCalled(); expect(mock.god).not.toHaveBeenCalled(); chain.dispose();
  });
  it("snapshots zero and rejects invalid strengths before encoding", () => {
    const frame = input(0), active = resolvePbrPostProcessOverrides(frame.postProcess, features);
    expect(active.volumetricFogProfile.godRaysStrength).toBe(0); expect(Object.isFrozen(active.volumetricFogProfile)).toBe(true);
    for (const value of [-0.1, 8.01, Infinity, NaN]) expect(() => validatePbrPostProcessOverrides({
      volumetricFogProfile: { ...DEFAULT_PBR_VOLUMETRIC_FOG_PROFILE, godRaysStrength: value } })).toThrow("strength");
  });
  it.each([false, true])("declares the actual shadow read and executor only when enabled=%s", godRays => {
    const plan = buildPbrFrameExecutionPlan({ width: 1920, height: 1080 }, { transparency: false, features, godRays });
    const actual = collectActualPbrFramePasses(features, false, { godRays });
    expect(assertPlanMatchesActual(plan, actual).mismatches).toEqual([]);
    const march = plan.passes.find(pass => pass.passId === "volumetric-fog-march")!;
    expect(march.reads).toEqual(godRays ? ["linear-depth", "shadow-atlas"] : ["linear-depth"]);
    expect(march.mapping).toEqual({ status: "mapped", executor: godRays ? "VolumetricGodRaysPass.encode" : "VolumetricFogPass.encode" });
  });
  it("uses rigid view rotation and primary radiance, then inverts the exact translated view", () => {
    const view = new Float32Array([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, -5, -2, -3, 1]);
    const primary = resolvePbrSceneLighting({ directional: [{ directionWorld: [1, 0, 0], color: [2, 1, 0.5], intensity: 3 }] }).primary;
    const frame = pbrGodRaysFrame(primary, view);
    expect(frame.light.direction).toEqual([0, 0, -1]); expect(frame.light.radiance).toEqual([6, 3, 1.5]);
    expect(Array.from(frame.viewToWorld.slice(12, 15))).toEqual([-3, 2, 5]);
    const disabled = resolvePbrSceneLighting({ directional: [] }).primary;
    expect(pbrGodRaysFrame(disabled, identity).light.radiance).toEqual([0, 0, 0]);
  });
});
