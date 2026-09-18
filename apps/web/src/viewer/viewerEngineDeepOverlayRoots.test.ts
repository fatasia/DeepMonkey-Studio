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
});
