import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { fullyOccluded, projectOcclusionBox } from "./occlusionProjection";
import { occlusionCompleteBoxDraw, occlusionOpaqueMaterial, solidBoxGeometry } from "./occlusionSolidGeometry";

function camera() { const value = new THREE.PerspectiveCamera(50, 1.4, 0.1, 100); value.position.z = 8; value.lookAt(0, 0, 0); value.updateMatrixWorld(true); return value; }
function project(size: [number, number, number], location: [number, number, number]) {
  return projectOcclusionBox(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(...size)), new THREE.Matrix4().makeTranslation(...location), camera());
}

describe("conservative solid occlusion", () => {
  it("requires complete disjoint draw groups for a material array", () => {
    const geometry = new THREE.BoxGeometry(), materials = Array.from({ length: 6 }, () => new THREE.MeshStandardMaterial());
    expect(occlusionCompleteBoxDraw(geometry, materials)).toBe(true);
    geometry.groups.push({ ...geometry.groups[0]! }); expect(occlusionCompleteBoxDraw(geometry, materials)).toBe(false);
    geometry.clearGroups(); expect(occlusionCompleteBoxDraw(geometry, materials)).toBe(false);
    expect(occlusionCompleteBoxDraw(geometry, materials[0]!)).toBe(true);
  });
  it("rejects partial draw groups even when the renderer uses one material", () => {
    const geometry = new THREE.BoxGeometry();
    geometry.groups = [{ start: 0, count: 30, materialIndex: 0 }];
    expect(occlusionCompleteBoxDraw(geometry, new THREE.MeshStandardMaterial())).toBe(false);
    geometry.groups = [{ start: 0, count: 36, materialIndex: 0 }];
    expect(occlusionCompleteBoxDraw(geometry, new THREE.MeshStandardMaterial())).toBe(true);
  });
  it("culls an entire object behind a solid wall, retaining edge and foreground objects", () => {
    const wall = project([6, 6, 0.5], [0, 0, 2])!;
    expect(fullyOccluded(project([1, 1, 1], [0, 0, -2])!, wall)).toBe(true);
    expect(fullyOccluded(project([1, 1, 1], [7, 0, -2])!, wall)).toBe(false);
    expect(fullyOccluded(project([1, 1, 1], [0, 0, 4])!, wall)).toBe(false);
    expect(project([2, 2, 2], [0, 0, 8])).toBeUndefined();
  });
  it("accepts imported closed cuboids and rejects missing or duplicate triangles", () => {
    const box = new THREE.BoxGeometry(6, 6, 0.5);
    expect(solidBoxGeometry(box)).toBeDefined();
    expect(solidBoxGeometry(box.toNonIndexed())).toBeDefined();
    box.index!.setX(0, box.index!.getX(3)); box.index!.setX(1, box.index!.getX(4)); box.index!.setX(2, box.index!.getX(5));
    box.index!.needsUpdate = true;
    expect(solidBoxGeometry(box)).toBeUndefined();
    expect(solidBoxGeometry(new THREE.SphereGeometry())).toBeUndefined();
  });
  it("invalidates edited geometry and excludes clipping, transparency and displacement", () => {
    const box = new THREE.BoxGeometry(); expect(solidBoxGeometry(box)).toBeDefined();
    box.attributes.position!.setXYZ(0, 0, 0, 0); box.attributes.position!.needsUpdate = true;
    expect(solidBoxGeometry(box)).toBeUndefined();
    const material = new THREE.MeshPhysicalMaterial(); expect(occlusionOpaqueMaterial(material)).toBe(true);
    material.transmission = 0.5; expect(occlusionOpaqueMaterial(material)).toBe(false);
    material.transmission = 0; material.clippingPlanes = [new THREE.Plane()]; expect(occlusionOpaqueMaterial(material)).toBe(false);
  });
});
