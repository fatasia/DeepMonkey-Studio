import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildStraightRoad, straightRoadShape } from "./parametricRoadGeometry";

const materials = () => ({
  surface: new THREE.MeshStandardMaterial(),
  shoulder: new THREE.MeshStandardMaterial(),
  marking: new THREE.MeshStandardMaterial(),
});

describe("parametric straight road", () => {
  it("builds metre-accurate grounded carriageway, shoulders and lane markings", () => {
    const group = buildStraightRoad(straightRoadShape({ lengthM: 24, carriagewayWidthM: 8, shoulderWidthM: 1, laneCount: 4, marking: "lanes" }), materials());
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.min.y).toBeCloseTo(0);
    expect(bounds.getSize(new THREE.Vector3()).x).toBeCloseTo(24);
    expect(bounds.getSize(new THREE.Vector3()).z).toBeCloseTo(10);
    const markings = group.children.find((child) => child.name === "道路标线") as THREE.InstancedMesh;
    expect(markings.count).toBeGreaterThanOrEqual(3);
  });

  it("bounds malformed snapshots and caps generated geometry", () => {
    const shape = straightRoadShape({ lengthM: Infinity, carriagewayWidthM: -30, shoulderWidthM: 1e20, laneCount: 99, surface: "mud", marking: "unknown" });
    expect(shape).toEqual({ lengthM: 20, carriagewayWidthM: 2.5, laneCount: 12, shoulderWidthM: 5, surface: "asphalt", marking: "center" });
    const group = buildStraightRoad(straightRoadShape({ lengthM: 500, laneCount: 12, marking: "lanes" }), materials());
    expect(group.children).toHaveLength(4);
    expect((group.children.find((child) => child.name === "道路标线") as THREE.InstancedMesh).count).toBeLessThanOrEqual(1232);
  });
});
