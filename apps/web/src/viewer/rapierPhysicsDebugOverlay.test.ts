import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createPhysicsDebugOverlay, PHYSICS_DEBUG_COLORS, type PhysicsDebugMaterialKind } from "./rapierPhysicsDebugOverlay";
import type { PhysicsDebugColliderEntry } from "./rapierPhysicsDebugView";

function makeEntry(overrides: Partial<PhysicsDebugColliderEntry> = {}): PhysicsDebugColliderEntry {
  return {
    handle: 1,
    modelId: "m1",
    translation: { x: 1, y: 2, z: 3 },
    rotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
    shape: { kind: "cuboid", halfExtents: { x: 0.5, y: 1, z: 1.5 } },
    centerOffset: { x: 0, y: 0.5, z: 0 },
    ...overrides,
  };
}
const alwaysFixed = (): PhysicsDebugMaterialKind => "fixed";

describe("rapierPhysicsDebugOverlay", () => {
  it("每个条目一个线框：世界中心=平移+局部偏移，盒尺寸=2×半边长，朝向=刚体四元数", () => {
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

  it("材质按刚体类型切换：dynamic/kinematic/ground/selected 各用专属语义色", () => {
    const overlay = createPhysicsDebugOverlay();
    overlay.sync(
      [makeEntry({ modelId: "a" }), makeEntry({ modelId: "b" }), makeEntry({ modelId: null }), makeEntry({ modelId: "c" })],
      (entry) => (entry.modelId === "a" ? "dynamic"
        : entry.modelId === "b" ? "kinematic"
          : entry.modelId === null ? "ground" : "selected"),
    );
    const colors = overlay.object.children.map(
      (child) => ((child as THREE.LineSegments).material as THREE.LineBasicMaterial).color.getHex(),
    );
    expect(colors).toEqual([PHYSICS_DEBUG_COLORS.dynamic, PHYSICS_DEBUG_COLORS.kinematic, PHYSICS_DEBUG_COLORS.ground, PHYSICS_DEBUG_COLORS.selected]);
    // 任务语义钉死：运动学=青、静态=灰、选中聚焦=白（接触/约束在各自图层）。
    expect(PHYSICS_DEBUG_COLORS.kinematic).toBe(0x26c6da);
    expect(PHYSICS_DEBUG_COLORS.fixed).toBe(0x8d8d8d);
    expect(PHYSICS_DEBUG_COLORS.selected).toBe(0xffffff);
    // 动态不得与接触橙(0xff9800)混色——排错时两者必须一眼可分。
    expect(PHYSICS_DEBUG_COLORS.dynamic).not.toBe(0xff9800);
  });

  it("球碰撞体：球笼几何随 scale=radius×2 均匀缩放", () => {
    const overlay = createPhysicsDebugOverlay();
    overlay.sync([makeEntry({ shape: { kind: "ball", radius: 0.4 } })], alwaysFixed);
    const line = overlay.object.children[0] as THREE.LineSegments;
    expect(line.scale.x).toBeCloseTo(0.8);
    expect(line.scale.y).toBeCloseTo(0.8);
    expect(line.scale.z).toBeCloseTo(0.8);
  });

  it("网格类碰撞体：按句柄缓存派生棱线几何，scale 恒 1（顶点已含尺寸）", () => {
    const overlay = createPhysicsDebugOverlay();
    const vertices = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]);
    const indices = new Uint32Array([0, 1, 2]);
    overlay.sync([makeEntry({ handle: 7, shape: { kind: "trimesh", vertices, indices } })], alwaysFixed);
    const line = overlay.object.children[0] as THREE.LineSegments;
    expect(line.scale.x).toBe(1);
    const geometryBefore = line.geometry;
    overlay.sync([makeEntry({ handle: 7, shape: { kind: "trimesh", vertices, indices } })], alwaysFixed);
    expect((overlay.object.children[0] as THREE.LineSegments).geometry).toBe(geometryBefore); // 缓存复用
  });

  it("句柄离开同步集后线框隐藏（缓存几何随之释放，dispose 不抛错兜底验证）", () => {
    const overlay = createPhysicsDebugOverlay();
    const vertices = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]);
    const indices = new Uint32Array([0, 1, 2]);
    overlay.sync([makeEntry({ handle: 9, shape: { kind: "trimesh", vertices, indices } })], alwaysFixed);
    overlay.sync([], alwaysFixed);
    expect(overlay.object.children[0]!.visible).toBe(false);
    overlay.dispose();
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
