import * as THREE from "three";

/** Third-person camera clearance. OrbitControls remains the input authority; this only limits its output. */
export class RuntimeFollowCamera {
  private desiredDistance = 0;
  private lastResolvedDistance = 0;
  private initialized = false;

  reset(): void {
    this.initialized = false;
  }

  update(
    eye: THREE.Vector3,
    target: THREE.Vector3,
    radius: number,
    deltaSeconds: number,
    nearestBlocker: (direction: THREE.Vector3, distance: number) => number | undefined,
  ): boolean {
    const offset = eye.clone().sub(target);
    const distance = offset.length();
    if (!Number.isFinite(distance) || distance < 1e-5 || !Number.isFinite(radius) || radius < 0) {
      this.reset();
      return false;
    }
    const direction = offset.multiplyScalar(1 / distance);
    // OrbitControls can clamp a blocked eye back to its minDistance before this call.
    // Never interpret that clamp as an explicit zoom; keep the authored orbit radius.
    if (!this.initialized) this.desiredDistance = distance;
    else if (distance > this.desiredDistance + 1e-3) this.desiredDistance = distance;
    else if (distance < this.lastResolvedDistance - 1e-3) this.desiredDistance = distance;
    const intendedDistance = Math.max(distance, this.desiredDistance);
    const hit = nearestBlocker(direction, intendedDistance);
    const safeDistance = hit === undefined ? intendedDistance
      : Math.min(intendedDistance, Math.max(1e-4, Math.min(hit * 0.5, hit - radius)));
    // Inward correction is immediate so a wall never appears in front of the camera.
    // Outward return is time-based to avoid a one-frame jump after clearing the wall.
    const resolvedDistance = safeDistance < distance
      ? safeDistance
      : distance + (safeDistance - distance) * (1 - Math.exp(-8 * Math.max(0, Math.min(deltaSeconds, 0.05))));
    const changed = Math.abs(resolvedDistance - distance) > 1e-5;
    if (changed) eye.copy(target).addScaledVector(direction, resolvedDistance);
    this.desiredDistance = intendedDistance;
    this.lastResolvedDistance = resolvedDistance;
    this.initialized = true;
    return changed;
  }
}
