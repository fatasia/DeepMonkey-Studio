import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { isWalkableSurface, slideAgainstSurface } from "./characterMotion";

describe("character collision motion", () => {
  it("slides along a wall instead of stopping diagonal movement", () => {
    const result = slideAgainstSurface(new THREE.Vector3(2, 0, -3), new THREE.Vector3(-1, 0, 0));
    expect(result.toArray()).toEqual([0, 0, -3]);
  });

  it("does not pull movement back toward a surface", () => {
    const result = slideAgainstSurface(new THREE.Vector3(-2, 0, 1), new THREE.Vector3(-1, 0, 0));
    expect(result.toArray()).toEqual([-2, 0, 1]);
  });

  it("accepts ramps within the configured slope and rejects steep surfaces", () => {
    const up = new THREE.Vector3(0, 1, 0);
    expect(isWalkableSurface(new THREE.Vector3(0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)), up, 35)).toBe(true);
    expect(isWalkableSurface(new THREE.Vector3(0, Math.cos(Math.PI / 3), Math.sin(Math.PI / 3)), up, 50)).toBe(false);
  });
});
