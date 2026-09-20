import * as THREE from "three";

export interface XRThumbstickState {
  x: number;
  y: number;
  exitPressed: boolean;
}

export function readXRThumbstick(
  axes: readonly number[],
  buttons: readonly { pressed: boolean }[]
): XRThumbstickState {
  const x = axes.length >= 4 ? axes[axes.length - 2] ?? 0 : axes[0] ?? 0;
  const y = axes.length >= 4 ? axes[axes.length - 1] ?? 0 : axes[1] ?? 0;
  return { x, y, exitPressed: Boolean(buttons[5]?.pressed) };
}

export interface XRControllerRay {
  origin: THREE.Vector3;
  direction: THREE.Vector3;
}

/** targetRaySpace 约定：射线从控制器原点沿局部 -Z 发出。 */
export function xrControllerRay(matrixWorld: THREE.Matrix4): XRControllerRay {
  const origin = new THREE.Vector3().setFromMatrixPosition(matrixWorld);
  const direction = new THREE.Vector3(0, 0, -1).transformDirection(matrixWorld).normalize();
  return { origin, direction };
}

/** 命中对象 → 场景模型 ID（与指针拾取同用 userData.modelId 口径，直接读取不做父链回溯）。 */
export function xrHitModelId(object: THREE.Object3D | undefined): string | undefined {
  const modelId = object?.userData?.modelId;
  return typeof modelId === "string" ? modelId : undefined;
}
