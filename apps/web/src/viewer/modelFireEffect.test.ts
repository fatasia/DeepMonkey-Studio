import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { createModelFireEffect, disposeModelFireEffect, updateModelFireEffect } from "./modelFireEffect";

describe("model fire effect runtime", () => {
  it("creates one deterministic particle draw object and animates it", () => {
    const model = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 2), new THREE.MeshBasicMaterial());
    const runtime = createModelFireEffect(model, { enabled: true, color: "#ff5500", intensity: 2, height: 4, density: 1.5 });
    expect(runtime).toBeDefined();
    expect(runtime?.points.parent).toBe(model);
    expect(runtime?.positionAttribute.count).toBe(120);
    const before = Array.from(runtime!.positionAttribute.array);
    updateModelFireEffect(runtime!, 0.08);
    expect(Array.from(runtime!.positionAttribute.array)).not.toEqual(before);
  });

  it("releases geometry, material and texture when the model/effect is removed", () => {
    const model = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const runtime = createModelFireEffect(model, { enabled: true, color: "#ff5500", intensity: 2, height: 2, density: 1 })!;
    const geometryDispose = vi.spyOn(runtime.points.geometry, "dispose");
    const materialDispose = vi.spyOn(runtime.points.material, "dispose");
    const textureDispose = vi.spyOn(runtime.points.material.map!, "dispose");
    disposeModelFireEffect(runtime);
    expect(runtime.points.parent).toBeNull();
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(textureDispose).toHaveBeenCalledOnce();
  });

  it("delegates retirement so WebGPU can defer in-flight resource disposal", () => {
    const model = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const runtime = createModelFireEffect(model, { enabled: true, color: "#ff5500", intensity: 2, height: 2, density: 1 })!;
    const retire = vi.fn((object: THREE.Object3D) => object.removeFromParent());
    disposeModelFireEffect(runtime, retire);
    expect(retire).toHaveBeenCalledWith(runtime.points);
    expect(runtime.points.parent).toBeNull();
  });
});
