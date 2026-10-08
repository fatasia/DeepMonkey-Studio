import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { applyTransform, normalizedSpaceBox, objectMeshCount, objectTransform, objectVisibleMeshCount, prepareCompleteExportObject, sanitizeExportObject, visibleObjectBox } from "./sceneObjectUtils";

describe("scene object utilities", () => {
  it("frames the current skin pose and caches unchanged joint state without changing the default fast box", () => {
    const geometry = new THREE.BoxGeometry(2, 2, 2).translate(-50, 0, 0), count = geometry.getAttribute("position").count;
    geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
    const weights = new Float32Array(count * 4); for (let i = 0; i < count; i++) weights[i * 4] = 1;
    geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weights, 4));
    const mesh = new THREE.SkinnedMesh(geometry), bone = new THREE.Bone(); mesh.add(bone); mesh.bind(new THREE.Skeleton([bone]));
    mesh.computeBoundingBox(); mesh.computeBoundingSphere(); bone.position.x = 50;
    const compute = vi.spyOn(mesh, "computeBoundingBox");
    expect(visibleObjectBox(mesh).getCenter(new THREE.Vector3()).x).toBeCloseTo(-50);
    expect(compute).not.toHaveBeenCalled();
    expect(visibleObjectBox(mesh, true).getCenter(new THREE.Vector3()).x).toBeCloseTo(0);
    expect(mesh.boundingSphere!.center.x).toBeCloseTo(0);
    visibleObjectBox(mesh, true); expect(compute).toHaveBeenCalledOnce();
    bone.position.x = 60;
    expect(visibleObjectBox(mesh, true).getCenter(new THREE.Vector3()).x).toBeCloseTo(10);
    expect(compute).toHaveBeenCalledTimes(2);
    mesh.bindMatrix.makeTranslation(3, 0, 0);
    expect(visibleObjectBox(mesh, true).getCenter(new THREE.Vector3()).x).toBeCloseTo(13);
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it("uses current morph weights and instance transforms while retaining helper/deleted/hidden filters", () => {
    const root = new THREE.Group(), geometry = new THREE.BoxGeometry(2, 2, 2);
    geometry.morphTargetsRelative = true;
    const delta = new Float32Array(geometry.getAttribute("position").count * 3);
    for (let i = 0; i < delta.length; i += 3) delta[i] = 20;
    geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(delta, 3)];
    const morph = new THREE.Mesh(geometry); root.add(morph);
    morph.morphTargetInfluences![0] = .5;
    expect(visibleObjectBox(root, true).getCenter(new THREE.Vector3()).x).toBeCloseTo(10);
    morph.morphTargetInfluences![0] = 1;
    expect(visibleObjectBox(root, true).getCenter(new THREE.Vector3()).x).toBeCloseTo(20);
    const instances = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial(), 2);
    instances.setMatrixAt(0, new THREE.Matrix4().makeTranslation(40, 0, 0));
    instances.setMatrixAt(1, new THREE.Matrix4().makeTranslation(60, 0, 0)); root.add(instances);
    const compute = vi.spyOn(instances, "computeBoundingBox");
    expect(visibleObjectBox(instances, true).getCenter(new THREE.Vector3()).x).toBeCloseTo(50);
    visibleObjectBox(instances, true); expect(compute).toHaveBeenCalledOnce();
    instances.setMatrixAt(1, new THREE.Matrix4().makeTranslation(80, 0, 0)); instances.instanceMatrix.needsUpdate = true;
    expect(visibleObjectBox(instances, true).getCenter(new THREE.Vector3()).x).toBeCloseTo(60);
    for (const type of ["hidden", "deleted", "helper"]) {
      const ignored = new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000));
      if (type === "hidden") ignored.visible = false;
      if (type === "deleted") ignored.userData.layerDeleted = true;
      if (type === "helper") ignored.userData.effectHelper = true;
      root.add(ignored);
    }
    expect(visibleObjectBox(root, true).max.x).toBeCloseTo(81);
  });

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
