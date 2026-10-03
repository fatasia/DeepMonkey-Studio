import type * as THREE from "three";

const KEY = "deepEnvironmentSpecularMips";

export function readStudioDeepEnvironmentMips(scene: THREE.Scene): number | undefined {
  const value: unknown = scene.userData[KEY];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 8) {
    throw new RangeError("环境反射层数必须为 1–8。");
  }
  return value;
}

export function setStudioDeepEnvironmentMips(scene: THREE.Scene, value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 8)) {
    throw new RangeError("环境反射层数必须为 1–8。");
  }
  if (value === undefined) delete scene.userData[KEY];
  else scene.userData[KEY] = value;
}
