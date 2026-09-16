import { describe, expect, it, vi } from "vitest";
import { bridge, mesh } from "./testFixture.js";
import { DeepWebGpuBackend, type DeepWebGpuRenderRuntime, type DeepWebGpuRuntimeFactory } from "./DeepWebGpuBackend.js";
import type { FrameMetrics, PbrRendererOptions, RenderView } from "../webgpu/pbrRenderer.js";

const view: RenderView = { width: 10, height: 10, pixelRatio: 1, eye: [0, 0, 4], target: [0, 0, 0],
  extent: 2, background: [0, 0, 0], floor: [0, 0, 0], exposure: 1, roughness: 1 };
const correct = { shadowTier: "exact", shadowMapSize: 1024, shadowCascadeCount: 1, shadowDepthBytes: 4 * 1024 * 1024 };
function fixture(evidence: object = correct) {
  const runtime = { id: "deep-webgpu", setPacketValidated: vi.fn(async () => {}), updateInstances: vi.fn(),
    render: vi.fn(), validateFrame: vi.fn(async () => evidence as FrameMetrics), dispose: vi.fn() } as DeepWebGpuRenderRuntime;
  const create = vi.fn(async (_canvas: unknown, _gpu: unknown, _signal: AbortSignal, _options?: PbrRendererOptions) => runtime);
  const prepare = (shadows: PbrRendererOptions["shadows"] = { exactProfile: { cascadeCount: 1, shadowMapSize: 1024 } }) =>
    DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined, projection: bridge(), root: mesh(), view,
      renderer: { ...(shadows === undefined ? {} : { shadows }) } }, { create } as DeepWebGpuRuntimeFactory);
  return { runtime, create, prepare };
}

describe("Deep bridge exact shadow allocation evidence", () => {
  it("freezes the requested exact profile and verifies allocated size, layers and bytes", async () => {
    const f = fixture(), exactProfile = { cascadeCount: 1, shadowMapSize: 1024 };
    const pending = f.prepare({ exactProfile }); exactProfile.shadowMapSize = 4096;
    const backend = await pending;
    const options = f.create.mock.calls[0]![3]!;
    expect(options.shadows?.exactProfile?.shadowMapSize).toBe(1024);
    expect(Object.isFrozen(options.shadows?.exactProfile)).toBe(true);
    expect(backend.shadowSelection).toEqual({ selectedTier: "exact", cascadeCount: 1,
      shadowMapSize: 1024, estimatedDepthTextureBytes: 4 * 1024 * 1024 });
    backend.dispose();
  });
  it.each([
    { ...correct, shadowTier: "high" },
    { ...correct, shadowMapSize: undefined },
    { ...correct, shadowCascadeCount: undefined },
    { ...correct, shadowDepthBytes: 0 },
    { ...correct, shadowMapSize: 512, shadowCascadeCount: 4 },
  ])("rejects mismatched runtime evidence and disposes the candidate: %j", async evidence => {
    const f = fixture(evidence);
    await expect(f.prepare()).rejects.toThrow("does not match");
    expect(f.runtime.dispose).toHaveBeenCalledOnce();
  });
  it("does not trust a runtime claiming exact allocation without an exact request", async () => {
    const f = fixture();
    await expect(f.prepare({ requestedTier: "high" })).rejects.toThrow("unknown shadow tier");
    expect(f.runtime.dispose).toHaveBeenCalledOnce();
  });
  it.each([
    { exactProfile: { cascadeCount: 0, shadowMapSize: 1024 } },
    { exactProfile: { cascadeCount: 1, shadowMapSize: 63 } },
    { exactProfile: { cascadeCount: 1, shadowMapSize: 1024, depthBias: NaN } },
    { exactProfile: { cascadeCount: 1, shadowMapSize: 1024, blendRatio: null } },
    { exactProfile: { cascadeCount: 1, shadowMapSize: 1024, unexpected: 1 } },
    { requestedTier: "high", exactProfile: { cascadeCount: 1, shadowMapSize: 1024 } },
    { maxDepthTextureBytes: 1024, exactProfile: { cascadeCount: 1, shadowMapSize: 1024 } },
  ])("rejects invalid exact requests before any GPU resources: %j", async options => {
    const f = fixture();
    await expect(f.prepare(options as unknown as NonNullable<PbrRendererOptions["shadows"]>)).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled();
  });
});
