import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderPreparedFrame, type PbrRendererFrameHost } from "./pbrRendererFrames.js";
import { resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";

vi.mock("./pbrFrameUniforms.js", () => ({ updatePbrFrameUniforms: () => ({
  history: { cameraCut: false, revision: 1 }, projection: { verticalFovRadians: 1, near: .1, far: 50 },
}) }));

const stopped = new Error("stop after production target allocation");
const view = { width: 64, height: 64, pixelRatio: 1, extent: 4,
  eye: [0, 1, 4], target: [0, 0, 0], background: [.02, .03, .04], floor: [0, 0, 0], exposure: 1, roughness: .5 } as const;

function fixture(gate?: () => boolean) {
  const beginFrame = vi.fn((_size: unknown, _resources: readonly unknown[]) => { throw stopped; });
  const capture = gate ? { begin: vi.fn(gate), cancel: vi.fn() } : undefined;
  const host = {
    now: () => 1, frame: 0, resolutionScale: 1, features: resolvePbrRendererFeatures({
      occlusionCulling: false, ambientOcclusion: false, temporalAa: false, spatialAa: false,
      bloom: false, fog: false, groundGrid: false, groundPlane: false, environment: false,
      contactShadows: false, vignette: false,
    }),
    session: { state: "ready", hasErrors: false, hdrCanvasActive: false,
      resize: () => ({ width: 64, height: 64 }), device: { queue: {} } },
    environment: { beginFrame: () => false }, environmentAmbient: [0, 0, 0],
    mainBindings: { update: () => false },
    packets: { failLodFrame: vi.fn(), cancelLodFrame: vi.fn(), cancelDeformationFrame: vi.fn(),
      publishResidentProjection: () => false, hasOutline: () => false,
      drawProfile: () => ({ hasTransparent: false, hasDeformation: false, hasMaterialTextures: false }) },
    cameraHistory: { cancelPendingFrame: vi.fn() },
    refreshAdaptiveShadowRequest: vi.fn(), shadowState: { publish: () => false },
    lighting: { hasProbeClipmap: false, invalidateAssignment: vi.fn() },
    pipelines: {}, frameBuffer: {}, frameData: new Float32Array(),
    ground: { instance: {}, data: new Float32Array() }, outputs: { buffer: {}, data: new Float32Array() },
    driveParticles: vi.fn(), driveProbeClipmap: vi.fn(),
    targets: { beginFrame, failFrame: vi.fn(), msaaActive: false },
    writeGeometryBuffers: false, frameCapture: capture,
    postProcess: { cancelFrame: vi.fn() }, transparency: { cancelFrame: vi.fn() },
    localShadows: { failFrame: vi.fn() },
  } as unknown as PbrRendererFrameHost;
  return { host, beginFrame, capture };
}

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, STORAGE_BINDING: 8 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, STORAGE: 2, COPY_DST: 4 });
});
afterEach(() => vi.unstubAllGlobals());

describe("production frame capture allocation gate", () => {
  it("uses the same cached production allocation resources when a retained capture session declines", () => {
    const ordinary = fixture(), declined = fixture(() => false);
    expect(() => renderPreparedFrame(ordinary.host, view)).toThrow(stopped);
    expect(() => renderPreparedFrame(declined.host, view)).toThrow(stopped);
    const ordinaryResources = ordinary.beginFrame.mock.calls[0]![1];
    const declinedResources = declined.beginFrame.mock.calls[0]![1];
    expect(ordinaryResources.length).toBeGreaterThan(0);
    expect(declinedResources).toEqual(ordinaryResources);
    expect(declinedResources).toBe(declined.host.allocationPlan!.resources);
    expect(declined.capture!.cancel).not.toHaveBeenCalled();
  });

  it("isolates accepted readback frames and restores normal resource aliasing after the gate closes", () => {
    let enabled = true;
    const f = fixture(() => enabled);
    expect(() => renderPreparedFrame(f.host, view)).toThrow(stopped);
    expect(f.beginFrame.mock.calls[0]![1]).toEqual([]);
    expect(f.capture!.cancel).toHaveBeenCalledOnce();
    enabled = false;
    expect(() => renderPreparedFrame(f.host, view)).toThrow(stopped);
    expect(f.beginFrame.mock.calls[1]![1]).toBe(f.host.allocationPlan!.resources);
    expect(f.beginFrame.mock.calls[1]![1].length).toBeGreaterThan(0);
    expect(f.capture!.cancel).toHaveBeenCalledOnce();
  });
});
