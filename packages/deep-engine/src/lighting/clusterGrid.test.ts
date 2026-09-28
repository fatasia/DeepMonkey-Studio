import { describe, expect, it } from "vitest";
import { assignLightsToClusters, clusterBoundsForSphere, clusterDepthBoundary, clusterSliceForDepth, normalizeClusterGrid } from "./clusterGrid.js";

const config = { viewportWidth: 64, viewportHeight: 64, tileSizeX: 32, tileSizeY: 32,
  zSlices: 4, near: 1, far: 16, verticalFovRadians: Math.PI / 2, maxLightsPerCluster: 2 } as const;
const point = (positionView: readonly [number, number, number], range: number) => ({ positionView, range, color: [1, 1, 1] as const, intensity: 1 });

describe("Forward+ view-space cluster CPU reference", () => {
  it("uses configurable XY tiles and logarithmic depth slices", () => {
    const grid = normalizeClusterGrid(config);
    expect([grid.tilesX, grid.tilesY, grid.clusterCount]).toEqual([2, 2, 16]);
    expect(Array.from({ length: 5 }, (_, index) => clusterDepthBoundary(grid, index))).toEqual([1, 2, 4, 8, 16]);
    expect([1, 1.99, 2, 15.99, 16].map(depth => clusterSliceForDepth(grid, depth))).toEqual([0, 0, 1, 3, 3]);
  });

  it("projects local spheres conservatively and rejects off-frustum lights", () => {
    const grid = normalizeClusterGrid(config);
    expect(clusterBoundsForSphere(grid, [0, 0, -5], 0.2)).toMatchObject({ minTileX: 0, maxTileX: 1, minTileY: 0, maxTileY: 1, minSlice: 2, maxSlice: 2 });
    expect(clusterBoundsForSphere(grid, [100, 0, -5], 0.2)).toBeUndefined();
    expect(clusterBoundsForSphere(grid, [0, 0, 5], 0.2)).toBeUndefined();
    expect(clusterBoundsForSphere(grid, [0, 0, -1], 2)).toMatchObject({ minTileX: 0, maxTileX: 1, minSlice: 0 });
    expect(clusterBoundsForSphere(grid, [0, 2, -4], 0.2)).toMatchObject({ minTileY: 0, maxTileY: 0 });
    expect(clusterBoundsForSphere(grid, [0, -2, -4], 0.2)).toMatchObject({ minTileY: 1, maxTileY: 1 });
  });

  it("assigns in stable point-then-spot order and counts bounded overflow", () => {
    const lights = { directional: [{ directionView: [0, -1, 0] as const, color: [1, 1, 1] as const, intensity: 1 }],
      points: [point([0, 0, -2], 100), point([0, 0, -2], 100)],
      spots: [{ ...point([0, 0, -2], 100), directionView: [0, 0, -1] as const, outerConeCos: 0.5, innerConeCos: 0.75 }] };
    const first = assignLightsToClusters(config, lights), second = assignLightsToClusters(config, lights);
    expect(first.localLightCount).toBe(3); expect(first.overflowCount).toBe(16);
    expect(first.headers).toEqual(second.headers); expect(first.lightIndices).toEqual(second.lightIndices);
    for (let cluster = 0; cluster < first.grid.clusterCount; cluster++) {
      expect(Array.from(first.lightIndices.slice(cluster * 2, cluster * 2 + 2))).toEqual([0, 1]);
      expect(Array.from(first.headers.slice(cluster * 2, cluster * 2 + 2))).toEqual([cluster * 2, 2]);
    }
  });

  it("fails closed before allocating impractical or invalid grids", () => {
    expect(() => normalizeClusterGrid({ ...config, near: 0 })).toThrow("near/far");
    expect(() => normalizeClusterGrid({ ...config, verticalFovRadians: Math.PI })).toThrow("verticalFovRadians");
    expect(() => normalizeClusterGrid({ ...config, maxLightsPerCluster: 257 })).toThrow("256");
    expect(() => normalizeClusterGrid({ ...config, viewportWidth: 16384, viewportHeight: 16384, tileSizeX: 1, tileSizeY: 1 })).toThrow("Cluster count");
  });

  it("culls by distance: fully-behind lights are rejected and straddlers clamp to the last slice", () => {
    const grid = normalizeClusterGrid(config);
    // Sphere fully beyond far (depth 16.5, range 0.2): depth + range < far is false, depth - range > far rejects.
    expect(clusterBoundsForSphere(grid, [0, 0, -16.5], 0.2)).toBeUndefined();
    // Sphere centered just inside far still reaches it and clamps to the final slice.
    expect(clusterBoundsForSphere(grid, [0, 0, -15.6], 0.3)).toMatchObject({ minSlice: 3, maxSlice: 3 });
    // Straddling far: slice range covers the last slice only for the inside part.
    const straddler = clusterBoundsForSphere(grid, [0, 0, -15.9], 0.5);
    expect(straddler?.maxSlice).toBe(3);
    // Invalid geometry fails closed instead of silently culling.
    expect(() => clusterBoundsForSphere(grid, [0, 0, -5], -1)).toThrow("positive range");
    expect(() => clusterBoundsForSphere(grid, [Number.NaN, 0, -5], 1)).toThrow("finite");
  });

  it("spans the whole grid for zero-range and near-overlapping spheres, and buckets multi-slice ranges", () => {
    const grid = normalizeClusterGrid(config);
    expect(clusterBoundsForSphere(grid, [3, 3, -5], 0)).toMatchObject({
      minTileX: 0, maxTileX: 1, minTileY: 0, maxTileY: 1, minSlice: 0, maxSlice: 3 });
    // A sphere overlapping the near plane floods all XY tiles but keeps its depth span.
    expect(clusterBoundsForSphere(grid, [0, 0, -2], 3)).toMatchObject({ minTileX: 0, maxTileX: 1, minSlice: 0 });
    // Off-axis light inside the frustum maps to a precise tile via the Y-flipped projection.
    const grid2 = normalizeClusterGrid({ ...config, viewportWidth: 128, viewportHeight: 128 });
    expect(clusterBoundsForSphere(grid2, [0.9, 0.9, -4], 0.5)).toMatchObject({ minTileX: 2, maxTileX: 2, minTileY: 1, maxTileY: 1 });
  });

  it("never indexes lights culled out of the frustum and keeps overflow bounded per cluster", () => {
    const lights = { points: [point([0, 0, -2], 3), point([500, 500, -2], 0.5), point([0, 0, 30], 0.5)],
      spots: [] };
    const assignment = assignLightsToClusters(config, lights);
    expect(assignment.localLightCount).toBe(3);
    const indexed = new Set<number>();
    for (let value = 0; value < assignment.lightIndices.length; value++) {
      const index = assignment.lightIndices[value]!;
      if (index !== 0xffff_ffff) indexed.add(index);
    }
    expect([...indexed]).toEqual([0]);
    expect(assignment.overflowCount).toBe(0);
  });
});
