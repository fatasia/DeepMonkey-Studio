import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { constrainMeasurementEnd, elevationSegment, measurementAngle, projectRayToVerticalAxis } from "./measurement";

describe("measurement constraints", () => {
  it("keeps horizontal measurements on the start plane", () => {
    const result = constrainMeasurementEnd(new THREE.Vector3(1, 2, 3), new THREE.Vector3(4, 8, 9), "horizontal");
    expect(result.toArray()).toEqual([4, 2, 9]);
  });

  it("projects the pointer ray onto the vertical axis through the start point", () => {
    const start = new THREE.Vector3(2, 1, 3);
    const ray = new THREE.Ray(new THREE.Vector3(10, 8, 10), new THREE.Vector3(-8, -2, -7).normalize());
    const result = projectRayToVerticalAxis(ray, start);
    expect(result.x).toBeCloseTo(2, 5);
    expect(result.z).toBeCloseTo(3, 5);
    expect(result.y).toBeCloseTo(6, 5);
  });

  it("measures the angle between two arms", () => {
    const angle = measurementAngle(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, 1)
    );
    expect(THREE.MathUtils.radToDeg(angle)).toBeCloseTo(90, 6);
  });

  it("projects an elevation to the world datum", () => {
    const [start, end] = elevationSegment(new THREE.Vector3(3, 12.5, -4));
    expect(start.toArray()).toEqual([3, 0, -4]);
    expect(end.toArray()).toEqual([3, 12.5, -4]);
  });
});
