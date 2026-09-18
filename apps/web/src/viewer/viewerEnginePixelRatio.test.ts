import { afterEach, describe, expect, it, vi } from "vitest";
import { AdaptiveRenderScaleController } from "./adaptiveRenderScale";

vi.mock("./viewerEngineTimelineRuntime", () => ({ ViewerEngineTimelineRuntime: class {} }));
import { ViewerEngineRuntimeSupport } from "./viewerEngineRuntimeSupport";

afterEach(() => vi.unstubAllGlobals());

function fixture(backend = "webgl", shadowsEnabled = false) {
  let ratio = 1;
  const state = {
    container: { clientWidth: 800, clientHeight: 600 },
    lastViewportWidth: 800, lastViewportHeight: 600,
    camera: { aspect: 4 / 3, updateProjectionMatrix: vi.fn() },
    adaptiveRenderScaleController: new AdaptiveRenderScaleController(1),
    resetPerformanceSamples: vi.fn(),
    rendererBackend: backend, drawingBufferInitialized: true,
    lightingState: { enabled: true, shadowsEnabled },
    renderer: { getPixelRatio: () => ratio, setPixelRatio: vi.fn((value: number) => { ratio = value; }), setSize: vi.fn() },
    postProcessing: { setPixelRatio: vi.fn(), setSize: vi.fn() },
  };
  const resize = () => (ViewerEngineRuntimeSupport.prototype as unknown as { resize(): void }).resize.call(state);
  return { state, resize };
}

describe("viewer DPR resize", () => {
  it("refreshes the renderer and post processing at unchanged CSS dimensions", () => {
    vi.stubGlobal("window", { devicePixelRatio: 2 });
    const { state, resize } = fixture();
    resize();
    expect(state.renderer.setPixelRatio).toHaveBeenCalledWith(2);
    expect(state.postProcessing.setPixelRatio).toHaveBeenCalledWith(2);
    expect(state.renderer.setSize).toHaveBeenCalledWith(800, 600, false);
    expect(state.postProcessing.setSize).toHaveBeenCalledWith(800, 600);
    expect(state.resetPerformanceSamples).toHaveBeenCalledTimes(1);
    resize();
    expect(state.renderer.setSize).toHaveBeenCalledTimes(1);
  });

  it("retains the WebGPU shadow buffer freeze and applies the pending DPR when unfrozen", () => {
    vi.stubGlobal("window", { devicePixelRatio: 3 });
    const { state, resize } = fixture("webgpu", true);
    resize();
    expect(state.renderer.setPixelRatio).not.toHaveBeenCalled();
    expect(state.renderer.setSize).not.toHaveBeenCalled();
    state.lightingState.shadowsEnabled = false;
    resize();
    expect(state.renderer.setPixelRatio).toHaveBeenCalledWith(2);
    expect(state.renderer.setSize).toHaveBeenCalledTimes(1);
  });
});
