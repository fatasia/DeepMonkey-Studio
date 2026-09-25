import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ViewerEngineInteraction } from "./viewerEngineInteraction";

describe("Deep editor overlay roots", () => {
  it("projects transient BIM visuals while excluding the model root", () => {
    const modelRoot = new THREE.Group();
    const scene = new THREE.Scene();
    scene.add(modelRoot);
    const measurement = new THREE.Group(); measurement.name = "measurement:m1";
    const annotation = new THREE.Group(); annotation.name = "annotation:a1";
    const space = new THREE.Group(); space.name = "helper:space:s1";
    const placement = new THREE.Group(); placement.name = "helper:bim-placement-preview";
    const unrelated = new THREE.Group(); unrelated.name = "unrelated";
    scene.add(measurement, annotation, space, placement, unrelated);
    const transform = new THREE.Group();
    const roots = ViewerEngineInteraction.prototype.getDeepEditorOverlayRoots.call({
      scene, transform: { getHelper: () => transform }, selectionHelper: undefined,
      clippingHelper: undefined, measurementPreview: undefined, sceneLightProxies: new Map()
    } as unknown as ViewerEngineInteraction);
    expect(roots).toEqual(expect.arrayContaining([transform, measurement, annotation, space, placement]));
    expect(roots).not.toContain(modelRoot);
    expect(roots).not.toContain(unrelated);
    expect(new Set(roots).size).toBe(roots.length);
    vi.restoreAllMocks();
  });

  it("excludes helpers that Deep native primitives render when the presentation backend is webgpu", () => {
    const scene = new THREE.Scene();
    const transform = new THREE.Group();
    const selectionHelper = new THREE.Group();
    const clippingHelper = new THREE.Group();
    const measurementPreview = new THREE.Group(); measurementPreview.name = "helper:measurement-preview";
    measurementPreview.userData.measurement = { kind: "distance" };
    const distance = new THREE.Group(); distance.name = "measurement:m1";
    distance.userData.measurement = { kind: "distance" };
    const angle = new THREE.Group(); angle.name = "measurement:m2";
    angle.userData.measurement = { kind: "angle" };
    const annotation = new THREE.Group(); annotation.name = "annotation:a1";
    scene.add(distance, angle, annotation);
    const roots = ViewerEngineInteraction.prototype.getDeepEditorOverlayRoots.call({
      scene, transform: { getHelper: () => transform }, selectionHelper, clippingHelper, measurementPreview,
      sceneLightProxies: new Map(), presentationRendererBackend: "webgpu"
    } as unknown as ViewerEngineInteraction);
    // 原生原语接管:选择盒 / gizmo / 两点测量(含预览)不再走 CPU 投影。
    expect(roots).not.toContain(transform);
    expect(roots).not.toContain(selectionHelper);
    expect(roots).not.toContain(measurementPreview);
    expect(roots).not.toContain(distance);
    // angle 测量与预览的圆弧现由 Deep 原生原语呈现。
    expect(roots).not.toContain(angle);
    expect(roots).not.toContain(clippingHelper);
    expect(roots).toContain(annotation);
  });

  it("keeps an untyped measurement preview projected when it is not natively drawable", () => {
    const scene = new THREE.Scene();
    const transform = new THREE.Group();
    const measurementPreview = new THREE.Group(); measurementPreview.name = "helper:measurement-preview";
    // 无状态(未挂 userData)的预览不得凭空消失。
    for (const kind of [undefined]) {
      measurementPreview.userData.measurement = kind === undefined ? undefined : { kind };
      const roots = ViewerEngineInteraction.prototype.getDeepEditorOverlayRoots.call({
        scene, transform: { getHelper: () => transform }, selectionHelper: undefined,
        clippingHelper: undefined, measurementPreview, sceneLightProxies: new Map(),
        presentationRendererBackend: "webgpu"
      } as unknown as ViewerEngineInteraction);
      expect(roots).toContain(measurementPreview);
    }
  });

  it("exposes only an enabled box clipping helper to the Deep primitive collector", () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const clippingHelper = { box };
    const call = (clippingState: Record<string, unknown>) => ViewerEngineInteraction.prototype.getDeepClippingBox.call({
      clippingState, clippingHelper, presentationRendererBackend: "webgpu"
    } as unknown as ViewerEngineInteraction);
    expect(call({ enabled: true, mode: "box", showHelper: true })).toBe(box);
    expect(call({ enabled: false, mode: "box", showHelper: true })).toBeUndefined();
    expect(call({ enabled: true, mode: "plane", showHelper: true })).toBeUndefined();
    expect(call({ enabled: true, mode: "box", showHelper: false })).toBeUndefined();
    expect(ViewerEngineInteraction.prototype.getDeepClippingBox.call({
      clippingState: { enabled: true, mode: "box", showHelper: true }, clippingHelper, presentationRendererBackend: "webgl"
    } as unknown as ViewerEngineInteraction)).toBeUndefined();
  });
});
