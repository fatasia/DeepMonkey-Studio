import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildQtoReport, estimateObjectQuantity, type QtoObjectInput } from "./qtoTakeoff";

function meshObject(id: string, category: string, level: string, geometry: THREE.BufferGeometry, position: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1]): QtoObjectInput {
  const mesh = new THREE.Mesh(geometry);
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  return { id, root: mesh, category, level };
}

describe("QTO takeoff (P7 slice)", () => {
  it("computes exact volume and area for a unit cube", () => {
    const estimate = estimateObjectQuantity("wall-1", new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    expect(estimate).not.toBeNull();
    expect(estimate?.volumeCubicMetres).toBeCloseTo(1, 5);
    expect(estimate?.surfaceAreaSquareMetres).toBeCloseTo(6, 5);
    expect(estimate?.openMeshSuspected).toBe(false);
  });

  it("applies world scale and translation", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.scale.set(2, 1, 1);
    mesh.position.set(100, 100, 100);
    const estimate = estimateObjectQuantity("slab", mesh);
    expect(estimate?.volumeCubicMetres).toBeCloseTo(2, 5);
    expect(estimate?.surfaceAreaSquareMetres).toBeCloseTo(10, 5);
  });

  it("flags an open triangle as suspected-open with correct area", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
    ], 3));
    const estimate = estimateObjectQuantity("patch", geometry ? new THREE.Mesh(geometry) : new THREE.Mesh());
    expect(estimate?.openMeshSuspected).toBe(true);
    expect(estimate?.surfaceAreaSquareMetres).toBeCloseTo(0.5, 5);
  });

  it("aggregates lines by category and level with totals and skips empty objects", () => {
    const objects: QtoObjectInput[] = [
      meshObject("wall-a", "墙", "一层", new THREE.BoxGeometry(1, 1, 1)),
      meshObject("wall-b", "墙", "一层", new THREE.BoxGeometry(1, 1, 1)),
      meshObject("slab-c", "楼板", "二层", new THREE.BoxGeometry(2, 1, 1)),
      { id: "empty-group", root: new THREE.Group(), category: "空", level: "一层" },
    ];
    const report = buildQtoReport(objects);
    expect(report.lines).toHaveLength(2);
    const wallLine = report.lines.find((line) => line.category === "墙");
    expect(wallLine).toMatchObject({ count: 2, totalVolumeCubicMetres: 2 });
    const slabLine = report.lines.find((line) => line.category === "楼板");
    expect(slabLine?.totalVolumeCubicMetres).toBeCloseTo(2, 5);
    expect(report.skipped).toEqual([{ id: "empty-group", reason: "无可见网格" }]);
    expect(report.totals.volumeCubicMetres).toBeCloseTo(4, 5);
    expect(report.totals.surfaceAreaSquareMetres).toBeCloseTo(6 + 6 + 10, 5);
  });
});
