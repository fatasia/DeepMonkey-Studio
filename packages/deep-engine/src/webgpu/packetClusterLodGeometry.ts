import { bakeClusterLodDag } from "../rayTracing/clusterLodBake.js";
import type { GeometryResource } from "../renderPacket.js";
import { concatenateLevelGeometry } from "./clusterLodSlotSupport.js";

/** Attribute-rich surfaces retain exact topology until constrained simplification exists. */
export function bakePacketClusterGeometry(source: GeometryResource) {
  const positions = new Float32Array(source.vertices.length / 2);
  const normals = new Map<string, string>();
  let hasSeams = false;
  let firstNormal: string | undefined, varyingNormals = false;
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const offset = vertex * 6;
    positions.set(source.vertices.subarray(offset, offset + 3), vertex * 3);
    const position = Array.from(source.vertices.subarray(offset, offset + 3)).join(",");
    const normal = Array.from(source.vertices.subarray(offset + 3, offset + 6)).join(",");
    firstNormal ??= normal; varyingNormals ||= normal !== firstNormal;
    if (normals.has(position) && normals.get(position) !== normal) hasSeams = true;
    normals.set(position, normal);
  }
  const exactAttributes = hasSeams || varyingNormals || source.uv0 || source.uv1 || source.tangents || source.colors;
  const baked = bakeClusterLodDag({ geometryId: source.id, vertices: positions,
    indices: source.indices, level0ClusterSize: 128, levelCount: exactAttributes ? 1 : 3,
    retainVertexSources: true });
  const combined = concatenateLevelGeometry(baked.levelGeometry);
  const vertices = new Float32Array(combined.vertices.length * 2);
  let destination = 0;
  for (const [level, geometry] of baked.levelGeometry.entries()) {
    const sources = baked.vertexSources![level]!;
    for (let vertex = 0; vertex < sources.length; vertex++) {
      vertices.set(geometry.vertices.subarray(vertex * 3, vertex * 3 + 3), destination);
      // Attributes come from one original vertex; never blend normals across seams.
      vertices.set(source.vertices.subarray(sources[vertex]! * 6 + 3, sources[vertex]! * 6 + 6), destination + 3);
      destination += 6;
    }
  }
  const copyAttribute = (attribute: Float32Array | undefined, stride: number) => {
    if (!attribute) return undefined;
    const copied = new Float32Array(vertices.length / 6 * stride);
    let offset = 0;
    for (const sources of baked.vertexSources!) for (const sourceIndex of sources) {
      copied.set(attribute.subarray(sourceIndex * stride, (sourceIndex + 1) * stride), offset); offset += stride;
    }
    return copied;
  };
  const uv0 = copyAttribute(source.uv0, 2), uv1 = copyAttribute(source.uv1, 2);
  const tangents = copyAttribute(source.tangents, 4), colors = copyAttribute(source.colors, 4);
  return { staging: { dag: baked.dag, levelGeometry: baked.levelGeometry }, hasSeams,
    geometry: { id: `${source.id}:cluster-pbr`, revision: source.revision, vertices, indices: combined.indices,
      ...(uv0 ? { uv0 } : {}), ...(uv1 ? { uv1 } : {}), ...(tangents ? { tangents } : {}), ...(colors ? { colors } : {}) } };
}

export function clusterLocalCamera(record: Float32Array, offset: number,
  point: readonly [number, number, number]): [number, number, number] {
  const x = point[0] - record[offset + 3]!, y = point[1] - record[offset + 7]!, z = point[2] - record[offset + 11]!;
  return [record[offset + 12]! * x + record[offset + 13]! * y + record[offset + 14]! * z,
    record[offset + 16]! * x + record[offset + 17]! * y + record[offset + 18]! * z,
    record[offset + 20]! * x + record[offset + 21]! * y + record[offset + 22]! * z];
}

export function clusterTransformSupported(record: Float32Array, offset: number): boolean {
  const columns = [0, 1, 2].map(column => [record[offset + column]!, record[offset + column + 4]!, record[offset + column + 8]!]);
  const lengths = columns.map(column => Math.hypot(...column));
  const scale = lengths[0]!;
  if (!(scale > 0) || lengths.some(length => Math.abs(length - scale) > scale * 1e-5)) return false;
  return columns.every((column, i) => columns.every((other, j) => i === j
    || Math.abs(column.reduce((sum, value, axis) => sum + value * other[axis]!, 0)) <= scale * scale * 1e-5));
}
