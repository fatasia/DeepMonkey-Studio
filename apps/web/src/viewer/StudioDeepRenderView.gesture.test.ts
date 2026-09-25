import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderView } from "@bim-studio/deep-engine/webgpu";
import { StudioDeepRenderView } from "./StudioDeepRenderView";
import { DEFAULT_POST_PROCESSING } from "../appDefaults";

const projectLights = vi.hoisted(() => vi.fn(() => ({ lights: { directional: [], points: [], spots: [] }, issues: [] })));

vi.mock("./studioDeepEnvironmentLights", () => ({
  projectStudioDeepLights: () => projectLights(),
}));

// 相机手势缓存合同:手势期场景派生字段(灯光遍历)200ms 内复用,全量路径每次重建,
// invalidateProjectionBounds/reset 立即失效——正确性由桥的尾随全量 sync 保证。
describe("StudioDeepRenderView camera-gesture cache", () => {
  let view: StudioDeepRenderView, scene: THREE.Scene, canvas: HTMLCanvasElement;
  beforeEach(() => {
    vi.useFakeTimers();
    projectLights.mockClear();
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x112233);
    scene.add(new THREE.DirectionalLight(0xffffff, 1));
    const camera = new THREE.PerspectiveCamera();
    const authorCanvas = { style: { position: "", inset: "", width: "", height: "", opacity: "1", zIndex: "", pointerEvents: "" },
      dataset: {}, clientWidth: 640, clientHeight: 480, setAttribute: vi.fn(), remove: vi.fn() } as unknown as HTMLCanvasElement;
    canvas = authorCanvas;
    const viewer = {
      scene, camera, orbit: { target: new THREE.Vector3() },
      renderer: { domElement: authorCanvas, getPixelRatio: () => 1, toneMappingExposure: 1, shadowMap: { enabled: false, type: THREE.PCFShadowMap } },
      usesAuthorPostProcessing: () => true,
      getPostProcessing: () => ({ ...DEFAULT_POST_PROCESSING, enabled: false }),
      getDeepProjectionRoot: () => scene,
      getDeepEditorOverlayRoots: () => [],
      getDeepGrid: () => undefined,
    } as unknown as ConstructorParameters<typeof StudioDeepRenderView>[0];
    view = new StudioDeepRenderView(viewer, { clientWidth: 640, clientHeight: 480 } as HTMLElement,
      () => undefined, () => undefined);
  });
  afterEach(() => { vi.useRealTimers(); });

  function firstLightCallCount() { return projectLights.mock.calls.length; }

  it("reuses the scene-derived source across camera-gesture frames within the TTL", () => {
    view.renderViewDirect(canvas, true);
    view.renderViewDirect(canvas, true);
    vi.advanceTimersByTime(150);
    view.renderViewDirect(canvas, true);
    expect(firstLightCallCount()).toBe(1);
    // 相机派生字段仍是实时读取:改变相机位置后 eye 立即更新。
    const eye = [6, 0, 0];
    expect([view.renderViewDirect(canvas, true).eye]).not.toEqual([eye]);
  });

  it("rebuilds the source after the gesture TTL expires", () => {
    view.renderViewDirect(canvas, true);
    vi.advanceTimersByTime(201);
    view.renderViewDirect(canvas, true);
    expect(firstLightCallCount()).toBe(2);
  });

  it("keeps full reads on the non-gesture path and invalidates on demand", () => {
    view.renderViewDirect(canvas);
    view.renderViewDirect(canvas);
    expect(firstLightCallCount()).toBe(2);
    view.renderViewDirect(canvas, true);
    view.invalidateProjectionBounds();
    view.renderViewDirect(canvas, true);
    expect(firstLightCallCount()).toBe(4);
    view.reset();
    view.renderViewDirect(canvas, true);
    expect(firstLightCallCount()).toBe(5);
    expect((view.renderViewDirect(canvas, true) as RenderView).lights).toEqual({ directional: [], points: [], spots: [] });
  });

  it("refreshes the gesture cache from full reads so scene edits surface on the next gesture frame", () => {
    view.renderViewDirect(canvas, true);
    expect(firstLightCallCount()).toBe(1);
    // 手势期之外的完整构建(sync 尾随路径)刷新缓存:拖拽中的编辑在下一次手势帧立即生效,
    // 因此第二次手势调用复用刚刷新的缓存而不是再遍历一次。
    view.renderViewDirect(canvas);
    expect(firstLightCallCount()).toBe(2);
    const refreshed = view.renderViewDirect(canvas, true);
    expect(firstLightCallCount()).toBe(2);
    expect(refreshed.lights).toEqual({ directional: [], points: [], spots: [] });
  });
});
