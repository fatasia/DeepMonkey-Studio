import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import type { SceneVfxEffectState } from "@bim-studio/contracts";
import { VFX_TEMPLATE_MAP } from "./vfxTemplates";
import { vfxRequestedParticles } from "./modelVfxParticles";
import { createModelVfxEffect, disposeModelVfxEffect, setModelVfxAllocation, updateModelVfxEffect } from "./modelVfxEffect";
import type { VfxEffectPatch } from "./modelEffectState";

const box = () => new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
/** exactOptionalPropertyTypes 下允许显式 undefined(如 blend: undefined 取模板默认混合)。 */
const state = (patch: VfxEffectPatch = {}): SceneVfxEffectState => ({
  ...VFX_TEMPLATE_MAP["exhaust-steam"].defaults, ...patch,
}) as SceneVfxEffectState;

describe("model vfx effect runtime", () => {
  it("creates one deterministic particle draw object from a template and animates it", () => {
    const model = box();
    const runtime = createModelVfxEffect(model, state({ rate: 1.5 }))!;
    expect(runtime).toBeDefined();
    expect(runtime.points.parent).toBe(model);
    expect(runtime.positionAttribute.count).toBe(vfxRequestedParticles(state({ rate: 1.5 })));
    expect(runtime.motion).toBe("rise");
    const before = Array.from(runtime.positionAttribute.array);
    updateModelVfxEffect(runtime, 0.08);
    expect(Array.from(runtime.positionAttribute.array)).not.toEqual(before);
  });

  it("maps each template to its motion family", () => {
    const cases: readonly [SceneVfxEffectState["template"], string][] = [
      ["exhaust-steam", "rise"], ["smoke-leak", "rise"], ["leak-drip", "fall"],
      ["sparks", "burst"], ["spray-mist", "burst"], ["alarm-ring", "ring"],
      ["dust", "drift"], ["airflow", "flow"],
    ];
    for (const [template, motion] of cases) {
      const runtime = createModelVfxEffect(box(), state({ template, rate: 0.25 }))!;
      expect(runtime.motion).toBe(motion);
      disposeModelVfxEffect(runtime);
    }
  });

  it("drives per-particle alpha, size and tone from the lifetime curves", () => {
    const runtime = createModelVfxEffect(box(), state({
      curves: {
        alpha: [{ time: 0, value: 0.4 }, { time: 1, value: 0.4 }],
        size: [{ time: 0, value: 2.5 }, { time: 1, value: 2.5 }],
        color: [{ time: 0, value: 1 }, { time: 1, value: 1 }],
      },
    }))!;
    updateModelVfxEffect(runtime, 0.05);
    const colors = runtime.colorAttribute.array as Float32Array;
    const sizes = runtime.sizeAttribute!.array as Float32Array;
    for (let index = 0; index < runtime.allocatedCount; index += 1) {
      expect(colors[index * 4 + 3]).toBeCloseTo(0.4, 5);
      expect(sizes[index]).toBeCloseTo(2.5, 5);
      // 色调 1 → 亮档(基色向白 56%),三通道均应为正。
      expect(Math.max(colors[index * 4]!, colors[index * 4 + 1]!, colors[index * 4 + 2]!)).toBeGreaterThan(0);
    }
  });

  it("produces distinct trajectories per motion family (sparks burst outward, steam rises)", () => {
    const sparks = createModelVfxEffect(box(), state({ template: "sparks", range: 3, rate: 1 }))!;
    updateModelVfxEffect(sparks, 0.6);
    const sparkPositions = Array.from(sparks.positionAttribute.array);
    const originOffset = [];
    for (let index = 0; index < sparks.allocatedCount; index += 1) {
      originOffset.push(Math.hypot(
        sparkPositions[index * 3]!, sparkPositions[index * 3 + 1]!, sparkPositions[index * 3 + 2]!));
    }
    const maxSparkRadius = Math.max(...originOffset);
    // 迸溅粒子从中心向外扩散,0.6s 后最大半径显著大于初相。
    expect(maxSparkRadius).toBeGreaterThan(0.4);

    const steam = createModelVfxEffect(box(), state({ template: "exhaust-steam", range: 3, rate: 1 }))!;
    updateModelVfxEffect(steam, 0.6);
    const steamPositions = Array.from(steam.positionAttribute.array);
    // 上升档粒子必须到达模型顶面之上(包围盒 max.y = 1)。
    const topY = steam.topY;
    const above = steamPositions.filter((_, index) => index % 3 === 1).filter((y) => y > topY).length;
    expect(above).toBeGreaterThan(0);
    expect(maxSparkRadius).toBeGreaterThan(0);
  });

  it("keeps alarm-ring particles on the ground plane expanding horizontally", () => {
    const ring = createModelVfxEffect(box(), state({ template: "alarm-ring", range: 4, rate: 1 }))!;
    updateModelVfxEffect(ring, 0.5);
    const positions = Array.from(ring.positionAttribute.array);
    for (let index = 0; index < ring.allocatedCount; index += 1) {
      const y = positions[index * 3 + 1]!;
      expect(y).toBeGreaterThanOrEqual(ring.baseY);
      expect(y).toBeLessThan(ring.baseY + 0.5);
      const radius = Math.hypot(positions[index * 3]! - ring.center.x, positions[index * 3 + 2]! - ring.center.z);
      expect(radius).toBeLessThanOrEqual(4.2);
    }
  });

  it("limits draw range and update work to the scene allocation and never crashes at zero", () => {
    const runtime = createModelVfxEffect(box(), state(), { allocated: 30 })!;
    expect(runtime.requestedCount).toBe(80);
    expect(runtime.allocatedCount).toBe(30);
    expect(runtime.points.geometry.drawRange.count).toBe(30);
    updateModelVfxEffect(runtime, 0.05);
    const colors = runtime.colorAttribute.array as Float32Array;
    expect(colors[29 * 4 + 3]).toBeGreaterThanOrEqual(0);
    expect(colors[40 * 4 + 3]).toBe(0);
    setModelVfxAllocation(runtime, 0);
    expect(runtime.points.visible).toBe(false);
    expect(() => updateModelVfxEffect(runtime, 0.05, new THREE.Vector3(0, 0, 10))).not.toThrow();
    setModelVfxAllocation(runtime, 9_999);
    expect(runtime.allocatedCount).toBe(80);
    expect(runtime.points.visible).toBe(true);
  });

  it("honours the authored per-emitter cap and blend mode", () => {
    const capped = createModelVfxEffect(box(), state({ template: "sparks", rate: 2, maxParticles: 32, blend: undefined }))!;
    expect(capped.requestedCount).toBe(32);
    expect(capped.points.material.blending).toBe(THREE.AdditiveBlending);
    const mist = createModelVfxEffect(box(), state({ template: "spray-mist", rate: 0.25, blend: undefined }))!;
    expect(mist.points.material.blending).toBe(THREE.NormalBlending);
  });

  it("sorts alpha-blended particles back-to-front by camera distance", () => {
    const model = box();
    model.updateMatrixWorld(true);
    const eye = new THREE.Vector3(0, 8, 12);
    const runtime = createModelVfxEffect(model, state({ blend: "alpha" }))!;
    updateModelVfxEffect(runtime, 0.05, eye);
    const positions = runtime.positionAttribute.array as Float32Array;
    let previous = Number.POSITIVE_INFINITY;
    for (let index = 0; index < runtime.allocatedCount; index += 1) {
      const distance = Math.hypot(positions[index * 3]! - eye.x, positions[index * 3 + 1]! - eye.y, positions[index * 3 + 2]! - eye.z);
      expect(distance).toBeLessThanOrEqual(previous + 0.05);
      previous = distance;
    }
  });

  it("releases geometry, material and texture, and supports deferred retirement", () => {
    const model = box();
    const runtime = createModelVfxEffect(model, state())!;
    const geometryDispose = vi.spyOn(runtime.points.geometry, "dispose");
    const materialDispose = vi.spyOn(runtime.points.material, "dispose");
    const textureDispose = vi.spyOn(runtime.points.material.map!, "dispose");
    disposeModelVfxEffect(runtime);
    expect(runtime.points.parent).toBeNull();
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(textureDispose).toHaveBeenCalledOnce();

    const deferred = createModelVfxEffect(box(), state())!;
    const retire = vi.fn((object: THREE.Object3D) => object.removeFromParent());
    disposeModelVfxEffect(deferred, retire);
    expect(retire).toHaveBeenCalledWith(deferred.points);
    expect(deferred.points.parent).toBeNull();
  });

  it("returns undefined for empty geometry instead of crashing", () => {
    const empty = new THREE.Group();
    expect(createModelVfxEffect(empty, state())).toBeUndefined();
  });
});
