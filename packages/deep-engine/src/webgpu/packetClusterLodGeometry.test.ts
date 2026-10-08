import { describe, expect, it } from "vitest";
import type { GeometryResource } from "../renderPacket.js";
import { packTransform } from "../instanceTransform.js";
import { bakePacketClusterGeometry, clusterLocalCamera, clusterTransformSupported } from "./packetClusterLodGeometry.js";

export function clusterGrid(size = 20): GeometryResource {
  const vertices: number[] = [], indices: number[] = [];
  for (let z = 0; z <= size; z++) for (let x = 0; x <= size; x++) vertices.push(x, 0, z, 0, 1, 0);
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    const a = z * (size + 1) + x;
    indices.push(a, a + size + 1, a + 1, a + 1, a + size + 1, a + size + 2);
  }
  return { id: "grid", revision: 1, vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) };
}

describe("cluster PBR attribute retention", () => {
  it("keeps exact finest geometry, source normals and conservative error at coarser levels", () => {
    const source = clusterGrid();
    const { staging, geometry, hasSeams } = bakePacketClusterGeometry(source);
    expect(hasSeams).toBe(false);
    expect(staging.levelGeometry).toHaveLength(3);
    expect(staging.levelGeometry[0]!.indices).toEqual(source.indices);
    expect(geometry.vertices.subarray(0, source.vertices.length)).toEqual(source.vertices);
    for (let offset = 3; offset < geometry.vertices.length; offset += 6) {
      expect([...geometry.vertices.subarray(offset, offset + 3)]).toEqual([0, 1, 0]);
    }
    expect(staging.levelGeometry[2]!.indices.length).toBeLessThan(source.indices.length);
    const coarse = staging.dag.nodes.filter(node => node.level > 0);
    expect(coarse.every(node => node.error > 0)).toBe(true);
  });

  it("keeps normal seams on the exact source level", () => {
    const source = clusterGrid();
    const vertices = new Float32Array(source.vertices.length + 6);
    vertices.set(source.vertices);
    vertices.set([0, 0, 0, 1, 0, 0], source.vertices.length);
    const result = bakePacketClusterGeometry({ ...source, vertices });
    expect(result.hasSeams).toBe(true);
    expect(result.staging.levelGeometry).toHaveLength(1);
    expect(result.geometry.vertices).toEqual(vertices);
  });

  it("retains UV sets, tangent handedness and vertex colors without changing attribute-rich topology", () => {
    const source = clusterGrid(), count = source.vertices.length / 6;
    const uv0 = Float32Array.from({ length: count * 2 }, (_, index) => index / 10);
    const uv1 = Float32Array.from(uv0, value => value * 2);
    const tangents = Float32Array.from({ length: count * 4 }, (_, index) => index % 4 === 0 || index % 4 === 3 ? 1 : 0);
    const colors = Float32Array.from(tangents, value => value * 0.5);
    const result = bakePacketClusterGeometry({ ...source, uv0, uv1, tangents, colors });
    expect(result.staging.levelGeometry).toHaveLength(1);
    expect(result.geometry.uv0).toEqual(uv0); expect(result.geometry.uv1).toEqual(uv1);
    expect(result.geometry.tangents).toEqual(tangents); expect(result.geometry.colors).toEqual(colors);
    expect(result.geometry.indices).toEqual(source.indices);
  });

  it("transforms camera coordinates through the original inverse including mirrored uniform scale", () => {
    const record = new Float32Array(36);
    packTransform([-2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 4, 6, 8, 1], record);
    expect(clusterTransformSupported(record, 0)).toBe(true);
    expect(clusterLocalCamera(record, 0, [0, 10, 14])).toEqual([2, 2, 3]);
    packTransform([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1], record);
    expect(clusterTransformSupported(record, 0)).toBe(false);
    packTransform([2, 0, 0, 0, 1, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1], record);
    expect(clusterTransformSupported(record, 0)).toBe(false);
  });
});
