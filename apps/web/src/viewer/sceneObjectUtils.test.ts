import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applyTransform, normalizedSpaceBox, objectMeshCount, objectTransform, objectVisibleMeshCount, prepareCompleteExportObject, sanitizeExportObject, visibleObjectBox } from "./sceneObjectUtils";

describe("scene object utilities", () => {
  it("round-trips transforms and calculates only visible geometry bounds", () => {
    const root = new THREE.Group();
    const visible = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(100, 100, 100));
    hidden.visible = false;
    const effect = new THREE.Points(new THREE.BoxGeometry(200, 200, 200));
    effect.userData.effectHelper = true;
    root.add(visible, hidden, effect);
    applyTransform(visible, {
      position: { x: 3, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 }
    });
    expect(objectTransform(visible).position).toEqual({ x: 3, y: 0, z: 0 });
    expect(visibleObjectBox(root).getSize(new THREE.Vector3()).x).toBeCloseTo(2);
    expect(objectVisibleMeshCount(root)).toBe(1);
  });

  it("pads thin BIM spaces and removes helper objects from export clones", () => {
    const box = normalizedSpaceBox({ min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 0, z: 3 } });
    expect(box?.getSize(new THREE.Vector3()).y).toBeCloseTo(0.5);
    const root = new THREE.Group();
    root.userData.source = "runtime";
    root.add(new THREE.Group(), Object.assign(new THREE.Group(), { name: "helper:selection" }));
    sanitizeExportObject(root);
    expect(root.userData).toEqual({});
    expect(root.children).toHaveLength(1);
  });

  it("includes author-hidden geometry in a complete export but still removes deleted layers", () => {
    const root = new THREE.Group();
    const hidden = new THREE.Mesh(new THREE.BoxGeometry());
    hidden.visible = false;
    const deleted = new THREE.Mesh(new THREE.BoxGeometry());
    deleted.userData.layerDeleted = true;
    root.add(hidden, deleted);

    prepareCompleteExportObject(root);

    expect(hidden.visible).toBe(true);
    expect(objectMeshCount(root)).toBe(1);
    expect(root.children).not.toContain(deleted);
  });
});
