import { packClusteredLights } from "./clusterPacking.js";
import type { ClusterGridConfig, ClusterLightBounds, ClusteredLights, CpuClusterAssignment, NormalizedClusterGrid } from "./types.js";

export const MAX_FORWARD_PLUS_CLUSTER_COUNT = 262_144;
export const MAX_FORWARD_PLUS_LIGHTS_PER_CLUSTER = 256;
const MAX_CPU_CLUSTER_INDEX_COUNT = 16_777_216;
const UNUSED_LIGHT_INDEX = 0xffff_ffff;

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
}

export function normalizeClusterGrid(config: ClusterGridConfig): NormalizedClusterGrid {
  positiveInteger(config.viewportWidth, "viewportWidth"); positiveInteger(config.viewportHeight, "viewportHeight");
  positiveInteger(config.tileSizeX, "tileSizeX"); positiveInteger(config.tileSizeY, "tileSizeY"); positiveInteger(config.zSlices, "zSlices");
  positiveInteger(config.maxLightsPerCluster, "maxLightsPerCluster");
  if (config.zSlices > 256) throw new Error("zSlices must not exceed 256.");
  if (config.maxLightsPerCluster > MAX_FORWARD_PLUS_LIGHTS_PER_CLUSTER) throw new Error(`maxLightsPerCluster must not exceed ${MAX_FORWARD_PLUS_LIGHTS_PER_CLUSTER}.`);
  if (!Number.isFinite(config.near) || !Number.isFinite(config.far) || config.near <= 0 || config.far <= config.near) {
    throw new Error("near/far must be finite and satisfy 0 < near < far.");
  }
  if (!Number.isFinite(config.verticalFovRadians) || config.verticalFovRadians <= 0 || config.verticalFovRadians >= Math.PI) {
    throw new Error("verticalFovRadians must be finite and inside (0, PI). ");
  }
  const tilesX = Math.ceil(config.viewportWidth / config.tileSizeX), tilesY = Math.ceil(config.viewportHeight / config.tileSizeY);
  const clusterCount = tilesX * tilesY * config.zSlices;
  if (!Number.isSafeInteger(clusterCount) || clusterCount > MAX_FORWARD_PLUS_CLUSTER_COUNT) throw new Error(`Cluster count exceeds ${MAX_FORWARD_PLUS_CLUSTER_COUNT}.`);
  return Object.freeze({ ...config, tilesX, tilesY, clusterCount,
    aspect: config.viewportWidth / config.viewportHeight, tanHalfFovY: Math.tan(config.verticalFovRadians * 0.5) });
}

export function clusterDepthBoundary(grid: NormalizedClusterGrid, boundary: number): number {
  if (!Number.isInteger(boundary) || boundary < 0 || boundary > grid.zSlices) throw new Error("Cluster depth boundary is outside the grid.");
  return grid.near * Math.pow(grid.far / grid.near, boundary / grid.zSlices);
}

export function clusterSliceForDepth(grid: NormalizedClusterGrid, depth: number): number {
  if (!Number.isFinite(depth) || depth <= 0) throw new Error("View depth must be finite and positive.");
  const normalized = Math.log(Math.max(grid.near, Math.min(grid.far, depth)) / grid.near) / Math.log(grid.far / grid.near);
  return Math.max(0, Math.min(grid.zSlices - 1, Math.floor(normalized * grid.zSlices)));
}

function tileAt(ndc: number, viewport: number, tileSize: number, tileCount: number): number {
  const pixel = Math.max(0, Math.min(viewport - 1e-4, (ndc * 0.5 + 0.5) * viewport));
  return Math.max(0, Math.min(tileCount - 1, Math.floor(pixel / tileSize)));
}

