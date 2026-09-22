import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createPhysicsDebugOverlay, type PhysicsDebugMaterialKind } from "./rapierPhysicsDebugOverlay";
import type { PhysicsDebugColliderEntry } from "./rapierPhysicsDebugView";

function makeEntry(overrides: Partial<PhysicsDebugColliderEntry> = {}): PhysicsDebugColliderEntry {
  return {
    modelId: "m1",
    translation: { x: 1, y: 2, z: 3 },
    rotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
    halfExtents: { x: 0.5, y: 1, z: 1.5 },
    centerOffset: { x: 0, y: 0.5, z: 0 },
    ...overrides,
  };
}
const alwaysFixed = (): PhysicsDebugMaterialKind => "fixed";

describe("rapierPhysicsDebugOverlay", () => {
  it("每个条目一个线框：世界中心=平移+局部偏移，尺寸=2×半边长，朝向=刚体四元数", () => {
    const overlay = createPhysicsDebugOverlay();
    overlay.sync([makeEntry()], alwaysFixed);
    expect(overlay.object.children).toHaveLength(1);
    const line = overlay.object.children[0] as THREE.LineSegments;
    expect(line.position.x).toBeCloseTo(1);
    expect(line.position.y).toBeCloseTo(2.5);
    expect(line.position.z).toBeCloseTo(3);
    expect(line.scale.x).toBeCloseTo(1);
    expect(line.scale.y).toBeCloseTo(2);
    expect(line.scale.z).toBeCloseTo(3);
    expect(line.quaternion.x).toBeCloseTo(0);
    expect(line.quaternion.w).toBeCloseTo(1);
  });

  it("局部偏移先经刚体旋转再叠加平移（绕 Z 转 90° 时 (1,0,0) 偏移落到世界 +Y）", () => {
    const half = Math.SQRT1_2;
    const overlay = createPhysicsDebugOverlay();
    overlay.sync(
      [makeEntry({
        translation: { x: 0, y: 0, z: 0 },
        rotationQuaternion: { x: 0, y: 0, z: half, w: half },
        centerOffset: { x: 1, y: 0, z: 0 },
      })],
      alwaysFixed,
    );
    const line = overlay.object.children[0] as THREE.LineSegments;
    expect(line.position.x).toBeCloseTo(0);
    expect(line.position.y).toBeCloseTo(1);
    expect(line.position.z).toBeCloseTo(0);
  });

  it("材质按刚体类型切换：dynamic/kinematic/ground 各用专属颜色", () => {
    const overlay = createPhysicsDebugOverlay();
    overlay.sync(
      [makeEntry({ modelId: "a" }), makeEntry({ modelId: "b" }), makeEntry({ modelId: null })],
      (entry) => (entry.modelId === "a" ? "dynamic" : entry.modelId === "b" ? "kinematic" : "ground"),
    );
    const colors = overlay.object.children.map(
      (child) => ((child as THREE.LineSegments).material as THREE.LineBasicMaterial).color.getHex(),
    );
    expect(colors).toEqual([0xff7043, 0xba68c8, 0x78909c]);
  });

  it("数量收缩只隐藏多余线框、池按峰值复用，不重建对象", () => {
    const overlay = createPhysicsDebugOverlay();
    overlay.sync([makeEntry(), makeEntry(), makeEntry()], alwaysFixed);
    expect(overlay.object.children).toHaveLength(3);
    const first = overlay.object.children[0];
    overlay.sync([makeEntry()], alwaysFixed);
    expect(overlay.object.children).toHaveLength(3);
    expect(overlay.object.children[0]!.visible).toBe(true);
    expect(overlay.object.children[1]!.visible).toBe(false);
    overlay.sync([makeEntry(), makeEntry()], alwaysFixed);
    expect(overlay.object.children[1]!.visible).toBe(true);
    expect(overlay.object.children[0]).toBe(first);
  });

  it("setVisible 关闭整组渲染；dispose 摘除子线框并脱离父级", () => {
    const overlay = createPhysicsDebugOverlay();
    overlay.sync([makeEntry()], alwaysFixed);
    overlay.setVisible(false);
    expect(overlay.object.visible).toBe(false);
    overlay.setVisible(true);
    expect(overlay.object.visible).toBe(true);
    const parent = new THREE.Group();
    parent.add(overlay.object);
    overlay.dispose();
    expect(parent.children).toHaveLength(0);
    expect(overlay.object.children).toHaveLength(0);
  });
});
