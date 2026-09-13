import type { WorldClusteredLights } from "../lighting/worldLights.js";
import type { Vec3 } from "../webgpu/cameraMath.js";
import type { RenderView } from "../webgpu/pbrRenderer.js";

export interface ThreePerspectiveCameraSource {
  readonly matrixWorld: { readonly elements: ArrayLike<number> };
  /** Three camera fov is expressed in degrees. */
  readonly fov: number;
  readonly zoom: number;
  readonly near: number;
  readonly far: number;
}

export interface ThreeRenderViewSource {
  readonly camera: ThreePerspectiveCameraSource;
  readonly target: Vec3;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  /** 场景包围尺度，用于阴影与屏幕空间效果半径，不改变相机投影。 */
  readonly extent: number;
  readonly background: Vec3;
  readonly floor: Vec3;
  readonly exposure: number;
  readonly roughness: number;
  readonly lights?: WorldClusteredLights;
}

/** 将 Three 相机的世界位置、透视参数和宿主灯光转换为 Deep RenderView。 */
export function threeRenderView(source: ThreeRenderViewSource): RenderView {
  const matrix = source.camera.matrixWorld.elements;
  if (matrix.length !== 16 || !Array.from(matrix).every(Number.isFinite)) throw new Error("Three camera matrixWorld is invalid.");
  const { fov, zoom, near, far } = source.camera;
  if (![fov, zoom, near, far].every(Number.isFinite) || fov <= 0 || fov >= 180 || zoom <= 0 || near <= 0 || far <= near) {
    throw new Error("Three camera projection is invalid.");
  }
  const verticalFovRadians = 2 * Math.atan(Math.tan(fov * Math.PI / 360) / zoom);
  if (!Number.isFinite(verticalFovRadians) || verticalFovRadians <= 0 || verticalFovRadians >= Math.PI) {
    throw new Error("Three camera field of view is invalid.");
  }
  return {
    width: source.width, height: source.height, pixelRatio: source.pixelRatio, extent: source.extent,
    eye: [matrix[12]!, matrix[13]!, matrix[14]!], target: source.target,
    up: [matrix[4]!, matrix[5]!, matrix[6]!],
    background: source.background, floor: source.floor, exposure: source.exposure, roughness: source.roughness,
    verticalFovRadians, near, far, ...(source.lights ? { lights: source.lights } : {}),
  };
}