/** Conservative sphere projection shared with the compute implementation. */
export function clusterBoundsForSphere(grid: NormalizedClusterGrid, positionView: readonly [number, number, number], range: number): ClusterLightBounds | undefined {
  if (positionView.length !== 3 || !positionView.every(Number.isFinite) || !Number.isFinite(range) || range < 0) {
    throw new Error("Cluster sphere must have a finite view-space position and positive range.");
  }
  if (range === 0) return { minTileX: 0, maxTileX: grid.tilesX - 1, minTileY: 0, maxTileY: grid.tilesY - 1, minSlice: 0, maxSlice: grid.zSlices - 1 };
  const depth = -positionView[2];
  if (depth + range < grid.near || depth - range > grid.far) return undefined;
  const minSlice = clusterSliceForDepth(grid, Math.max(grid.near, depth - range));
  const maxSlice = clusterSliceForDepth(grid, Math.min(grid.far, depth + range));
  if (depth <= range || depth - range <= grid.near) {
    return { minTileX: 0, maxTileX: grid.tilesX - 1, minTileY: 0, maxTileY: grid.tilesY - 1, minSlice, maxSlice };
  }
  const tanHalfFovX = grid.tanHalfFovY * grid.aspect, closestDepth = Math.max(grid.near, depth - range);
  const centerX = positionView[0] / (depth * tanHalfFovX), centerY = positionView[1] / (depth * grid.tanHalfFovY);
  const radiusX = range / (closestDepth * tanHalfFovX), radiusY = range / (closestDepth * grid.tanHalfFovY);
  const minX = centerX - radiusX, maxX = centerX + radiusX, minY = centerY - radiusY, maxY = centerY + radiusY;
  if (maxX < -1 || minX > 1 || maxY < -1 || minY > 1) return undefined;
  return {
    minTileX: tileAt(Math.max(-1, minX), grid.viewportWidth, grid.tileSizeX, grid.tilesX),
    maxTileX: tileAt(Math.min(1, maxX), grid.viewportWidth, grid.tileSizeX, grid.tilesX),
    // WebGPU fragment coordinates start at the framebuffer top while view-space +Y projects upward.
    minTileY: tileAt(Math.max(-1, -maxY), grid.viewportHeight, grid.tileSizeY, grid.tilesY),
    maxTileY: tileAt(Math.min(1, -minY), grid.viewportHeight, grid.tileSizeY, grid.tilesY), minSlice, maxSlice,
  };
}

export function assignLightsToClusters(config: ClusterGridConfig, lights: ClusteredLights): CpuClusterAssignment {
  const grid = normalizeClusterGrid(config), packed = packClusteredLights(lights);
  if (grid.clusterCount * grid.maxLightsPerCluster > MAX_CPU_CLUSTER_INDEX_COUNT) {
    throw new Error(`CPU cluster reference exceeds ${MAX_CPU_CLUSTER_INDEX_COUNT} bounded index entries.`);
  }
  const headers = new Uint32Array(grid.clusterCount * 2);
  const lightIndices = new Uint32Array(grid.clusterCount * grid.maxLightsPerCluster); lightIndices.fill(UNUSED_LIGHT_INDEX);
  const bounds = Array.from({ length: packed.pointCount + packed.spotCount }, (_, index) => {
    const offset = index * 4;
    return clusterBoundsForSphere(grid, [packed.localBounds[offset]!, packed.localBounds[offset + 1]!, packed.localBounds[offset + 2]!], packed.localBounds[offset + 3]!);
  });
  const counts = new Uint32Array(grid.clusterCount), xyCount = grid.tilesX * grid.tilesY;
  for (let cluster = 0; cluster < grid.clusterCount; cluster++) headers[cluster * 2] = cluster * grid.maxLightsPerCluster;
  let overflowCount = 0;
  bounds.forEach((lightBounds, lightIndex) => {
    if (!lightBounds) return;
    for (let slice = lightBounds.minSlice; slice <= lightBounds.maxSlice; slice++) {
      for (let tileY = lightBounds.minTileY; tileY <= lightBounds.maxTileY; tileY++) {
        for (let tileX = lightBounds.minTileX; tileX <= lightBounds.maxTileX; tileX++) {
          const cluster = slice * xyCount + tileY * grid.tilesX + tileX, count = counts[cluster]!;
          if (count < grid.maxLightsPerCluster) { lightIndices[cluster * grid.maxLightsPerCluster + count] = lightIndex; counts[cluster] = count + 1; }
          else overflowCount++;
        }
      }
    }
  });
  for (let cluster = 0; cluster < grid.clusterCount; cluster++) headers[cluster * 2 + 1] = counts[cluster]!;
  return { grid, headers, lightIndices, overflowCount, localLightCount: packed.pointCount + packed.spotCount };
}
