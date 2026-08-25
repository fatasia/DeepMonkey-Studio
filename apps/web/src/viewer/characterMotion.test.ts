import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { slideAgainstSurface } from "./characterMotion";

describe("character collision motion", () => {
  it("slides along a wall instead of stopping diagonal movement", () => {
    const result = slideAgainstSurface(new THREE.Vector3(2, 0, -3), new THREE.Vector3(-1, 0, 0));
    expect(result.toArray()).toEqual([0, 0, -3]);
  });

  it("does not pull movement back toward a surface", () => {
    const result = slideAgainstSurface(new THREE.Vector3(-2, 0, 1), new THREE.Vector3(-1, 0, 0));
    expect(result.toArray()).toEqual([-2, 0, 1]);
  });
});
