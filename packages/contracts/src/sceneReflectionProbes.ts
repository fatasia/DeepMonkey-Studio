import type { Vector3Value } from "./geometry.js";
import { expectArray, expectBoolean, expectNumber, expectObject, expectString, invalid, optional, required } from "./applicationValidationPrimitives.js";

/** Local cubemap parallax domain; omitted environmentMapUrl inherits the authored environment. */
export interface SceneReflectionProbeState {
  id: string;
  name: string;
  enabled: boolean;
  center: Vector3Value;
  halfExtents: Vector3Value;
  blendDistance: number;
  influenceRadius: number;
  environmentMapUrl?: string;
  environmentMapName?: string;
}

export function validateSceneReflectionProbes(value: unknown, path: string): void {
  const ids = new Set<string>();
  expectArray(value, path, (probe, probePath) => {
    const object = expectObject(probe, probePath);
    required(object, "id", expectString, probePath); required(object, "name", expectString, probePath);
    if (ids.has(object.id as string)) invalid(`${probePath}.id`, "反射探针 ID 重复");
    ids.add(object.id as string); required(object, "enabled", expectBoolean, probePath);
    for (const key of ["center", "halfExtents"] as const) required(object, key, (vector, vectorPath) => {
      const coordinates = expectObject(vector, vectorPath);
      for (const axis of ["x", "y", "z"] as const) {
        required(coordinates, axis, expectNumber, vectorPath);
        const number = coordinates[axis] as number;
        if (number < (key === "halfExtents" ? 1e-6 : -1e9) || number > 1e9) invalid(`${vectorPath}.${axis}`, "反射探针坐标超出有效范围");
      }
    }, probePath);
    for (const key of ["blendDistance", "influenceRadius"] as const) {
      required(object, key, expectNumber, probePath);
      if ((object[key] as number) < 0 || (object[key] as number) > 1e9) invalid(`${probePath}.${key}`, "反射探针距离超出有效范围");
    }
    for (const key of ["environmentMapUrl", "environmentMapName"] as const) optional(object, key, expectString, probePath);
  });
  if ((value as unknown[]).length > 2) invalid(path, "反射探针最多 2 个");
}
