import * as THREE from "three";

/** Removes only the component that points into a collision surface, preserving wall sliding. */
export function slideAgainstSurface(movement: THREE.Vector3, surfaceNormal: THREE.Vector3): THREE.Vector3 {
  const normal = surfaceNormal.clone().normalize();
  const inward = movement.dot(normal);
  return inward < 0 ? movement.clone().addScaledVector(normal, -inward) : movement.clone();
}

export function isWalkableSurface(surfaceNormal: THREE.Vector3, up: THREE.Vector3, maximumSlopeAngle: number): boolean {
  const alignment = Math.abs(surfaceNormal.clone().normalize().dot(up.clone().normalize()));
  return alignment >= Math.cos(THREE.MathUtils.degToRad(maximumSlopeAngle));
}
