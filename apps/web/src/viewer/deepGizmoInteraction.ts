import * as THREE from "three";
import type { ModelTransform } from "@bim-studio/contracts";
import type { DeepTransformGizmoInput } from "./deepOverlayPrimitives";

/** Pointer phases consumed by the native Deep gizmo before author-canvas forwarding. */
export type DeepGizmoPointerPhase = "down" | "move" | "up" | "cancel";

export interface DeepGizmoInteractionHost {
  readonly camera: THREE.PerspectiveCamera;
  getDeepTransformGizmoInput(): DeepTransformGizmoInput | undefined;
  getSelectionTransform(): ModelTransform | undefined;
  applySelectionTransform(transform: ModelTransform): void;
  isSelectionLocked(): boolean;
  requestRender?(): void;
}

interface DragState {
  readonly pointerId: number;
  readonly axisIndex: 0 | 1 | 2;
  readonly mode: "translate" | "rotate" | "scale";
  readonly origin: THREE.Vector3;
  readonly worldAxis: THREE.Vector3;
  readonly localAxis: THREE.Vector3;
  readonly plane: THREE.Plane;
  readonly startPoint: THREE.Vector3;
  readonly startTransform: ModelTransform;
  readonly startQuaternion: THREE.Quaternion;
  readonly worldScale: number;
  readonly size: number;
}

const GIZMO_SIZE_DISTANCE_FACTOR = 0.18;
const HIT_TOLERANCE_PX = 14;
const RING_SEGMENTS = 48;

/**
 * Math-only native gizmo interaction. It shares the same DeepTransformGizmoInput
 * as the renderer, but never reads or mutates TransformControls. The host remains
 * the single authoring state owner through applySelectionTransform().
 */
export class DeepGizmoInteraction {
  private drag: DragState | undefined;

  constructor(private readonly host: DeepGizmoInteractionHost, private readonly viewport: () => DOMRect) {}

  get isDragging(): boolean { return this.drag !== undefined; }

  handle(phase: DeepGizmoPointerPhase, event: PointerEvent): boolean {
    if (phase === "down") return this.begin(event);
    if (!this.drag || this.drag.pointerId !== event.pointerId) return false;
    if (phase === "move") {
      this.update(event);
      return true;
    }
    this.finish();
    return true;
  }

  private begin(event: PointerEvent): boolean {
    if (event.button !== 0 || this.host.isSelectionLocked()) return false;
    const input = this.host.getDeepTransformGizmoInput();
    const transform = this.host.getSelectionTransform();
    if (!input || !transform) return false;
    const rect = this.viewport();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const decomposed = decomposeGizmo(input.matrix);
    const axisIndex = hitAxis(input, this.host.camera, rect, event.clientX, event.clientY);
    if (axisIndex === undefined) return false;
    const worldAxis = decomposed.axes[axisIndex]!.clone();
    const localAxis = axisVector(axisIndex);
    const size = Math.max(this.host.camera.position.distanceTo(decomposed.origin) * GIZMO_SIZE_DISTANCE_FACTOR, 1e-4);
    const basis: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    input.matrix.extractBasis(basis[0], basis[1], basis[2]);
    const worldScale = Math.max(basis[axisIndex]!.length(), 1e-6);
    const ray = pointerRay(this.host.camera, rect, event.clientX, event.clientY);
    const plane = interactionPlane(input.mode, worldAxis, decomposed.origin, this.host.camera);
    const startPoint = ray.intersectPlane(plane, new THREE.Vector3());
    if (!startPoint) return false;
    const startQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      transform.rotation.x, transform.rotation.y, transform.rotation.z, "XYZ"));
    this.drag = {
      pointerId: event.pointerId, axisIndex, mode: input.mode, origin: decomposed.origin,
      worldAxis, localAxis, plane, startPoint, startTransform: structuredClone(transform),
      startQuaternion, worldScale, size,
    };
    return true;
  }

  private update(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const point = pointerRay(this.host.camera, this.viewport(), event.clientX, event.clientY)
      .intersectPlane(drag.plane, new THREE.Vector3());
    if (!point) return;
    const amountWorld = point.clone().sub(drag.startPoint).dot(drag.worldAxis);
    const next = structuredClone(drag.startTransform);
    if (drag.mode === "translate") {
      const localAmount = amountWorld / drag.worldScale;
      next.position.x += drag.localAxis.x * localAmount;
      next.position.y += drag.localAxis.y * localAmount;
      next.position.z += drag.localAxis.z * localAmount;
    } else if (drag.mode === "scale") {
      const ratio = Math.max(0.01, 1 + amountWorld / Math.max(drag.size * drag.worldScale, 1e-4));
      if (drag.axisIndex === 0) next.scale.x = Math.max(0.01, drag.startTransform.scale.x * ratio);
      else if (drag.axisIndex === 1) next.scale.y = Math.max(0.01, drag.startTransform.scale.y * ratio);
      else next.scale.z = Math.max(0.01, drag.startTransform.scale.z * ratio);
    } else {
      const startVector = drag.startPoint.clone().sub(drag.origin).normalize();
      const currentVector = point.clone().sub(drag.origin).normalize();
      if (startVector.lengthSq() < 1e-10 || currentVector.lengthSq() < 1e-10) return;
      const angle = Math.atan2(drag.worldAxis.dot(new THREE.Vector3().crossVectors(startVector, currentVector)),
        THREE.MathUtils.clamp(startVector.dot(currentVector), -1, 1));
      const delta = new THREE.Quaternion().setFromAxisAngle(drag.localAxis, angle);
      const euler = new THREE.Euler().setFromQuaternion(drag.startQuaternion.clone().multiply(delta), "XYZ");
      next.rotation = { x: euler.x, y: euler.y, z: euler.z };
    }
    if (![next.position.x, next.position.y, next.position.z, next.rotation.x, next.rotation.y, next.rotation.z,
      next.scale.x, next.scale.y, next.scale.z].every(Number.isFinite)) return;
    this.host.applySelectionTransform(next);
    this.host.requestRender?.();
  }

  private finish(): void { this.drag = undefined; }
}

