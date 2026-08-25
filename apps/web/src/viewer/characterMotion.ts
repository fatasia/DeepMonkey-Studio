import * as THREE from "three";

/** Removes only the component that points into a collision surface, preserving wall sliding. */
export function slideAgainstSurface(movement: THREE.Vector3, surfaceNormal: THREE.Vector3): THREE.Vector3 {
  const normal = surfaceNormal.clone().normalize();
  const inward = movement.dot(normal);
  return inward < 0 ? movement.clone().addScaledVector(normal, -inward) : movement.clone();
}
