import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { createModelFireEffect, disposeModelFireEffect, setModelFireAllocation, updateModelFireEffect } from "./modelFireEffect";

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

  describe("lifetime curves, budget and sorting", () => {
    const base = { enabled: true, color: "#ff5500", intensity: 2, height: 2, density: 1 } as const;
    const box = () => new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());

    it("drives per-particle alpha, size and colour from the lifetime curves", () => {
      const runtime = createModelFireEffect(box(), {
        ...base,
        curves: { alpha: [{ time: 0, value: 0.25 }, { time: 1, value: 0.25 }], size: [{ time: 0, value: 3 }, { time: 1, value: 3 }] },
      })!;
      updateModelFireEffect(runtime, 0.05);
      const colors = runtime.colorAttribute.array as Float32Array;
      const sizes = runtime.sizeAttribute!.array as Float32Array;
      for (let index = 0; index < runtime.allocatedCount; index += 1) {
        expect(colors[index * 4 + 3]).toBeCloseTo(0.25, 5);
        expect(sizes[index]).toBeCloseTo(3, 5);
        expect(Math.max(colors[index * 4]!, colors[index * 4 + 1]!, colors[index * 4 + 2]!)).toBeGreaterThan(0);
      }
      expect(runtime.points.material.vertexColors).toBe(true);
    });

    it("uses the curve mean as global size when per-particle size is unavailable (WebGPU)", () => {
      const withAttribute = createModelFireEffect(box(), { ...base, curves: { size: [{ time: 0, value: 2 }, { time: 1, value: 2 }] } })!;
      const fallback = createModelFireEffect(box(), { ...base, curves: { size: [{ time: 0, value: 2 }, { time: 1, value: 2 }] } }, { perParticleSize: false })!;
      expect(fallback.sizeAttribute).toBeUndefined();
      expect(fallback.points.geometry.getAttribute("aSizeScale")).toBeUndefined();
      expect(fallback.points.material.size).toBeCloseTo(withAttribute.points.material.size * 2, 5);
    });

    it("limits draw range and update work to the scene allocation and never crashes at zero", () => {
      const runtime = createModelFireEffect(box(), base, { allocated: 30 })!;
      expect(runtime.requestedCount).toBe(80);
      expect(runtime.allocatedCount).toBe(30);
      expect(runtime.points.geometry.drawRange.count).toBe(30);
      updateModelFireEffect(runtime, 0.05);
      const colors = runtime.colorAttribute.array as Float32Array;
      expect(colors[29 * 4 + 3]).toBeGreaterThanOrEqual(0);
      expect(colors[40 * 4 + 3]).toBe(0);
      setModelFireAllocation(runtime, 0);
      expect(runtime.points.visible).toBe(false);
      expect(() => updateModelFireEffect(runtime, 0.05, new THREE.Vector3(0, 0, 10))).not.toThrow();
      setModelFireAllocation(runtime, 9_999);
      expect(runtime.allocatedCount).toBe(80);
      expect(runtime.points.visible).toBe(true);
    });

    it("honours the authored per-emitter cap", () => {
      const runtime = createModelFireEffect(box(), { ...base, density: 2, maxParticles: 32 })!;
      expect(runtime.requestedCount).toBe(32);
      expect(runtime.positionAttribute.count).toBe(32);
    });

    it("sorts alpha-blended particles back-to-front by camera distance and keeps additive order", () => {
      const model = box();
      model.updateMatrixWorld(true);
      const eye = new THREE.Vector3(0, 8, 12);
      const alpha = createModelFireEffect(model, { ...base, blend: "alpha" })!;
      expect(alpha.points.material.blending).toBe(THREE.NormalBlending);
      updateModelFireEffect(alpha, 0.05, eye);
      const positions = alpha.positionAttribute.array as Float32Array;
      let previous = Number.POSITIVE_INFINITY;
      for (let index = 0; index < alpha.allocatedCount; index += 1) {
        const distance = Math.hypot(positions[index * 3]! - eye.x, positions[index * 3 + 1]! - eye.y, positions[index * 3 + 2]! - eye.z);
        expect(distance).toBeLessThanOrEqual(previous + 0.05);
        previous = distance;
      }

      const additive = createModelFireEffect(model, base)!;
      expect(additive.points.material.blending).toBe(THREE.AdditiveBlending);
      const unsorted = Array.from(additive.sim.rank);
      updateModelFireEffect(additive, 0.05, eye);
      expect(Array.from(additive.sim.rank)).toEqual(unsorted);
    });
  });});
