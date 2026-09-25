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
    // angle 测量、angle 预览与剖切盒无原生原语,仍由 Three 投影呈现。
    expect(roots).toContain(angle);
    expect(roots).toContain(clippingHelper);
    expect(roots).toContain(annotation);
  });

  it("keeps the measurement preview projected when it is not natively drawable", () => {
    const scene = new THREE.Scene();
    const transform = new THREE.Group();
    const measurementPreview = new THREE.Group(); measurementPreview.name = "helper:measurement-preview";
    // angle 预览无原生原语;无状态(未挂 userData)的预览同样不得凭空消失。
    for (const kind of ["angle", undefined]) {
      measurementPreview.userData.measurement = kind === undefined ? undefined : { kind };
      const roots = ViewerEngineInteraction.prototype.getDeepEditorOverlayRoots.call({
        scene, transform: { getHelper: () => transform }, selectionHelper: undefined,
        clippingHelper: undefined, measurementPreview, sceneLightProxies: new Map(),
        presentationRendererBackend: "webgpu"
      } as unknown as ViewerEngineInteraction);
      expect(roots).toContain(measurementPreview);
    }
  });
});
