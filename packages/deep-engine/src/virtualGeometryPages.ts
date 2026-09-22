import { buildMeshlets } from "./geometry/meshletBuilder.js";
import { hashMeshletBuild } from "./geometry/meshletHash.js";
import { expandMeshletIndices } from "./geometry/meshletIndices.js";
import type { GeometryResource, RenderInstance, RenderPacket } from "./renderPacketTypes.js";

const PAGE_MESHLETS = 32;
const MIN_PAGE_TRIANGLES = 4096;

export interface VirtualGeometryPageDependency {
  readonly pageId: string; readonly sourceGeometry: string; readonly sourceRevision: number;
  readonly firstMeshlet: number; readonly meshletCount: number; readonly byteLength: number;
}
export interface VirtualGeometryPageTable {
  readonly packet: RenderPacket;
  readonly pages: readonly VirtualGeometryPageDependency[];
  readonly sourceInstances: ReadonlyMap<string, readonly string[]>;
}

/** Fixed-upper-bound meshlet pages. Small/deformed/authored-LOD packets stay on the zero-overhead path. */
export function compileVirtualGeometryPages(packet: RenderPacket): VirtualGeometryPageTable {
  if (packet.deformation || packet.instances.some(instance => instance.pose || instance.lod)) {
    return Object.freeze({ packet, pages: Object.freeze([]), sourceInstances: new Map() });
  }
  const geometries: GeometryResource[] = [], pageIds = new Map<string, readonly string[]>();
  const pages: VirtualGeometryPageDependency[] = [];
  for (const source of packet.geometries) {
    if (source.indices.length / 3 < MIN_PAGE_TRIANGLES) { geometries.push(source); continue; }
    const positions = new Float32Array(source.vertices.length / 2);
    for (let vertex = 0; vertex < source.vertices.length / 6; vertex++) positions.set(source.vertices.subarray(vertex * 6, vertex * 6 + 3), vertex * 3);
    const meshlets = buildMeshlets({ positions, indices: source.indices });
    if (meshlets.meshletCount <= PAGE_MESHLETS) { geometries.push(source); continue; }
    const expanded = expandMeshletIndices(meshlets), meshletHash = hashMeshletBuild(meshlets), ids: string[] = [];
    for (let first = 0; first < meshlets.meshletCount; first += PAGE_MESHLETS) {
      const count = Math.min(PAGE_MESHLETS, meshlets.meshletCount - first);
      const firstIndex = expanded.ranges[first * 2]!, last = first + count - 1;
      const endIndex = expanded.ranges[last * 2]! + expanded.ranges[last * 2 + 1]!;
      const provisional = compactPage(source, "deep-vg-page", expanded.indices.subarray(firstIndex, endIndex));
      const id = `deep-vg-${pageHash(provisional, meshletHash, first, count)}`;
      const geometry = Object.freeze({ ...provisional, id });
      geometries.push(geometry); ids.push(id); pages.push(Object.freeze({ pageId: id, sourceGeometry: source.id,
        sourceRevision: source.revision, firstMeshlet: first, meshletCount: count, byteLength: geometryBytes(geometry) }));
    }
    pageIds.set(source.id, Object.freeze(ids));
  }
  if (!pages.length) return Object.freeze({ packet, pages: Object.freeze([]), sourceInstances: new Map() });
  const uniqueGeometries = Object.freeze([...new Map(geometries.map(value => [value.id, value])).values()]);
  const sourceInstances = new Map<string, readonly string[]>(), instances: RenderInstance[] = [];
  for (const instance of packet.instances) {
    const ids = pageIds.get(instance.geometry);
    if (!ids) { instances.push(instance); continue; }
    const derived = ids.map((geometry, index) => `${instance.id}#deep-vg-${index.toString(36)}`);
    sourceInstances.set(instance.id, Object.freeze(derived));
    ids.forEach((geometry, index) => instances.push(Object.freeze({ ...instance, id: derived[index]!, geometry })));
  }
  return Object.freeze({ packet: Object.freeze({ ...packet, geometries: uniqueGeometries,
    instances: Object.freeze(instances) }), pages: Object.freeze(pages), sourceInstances });
}

function compactPage(source: GeometryResource, id: string, indices: Uint32Array): GeometryResource {
  const unique = [...new Set(indices)], remap = new Map(unique.map((value, index) => [value, index]));
  const copy = (input: Float32Array | undefined, stride: number): Float32Array<ArrayBuffer> | undefined => {
    if (!input) return undefined;
    const output = new Float32Array(unique.length * stride);
    unique.forEach((index, target) => output.set(input.subarray(index * stride, index * stride + stride), target * stride));
    return output;
  };
  return Object.freeze({ id, revision: 0, vertices: copy(source.vertices, 6)!,
    ...(source.uv0 ? { uv0: copy(source.uv0, 2)! } : {}), ...(source.uv1 ? { uv1: copy(source.uv1, 2)! } : {}),
    ...(source.tangents ? { tangents: copy(source.tangents, 4)! } : {}), ...(source.colors ? { colors: copy(source.colors, 4)! } : {}),
    indices: Uint32Array.from(indices, value => remap.get(value)!), });
}
function geometryBytes(value: GeometryResource): number {
  return value.vertices.byteLength + value.indices.byteLength + (value.uv0?.byteLength ?? 0)
    + (value.uv1?.byteLength ?? 0) + (value.tangents?.byteLength ?? 0) + (value.colors?.byteLength ?? 0);
}

function pageHash(value: GeometryResource, meshletHash: string, first: number, count: number): string {
  let hash = 0xcbf29ce484222325n;
  const byte = (input: number): void => { hash ^= BigInt(input); hash = BigInt.asUintN(64, hash * 0x100000001b3n); };
  for (const character of `${meshletHash}:${first}:${count}`) { const code = character.charCodeAt(0); byte(code & 255); byte(code >>> 8); }
  for (const array of [value.vertices, value.indices, value.uv0, value.uv1, value.tangents, value.colors]) {
    if (!array) { byte(255); continue; }
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (const value of bytes) byte(value);
  }
  return hash.toString(16).padStart(16, "0");
}
