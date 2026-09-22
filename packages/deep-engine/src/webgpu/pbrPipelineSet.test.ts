import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPbrPipelineSetCache, createPbrPipelineSet } from "./pbrPipelineSet.js";
import { createPipelines } from "./pipelines.js";
import { resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";
import type { DeviceSession } from "./deviceSession.js";

vi.mock("./pipelines.js", () => ({ createPipelines: vi.fn(async () => ({})) }));

describe("production PBR deformation pipeline selection", () => {
  const session = { device: {}, format: "bgra8unorm" } as DeviceSession;
  const lighting = {} as GPUBindGroupLayout;
  const features = resolvePbrRendererFeatures({ ambientOcclusion: false, temporalAa: false, occlusionCulling: false });
  afterEach(() => { clearPbrPipelineSetCache(session.device); vi.clearAllMocks(); });

  it.each(["screenSpaceReflection"] as const)("allocates geometry outputs for %s alone", async feature => {
    await createPbrPipelineSet(session, lighting, {}, { ...features, [feature]: true });
    expect(createPipelines).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createPipelines).mock.calls[0]![3]).toBe(true);
  });

  it("keeps Hi-Z on hardware depth without allocating unused MRT outputs", async () => {
    await createPbrPipelineSet(session, lighting, {}, { ...features, occlusionCulling: true });
    expect(vi.mocked(createPipelines).mock.calls[0]![3]).toBe(false);
  });

  it("keeps the static-only default allocation", async () => {
    const result = await createPbrPipelineSet(session, lighting, {}, features);
    expect(createPipelines).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createPipelines).mock.calls[0]![3]).toBe(false);
    expect(result.deformationPipelines).toBeUndefined();
  });

  it("selects paired static and deformation array variants and isolates their cache entry", async () => {
    const arrayFeatures = { ...features, textureArrays: true };
    await createPbrPipelineSet(session, lighting, { deformation: true }, arrayFeatures);
    const [fallback, array, poseFallback, poseArray] = vi.mocked(createPipelines).mock.calls;
    expect(fallback![6]).toBeUndefined();
    expect(array![6]).toEqual({ textureArrays: true });
    expect(poseFallback![6]).toEqual({ deformation: true });
    expect(poseArray![6]).toEqual({ deformation: true, textureArrays: true });
    await createPbrPipelineSet(session, lighting, {}, features);
    expect(createPipelines).toHaveBeenCalledTimes(5);
  });

  it.each([1, 2] as const)("keeps static and pose attachment layouts aligned for %i shadow cascades", async cascadeCount => {
    await createPbrPipelineSet(session, lighting, { deformation: true,
      shadows: { exactProfile: { cascadeCount, shadowMapSize: 128 } } }, features);
    expect(createPipelines).toHaveBeenCalledTimes(2);
    const [base, pose] = vi.mocked(createPipelines).mock.calls;
    expect(base![3]).toBe(true); expect(pose![3]).toBe(true);
    expect(pose![4]).toBe(false);
    expect(base![5]).toBe(cascadeCount === 1); expect(pose![5]).toBe(cascadeCount === 1);
    expect(pose![6]).toEqual({ deformation: true });
  });

  it("rejects non-boolean capability values before pipeline allocation", async () => {
    await expect(createPbrPipelineSet(session, lighting, { deformation: "true" as never }, features)).rejects.toThrow("boolean");
    expect(createPipelines).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent and warm pipeline-set compilation for the exact device ABI", async () => {
    const [first, concurrent] = await Promise.all([
      createPbrPipelineSet(session, lighting, {}, features),
      createPbrPipelineSet(session, lighting, {}, features),
    ]);
    expect(concurrent).toBe(first);
    expect(createPipelines).toHaveBeenCalledOnce();
    expect(await createPbrPipelineSet(session, lighting, {}, features)).toBe(first);
    expect(createPipelines).toHaveBeenCalledOnce();
    await createPbrPipelineSet(session, lighting, {}, { ...features, screenSpaceReflection: true });
    expect(createPipelines).toHaveBeenCalledTimes(2);
  });

  it("evicts rejected candidates so device compilation can recover", async () => {
    vi.mocked(createPipelines).mockRejectedValueOnce(new Error("driver compilation failed"));
    await expect(createPbrPipelineSet(session, lighting, {}, features)).rejects.toThrow("driver compilation failed");
    await expect(createPbrPipelineSet(session, lighting, {}, features)).resolves.toBeDefined();
    expect(createPipelines).toHaveBeenCalledTimes(2);
  });
});
