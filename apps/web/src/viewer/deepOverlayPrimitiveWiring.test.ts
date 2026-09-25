import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import type { RenderView } from "@bim-studio/deep-engine/webgpu";
import { StudioDeepRenderView } from "./StudioDeepRenderView";
import { DEFAULT_POST_PROCESSING } from "../appDefaults";
import { projectDeepSelectionBox } from "./deepOverlayPrimitives";
import { collectDeepOverlayPrimitives, type DeepOverlayPrimitiveViewer } from "./deepOverlayPrimitiveSource";

vi.mock("./studioDeepEnvironmentLights", () => ({
  projectStudioDeepLights: () => ({ lights: { directional: [], points: [], spots: [] }, issues: [] }),
}));

// 接线回归:桥注册 DeepOverlayPrimitiveSource 后,Deep 渲染帧的 editorOverlay
// 顶点 = Three 投影 + Deep 原语(选择盒/测量/gizmo);未注册时保持纯投影行为。
describe("StudioDeepRenderView deep overlay primitive wiring", () => {
  const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));

  function makeView(selectionBox: THREE.Box3 | undefined) {
    const camera = new THREE.PerspectiveCamera();
    camera.position.z = 5;
    camera.updateMatrixWorld(true);
    const authorCanvas = { style: { position: "", inset: "", width: "", height: "", opacity: "1", zIndex: "", pointerEvents: "" },
      dataset: {}, clientWidth: 640, clientHeight: 480, setAttribute: vi.fn(), remove: vi.fn() } as unknown as HTMLCanvasElement;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x112233);
    const viewer = {
      scene, camera, orbit: { target: new THREE.Vector3() },
      renderer: { domElement: authorCanvas, getPixelRatio: () => 1, toneMappingExposure: 1, shadowMap: { enabled: false, type: THREE.PCFShadowMap } },
      usesAuthorPostProcessing: () => true,
      getPostProcessing: () => ({ ...DEFAULT_POST_PROCESSING, enabled: false }),
      getDeepProjectionRoot: () => new THREE.Scene(),
      getDeepEditorOverlayRoots: () => [],
      getDeepGrid: () => undefined,
      getDeepSelectionBox: () => selectionBox,
      getDeepTransformGizmoInput: () => undefined,
      getDeepMeasurementSegmentInputs: () => [],
    } as unknown as ConstructorParameters<typeof StudioDeepRenderView>[0] & DeepOverlayPrimitiveViewer;
    const view = new StudioDeepRenderView(viewer, { clientWidth: 640, clientHeight: 480 } as HTMLElement,
      () => undefined, () => undefined);
    return { view, viewer, camera, canvas: authorCanvas };
  }

  it("merges registered primitive vertices into the editor overlay snapshot", () => {
    const made = makeView(box);
    made.view.setDeepOverlayPrimitiveSource((width, height, pixelRatio) =>
      collectDeepOverlayPrimitives(made.viewer as unknown as DeepOverlayPrimitiveViewer, width, height, pixelRatio));
    const rendered = made.view.renderViewDirect(made.canvas) as RenderView;
    const expected = projectDeepSelectionBox(box, made.camera, 640, 480, 1);
    expect(expected.length).toBeGreaterThan(0);
    expect(rendered.editorOverlay!.vertices.length).toBe(expected.length);
    expect(rendered.editorOverlay!.vertices[0]).toBeCloseTo(expected[0]!, 6);
    expect(rendered.editorOverlay!.vertices[20]).toBeCloseTo(expected[20]!, 6);
  });

  it("keeps pure author projection when no primitive source is registered", () => {
    const made = makeView(box);
    const rendered = made.view.renderViewDirect(made.canvas) as RenderView;
    expect(rendered.editorOverlay!.vertices).toHaveLength(0);
  });
});
