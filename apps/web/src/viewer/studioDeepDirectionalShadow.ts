import * as THREE from "three";

export interface StudioDirectionalShadow {
  readonly viewProjection: readonly number[];
  readonly mapSize: number;
  readonly bias: number;
  readonly normalBias: number;
  readonly intensity: number;
  readonly radius: number;
}

/** Snapshot Three's light camera without changing the author's matrices or shadow cache. */
export function projectStudioDirectionalShadow(light: THREE.DirectionalLight,
  filter: THREE.ShadowMapType): StudioDirectionalShadow {
  if (filter !== THREE.PCFShadowMap) throw new Error("Deep 作者阴影当前需要 Three PCFShadowMap 过滤。");
  const shadow = light.shadow, original = shadow.camera;
  if (!(original instanceof THREE.OrthographicCamera) || original.parent) {
    throw new Error("Deep 作者方向光需要未挂接父节点的正交阴影相机。");
  }
  if (original.reversedDepth) throw new Error("Deep 作者阴影尚未接入反向深度比较。");
  const { x: width, y: height } = shadow.mapSize;
  if (width !== height || !Number.isSafeInteger(width) || width < 1 || width > 16384) {
    throw new Error("Deep 作者阴影需要有效的正方形贴图尺寸。");
  }
  if (![shadow.bias, shadow.normalBias, shadow.intensity, shadow.radius].every(Number.isFinite)
    || shadow.bias < -1 || shadow.bias > 1 || shadow.normalBias < 0
    || shadow.intensity < 0 || shadow.intensity > 1 || shadow.radius < 0) {
    throw new Error("作者阴影偏移、强度或过滤半径无效。");
  }
  if (![...original.projectionMatrix.elements, original.near, original.far].every(Number.isFinite)
    || original.near < 0 || original.far <= original.near) throw new Error("作者阴影投影矩阵或深度范围无效。");
  const position = new THREE.Vector3().setFromMatrixPosition(light.matrixWorld);
  const target = new THREE.Vector3().setFromMatrixPosition(light.target.matrixWorld);
  if (![...position.toArray(), ...target.toArray()].every(Number.isFinite) || position.distanceToSquared(target) < 1e-16) {
    throw new Error("作者阴影灯光位置和目标必须有限且不同。");
  }
  const camera = original.clone();
  camera.position.copy(position);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  const projection = camera.projectionMatrix.clone();
  if (camera.coordinateSystem === THREE.WebGLCoordinateSystem) {
    // Clip-space z' = (z + w) / 2; x/y and the projection's own asymmetric bounds are unchanged.
    projection.premultiply(new THREE.Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0.5, 0, 0, 0, 1));
  } else if (camera.coordinateSystem !== THREE.WebGPUCoordinateSystem) {
    throw new Error("未知的作者阴影裁剪坐标系。");
  }
  const viewProjection = projection.multiply(camera.matrixWorldInverse).toArray();
  if (!viewProjection.every(value => Number.isFinite(Math.fround(value)))) throw new Error("作者阴影矩阵超出 GPU 数值范围。");
  return { viewProjection, mapSize: width, bias: shadow.bias, normalBias: shadow.normalBias,
    intensity: shadow.intensity, radius: shadow.radius };
}
