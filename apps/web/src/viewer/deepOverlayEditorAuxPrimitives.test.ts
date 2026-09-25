import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { projectDeepAnnotation, projectDeepLightProxy } from "./deepOverlayPrimitives";

function camera(): THREE.PerspectiveCamera {
  const value = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  value.position.set(4, 3, 4);
  value.lookAt(0, 0, 0);
  value.updateMatrixWorld(true);
  return value;
}

describe("Deep editor auxiliary overlay primitives", () => {
  it("projects finite annotation pin and marker geometry", () => {
    const vertices = projectDeepAnnotation({ position: new THREE.Vector3(), size: 1, color: "#2f8fff", selected: true }, camera(), 320, 240, 1);
    expect(vertices.length).toBe(3 * 18 * 8);
    expect([...vertices].every(Number.isFinite)).toBe(true);
  });

  it("projects a light direction and finite fallback handle", () => {
    const withTarget = projectDeepLightProxy({ position: new THREE.Vector3(), target: new THREE.Vector3(0, 1, 0) }, camera(), 320, 240, 1);
    const withoutTarget = projectDeepLightProxy({ position: new THREE.Vector3(1, 0, 0) }, camera(), 320, 240, 1);
    expect(withTarget.length).toBe(3 * 18 * 8);
    expect(withoutTarget.length).toBe(2 * 18 * 8);
    expect([...withTarget, ...withoutTarget].every(Number.isFinite)).toBe(true);
  });
});
