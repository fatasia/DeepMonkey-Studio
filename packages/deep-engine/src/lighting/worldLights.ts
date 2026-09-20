import type { ClusteredLights, DirectionalLight, LightVector3, PointLight, SpotLight } from "./types.js";
import type { RuntimeLightProfile } from "../runtimePackage/environmentTypes.js";
import type { AuthoredDirectionalShadow } from "../shadows/authoredDirectionalShadow.js";

export interface WorldDirectionalLight extends Omit<DirectionalLight, "directionView"> {
  readonly directionWorld: LightVector3;
  /** Primary directional shadow switch; omitted preserves the preview's enabled default. */
  readonly castShadow?: boolean;
  readonly shadow?: AuthoredDirectionalShadow;
}

export interface WorldPointLight extends Omit<PointLight, "positionView"> {
  readonly positionWorld: LightVector3;
}

export interface WorldSpotLight extends WorldPointLight, Omit<SpotLight, "positionView" | "directionView"> {
  readonly directionWorld: LightVector3;
}

export interface WorldAmbientLight {
  readonly color: LightVector3;
  readonly intensity: number;
}

export interface WorldHemisphereLight {
  readonly directionWorld: LightVector3;
  readonly skyColor: LightVector3;
  readonly groundColor: LightVector3;
  readonly intensity: number;
}

export interface WorldClusteredLights {
  readonly ambient?: readonly WorldAmbientLight[];
  readonly hemisphere?: readonly WorldHemisphereLight[];
  readonly directional?: readonly WorldDirectionalLight[];
  readonly points?: readonly WorldPointLight[];
  readonly spots?: readonly WorldSpotLight[];
  /** E02：IES 光度表载荷，随灯阵一起透传到聚类打包（灯序不变，索引对齐）。 */
  readonly lightProfiles?: readonly RuntimeLightProfile[];
}

function assertRigidViewMatrix(matrix: Float32Array): void {
  if (matrix.length !== 16 || !matrix.every(Number.isFinite)) throw new Error("worldToView must be a finite 4x4 matrix.");
  const columns = [
    [matrix[0]!, matrix[1]!, matrix[2]!],
    [matrix[4]!, matrix[5]!, matrix[6]!],
    [matrix[8]!, matrix[9]!, matrix[10]!],
  ] as const;
  const dot = (left: readonly number[], right: readonly number[]): number =>
    left[0]! * right[0]! + left[1]! * right[1]! + left[2]! * right[2]!;
  const tolerance = 1e-4;
  if (columns.some(column => Math.abs(dot(column, column) - 1) > tolerance)
    || Math.abs(dot(columns[0], columns[1])) > tolerance
    || Math.abs(dot(columns[0], columns[2])) > tolerance
    || Math.abs(dot(columns[1], columns[2])) > tolerance
    || Math.abs(matrix[3]!) > tolerance || Math.abs(matrix[7]!) > tolerance
    || Math.abs(matrix[11]!) > tolerance || Math.abs(matrix[15]! - 1) > tolerance) {
    throw new Error("worldToView must be a rigid affine view transform.");
  }
}

function transform(matrix: Float32Array, value: LightVector3, translate: boolean): LightVector3 {
  const result = [
    matrix[0]! * value[0] + matrix[4]! * value[1] + matrix[8]! * value[2] + (translate ? matrix[12]! : 0),
    matrix[1]! * value[0] + matrix[5]! * value[1] + matrix[9]! * value[2] + (translate ? matrix[13]! : 0),
    matrix[2]! * value[0] + matrix[6]! * value[1] + matrix[10]! * value[2] + (translate ? matrix[14]! : 0),
  ] as const;
  return Object.freeze(result);
}

/** Converts stable author-state world lights to the view-space ABI required by clustering. */
export function transformWorldLightsToView(lights: WorldClusteredLights, worldToView: Float32Array): ClusteredLights {
  assertRigidViewMatrix(worldToView);
  const directional = (lights.directional ?? []).map(light => Object.freeze({
    directionView: transform(worldToView, light.directionWorld, false), color: light.color, intensity: light.intensity,
  }));
  const points = (lights.points ?? []).map(light => Object.freeze({
    positionView: transform(worldToView, light.positionWorld, true), range: light.range, color: light.color, intensity: light.intensity,
    ...(light.shadow ? { shadow: light.shadow } : {}),
  }));
  const spots = (lights.spots ?? []).map(light => Object.freeze({
    positionView: transform(worldToView, light.positionWorld, true), directionView: transform(worldToView, light.directionWorld, false),
    range: light.range, color: light.color, intensity: light.intensity,
    innerConeCos: light.innerConeCos, outerConeCos: light.outerConeCos,
    ...(light.ies ? { ies: light.ies } : {}),
    ...(light.shadow ? { shadow: light.shadow } : {}),
  }));
  return Object.freeze({
    directional: Object.freeze(directional), points: Object.freeze(points), spots: Object.freeze(spots),
    ...(lights.lightProfiles ? { lightProfiles: lights.lightProfiles } : {}),
  });
}
