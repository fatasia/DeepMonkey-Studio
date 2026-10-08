import type { ClusterLodSceneStaging } from "../webgpu/clusterLodRenderSlot.js";
export function validateClusterLodStagingShape(staging: ClusterLodSceneStaging): void {
  if (!staging || typeof staging !== "object" || Array.isArray(staging)) {
    throw new TypeError("clusterLodStaging must be an object.");
  }
  if (!staging.dag || typeof staging.dag !== "object" || !Array.isArray(staging.levelGeometry)
    || staging.levelGeometry.length === 0) {
    throw new TypeError("clusterLodStaging must carry a bake dag and non-empty levelGeometry.");
  }
  for (const level of staging.levelGeometry) {
    if (!(level.vertices instanceof Float32Array) || !(level.indices instanceof Uint32Array)) {
      throw new TypeError("clusterLodStaging levelGeometry must pair Float32Array vertices with Uint32Array indices.");
    }
  }
  if (staging.pixelThreshold !== undefined && (!Number.isFinite(staging.pixelThreshold) || staging.pixelThreshold <= 0)) {
    throw new RangeError("clusterLodStaging pixelThreshold must be a positive number.");
  }
}

/** 把 bake 顶点平移到与已发布包一致的相机相对渲染坐标；口径与
 * CameraRelativeCoordinates.localFloat 一致（fround + float32 精度预算，该符号未导出）。 */
export function localizeClusterLodStaging(staging: ClusterLodSceneStaging,
  origin: readonly [number, number, number]): ClusterLodSceneStaging {
  if (origin.every(axis => axis === 0)) return staging;
  const [originX, originY, originZ] = origin;
  return { ...staging, levelGeometry: staging.levelGeometry.map(level => {
    const vertices = new Float32Array(level.vertices.length);
    for (let index = 0; index < vertices.length; index += 3) {
      vertices[index] = renderLocalFloat(level.vertices[index]! - originX);
      vertices[index + 1] = renderLocalFloat(level.vertices[index + 1]! - originY);
      vertices[index + 2] = renderLocalFloat(level.vertices[index + 2]! - originZ);
    }
    return { vertices, indices: level.indices };
  }) };
}

function renderLocalFloat(value: number): number {
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded) || Math.abs(rounded - value) > 0.001) {
    throw new Error("Cluster LOD staging vertex exceeds the scene-local-coordinates-v1 precision budget.");
  }
  return Object.is(rounded, -0) ? 0 : rounded;
}