function axisVector(index: 0 | 1 | 2): THREE.Vector3 {
  return new THREE.Vector3(index === 0 ? 1 : 0, index === 1 ? 1 : 0, index === 2 ? 1 : 0);
}

function decomposeGizmo(matrix: THREE.Matrix4): { origin: THREE.Vector3; axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3] } {
  const origin = new THREE.Vector3().setFromMatrixPosition(matrix);
  const axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  matrix.extractBasis(axes[0], axes[1], axes[2]);
  for (const axis of axes) axis.normalize();
  return { origin, axes };
}

function hitAxis(input: DeepTransformGizmoInput, camera: THREE.Camera, rect: DOMRect, x: number, y: number): 0 | 1 | 2 | undefined {
  const { origin, axes } = decomposeGizmo(input.matrix);
  const size = Math.max(camera.position.distanceTo(origin) * GIZMO_SIZE_DISTANCE_FACTOR, 1e-4);
  const pointer = { x, y };
  let best: { axis: 0 | 1 | 2; distance: number } | undefined;
  for (let index = 0; index < 3; index += 1) {
    const axis = axes[index]!;
    const axisIndex = index as 0 | 1 | 2;
    if (input.mode === "rotate") {
      let previous = project(origin.clone().addScaledVector(axis, size), camera, rect);
      let distance = Infinity;
      const reference = orthogonal(axis);
      const second = new THREE.Vector3().crossVectors(axis, reference).normalize();
      for (let segment = 1; segment <= RING_SEGMENTS; segment += 1) {
        const angle = Math.PI * 2 * segment / RING_SEGMENTS;
        const current = project(origin.clone().addScaledVector(reference, Math.cos(angle) * size)
          .addScaledVector(second, Math.sin(angle) * size), camera, rect);
        distance = Math.min(distance, pointSegmentDistance(pointer, previous, current));
        previous = current;
      }
      if (distance <= HIT_TOLERANCE_PX && (!best || distance < best.distance)) best = { axis: axisIndex, distance };
    } else {
      const start = project(origin, camera, rect);
      const end = project(origin.clone().addScaledVector(axis, size * 1.35), camera, rect);
      const distance = pointSegmentDistance(pointer, start, end);
      if (distance <= HIT_TOLERANCE_PX && (!best || distance < best.distance)) best = { axis: axisIndex, distance };
    }
  }
  return best?.axis;
}

function interactionPlane(mode: DeepTransformGizmoInput["mode"], axis: THREE.Vector3, origin: THREE.Vector3, camera: THREE.Camera): THREE.Plane {
  if (mode === "rotate") return new THREE.Plane().setFromNormalAndCoplanarPoint(axis, origin);
  const view = camera.position.clone().sub(origin).normalize();
  // The drag plane contains the selected axis and faces the camera. Keeping
  // the camera off this plane gives every pointer ray a stable intersection.
  let normal = view.sub(axis.clone().multiplyScalar(view.dot(axis)));
  if (normal.lengthSq() < 1e-10) normal = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(0, 1, 0));
  if (normal.lengthSq() < 1e-10) normal = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(1, 0, 0));
  return new THREE.Plane().setFromNormalAndCoplanarPoint(normal.normalize(), origin);
}

function pointerRay(camera: THREE.Camera, rect: DOMRect, x: number, y: number): THREE.Ray {
  const ndc = new THREE.Vector3(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1, 0.5);
  const origin = camera.getWorldPosition(new THREE.Vector3());
  const point = ndc.unproject(camera);
  return new THREE.Ray(origin, point.sub(origin).normalize());
}

function project(point: THREE.Vector3, camera: THREE.Camera, rect: DOMRect): { x: number; y: number } {
  const value = point.clone().project(camera);
  return { x: rect.left + (value.x + 1) * 0.5 * rect.width, y: rect.top + (1 - value.y) * 0.5 * rect.height };
}

function pointSegmentDistance(point: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq)) : 0;
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function orthogonal(axis: THREE.Vector3): THREE.Vector3 {
  const reference = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3().crossVectors(axis, reference).normalize();
}
