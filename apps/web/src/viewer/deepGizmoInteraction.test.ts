import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { ModelTransform } from "@bim-studio/contracts";
import { DeepGizmoInteraction } from "./deepGizmoInteraction";

function camera(): THREE.PerspectiveCamera {
  const value = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  value.position.set(0, 0, 5);
  value.lookAt(0, 0, 0);
  value.updateMatrixWorld(true);
  return value;
}

function transform(): ModelTransform {
  return { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
}

function pointer(x: number, y: number, id = 1): PointerEvent {
  return { clientX: x, clientY: y, button: 0, pointerId: id } as unknown as PointerEvent;
}

function rect(): DOMRect { return { left: 0, top: 0, width: 400, height: 400 } as DOMRect; }

function axisPoint(cameraValue: THREE.Camera, axis: THREE.Vector3, size = 0.9): { x: number; y: number } {
  const projected = axis.clone().multiplyScalar(size).project(cameraValue);
  return { x: 200 + projected.x * 200, y: 200 - projected.y * 200 };
}

describe("DeepGizmoInteraction", () => {
  it("hits a native translate axis and applies local translation without TransformControls", () => {
    const cameraValue = camera();
    let current = transform();
    const apply = vi.fn((next: ModelTransform) => { current = next; });
    const host = {
      camera: cameraValue,
      getDeepTransformGizmoInput: () => ({ matrix: new THREE.Matrix4(), mode: "translate" as const }),
      getSelectionTransform: () => current,
      applySelectionTransform: apply,
      isSelectionLocked: () => false,
    };
    const gizmo = new DeepGizmoInteraction(host, rect);
    const hit = axisPoint(cameraValue, new THREE.Vector3(1, 0, 0));
    expect(gizmo.handle("down", pointer(hit.x, hit.y))).toBe(true);
    expect(gizmo.handle("move", pointer(hit.x + 36, hit.y))).toBe(true);
    expect(gizmo.handle("up", pointer(hit.x + 36, hit.y))).toBe(true);
    expect(apply).toHaveBeenCalled();
    expect(current.position.x).toBeGreaterThan(0);
    expect(gizmo.isDragging).toBe(false);
  });

  it("rejects misses and locked selections", () => {
    const cameraValue = camera();
    const host = {
      camera: cameraValue,
      getDeepTransformGizmoInput: () => ({ matrix: new THREE.Matrix4(), mode: "scale" as const }),
      getSelectionTransform: () => transform(),
      applySelectionTransform: vi.fn(),
      isSelectionLocked: () => true,
    };
    const gizmo = new DeepGizmoInteraction(host, rect);
    expect(gizmo.handle("down", pointer(200, 200))).toBe(false);
    expect(host.applySelectionTransform).not.toHaveBeenCalled();
  });

  it("supports rotate ring hit testing and keeps finite Euler output", () => {
    const cameraValue = camera();
    let current = transform();
    const host = {
      camera: cameraValue,
      getDeepTransformGizmoInput: () => ({ matrix: new THREE.Matrix4(), mode: "rotate" as const }),
      getSelectionTransform: () => current,
      applySelectionTransform: (next: ModelTransform) => { current = next; },
      isSelectionLocked: () => false,
    };
    const gizmo = new DeepGizmoInteraction(host, rect);
    const ring = axisPoint(cameraValue, new THREE.Vector3(1, 0, 0));
    expect(gizmo.handle("down", pointer(ring.x, ring.y))).toBe(true);
    expect(gizmo.handle("move", pointer(ring.x, ring.y - 28))).toBe(true);
    expect(gizmo.handle("up", pointer(ring.x, ring.y - 28))).toBe(true);
    expect([current.rotation.x, current.rotation.y, current.rotation.z].every(Number.isFinite)).toBe(true);
  });
});
