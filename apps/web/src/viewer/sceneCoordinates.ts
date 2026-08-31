import type { SceneCoordinateSystemState, Vector3Value } from "@bim-studio/contracts";

export const DEFAULT_SCENE_COORDINATES: SceneCoordinateSystemState = {
  unit: "m", upAxis: "y", handedness: "right", origin: { x: 0, y: 0, z: 0 }
};

export function normalizeSceneCoordinates(value?: Partial<SceneCoordinateSystemState>): SceneCoordinateSystemState {
  return {
    unit: value?.unit ?? "m",
    upAxis: value?.upAxis ?? "y",
    handedness: value?.handedness ?? "right",
    origin: { ...DEFAULT_SCENE_COORDINATES.origin, ...value?.origin },
    ...(value?.epsg?.trim() ? { epsg: value.epsg.trim() } : {})
  };
}

export function worldToProject(value: Vector3Value, system: SceneCoordinateSystemState): Vector3Value {
  const relative = { x: value.x - system.origin.x, y: value.y - system.origin.y, z: value.z - system.origin.z };
  const axis = system.upAxis === "y" ? relative : { x: relative.x, y: -relative.z, z: relative.y };
  const handed = system.handedness === "left" ? { ...axis, z: -axis.z } : axis;
  const scale = unitInMetres(system.unit);
  return { x: handed.x / scale, y: handed.y / scale, z: handed.z / scale };
}

export function projectToWorld(value: Vector3Value, system: SceneCoordinateSystemState): Vector3Value {
  const scale = unitInMetres(system.unit);
  const handed = { x: value.x * scale, y: value.y * scale, z: value.z * scale * (system.handedness === "left" ? -1 : 1) };
  const axis = system.upAxis === "y" ? handed : { x: handed.x, y: handed.z, z: -handed.y };
  return { x: axis.x + system.origin.x, y: axis.y + system.origin.y, z: axis.z + system.origin.z };
}

export function unitInMetres(unit: SceneCoordinateSystemState["unit"]): number {
  return { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048 }[unit];
}
