import type { GeometryResource } from "../renderPacketTypes.js";

const MAGIC = 0x444f4c48; // HLOD, little-endian.
const VERSION = 1;
const MAX_GEOMETRIES = 4096;
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });

/** Small manifest stays JSON; this content-addressed binary contains only proxy meshes. */
export function encodeHlodProxyGeometries(geometries: readonly GeometryResource[]): Uint8Array<ArrayBuffer> {
  if (geometries.length > MAX_GEOMETRIES) throw new RangeError("HLOD proxy count exceeds RenderPacket capacity.");
  const ordered = [...geometries].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const seen = new Set<string>();
  const rows = ordered.map(geometry => {
    const id = encoder.encode(geometry.id);
    if (!id.length || id.length > 256 || seen.has(geometry.id) || geometry.revision !== 0
      || geometry.vertices.length % 6 !== 0 || geometry.indices.length % 3 !== 0
      || geometry.vertices.some(value => !Number.isFinite(value))
      || geometry.indices.some(index => index >= geometry.vertices.length / 6)) {
      throw new TypeError(`Invalid HLOD proxy geometry: ${geometry.id}.`);
    }
    seen.add(geometry.id);
    return { id, geometry };
  });
  const total = rows.reduce((bytes, { id, geometry }) =>
    bytes + 10 + id.byteLength + geometry.vertices.byteLength + geometry.indices.byteLength, 12);
  if (total > MAX_PAYLOAD_BYTES) throw new RangeError("HLOD proxy payload exceeds the package budget.");
  const buffer = new ArrayBuffer(total), view = new DataView(buffer), output = new Uint8Array(buffer);
  view.setUint32(0, MAGIC, true); view.setUint32(4, VERSION, true); view.setUint32(8, rows.length, true);
  let offset = 12;
  for (const { id, geometry } of rows) {
    view.setUint16(offset, id.byteLength, true);
    view.setUint32(offset + 2, geometry.vertices.length, true);
    view.setUint32(offset + 6, geometry.indices.length, true);
    offset += 10; output.set(id, offset); offset += id.length;
    for (const value of geometry.vertices) { view.setFloat32(offset, value, true); offset += 4; }
    for (const index of geometry.indices) { view.setUint32(offset, index, true); offset += 4; }
  }
  return output;
}

/** Fail closed on truncation, trailing bytes, duplicate IDs, invalid mesh payload and unknown versions. */
export function decodeHlodProxyGeometries(input: Uint8Array): readonly GeometryResource[] {
  if (input.byteLength < 12 || input.byteLength > MAX_PAYLOAD_BYTES) throw new TypeError("Invalid HLOD proxy payload length.");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== VERSION) {
    throw new TypeError("Unsupported HLOD proxy payload header.");
  }
  const count = view.getUint32(8, true);
  if (count > MAX_GEOMETRIES) throw new RangeError("HLOD proxy count exceeds RenderPacket capacity.");
  const result: GeometryResource[] = [], seen = new Set<string>();
  let offset = 12;
  const available = (bytes: number) => {
    if (bytes > input.byteLength - offset) throw new TypeError("Truncated HLOD proxy payload.");
  };
  for (let row = 0; row < count; row++) {
    available(10);
    const idLength = view.getUint16(offset, true), vertexLength = view.getUint32(offset + 2, true);
    const indexLength = view.getUint32(offset + 6, true); offset += 10;
    if (!idLength || idLength > 256 || vertexLength % 6 !== 0 || indexLength % 3 !== 0
      || vertexLength === 0 || indexLength === 0) throw new TypeError("Invalid HLOD proxy mesh dimensions.");
    const payloadLength = idLength + (vertexLength + indexLength) * 4;
    if (payloadLength > MAX_PAYLOAD_BYTES) throw new RangeError("HLOD proxy mesh exceeds the package budget.");
    available(payloadLength);
    const id = decoder.decode(input.subarray(offset, offset + idLength)); offset += idLength;
    if (seen.has(id)) throw new TypeError(`Duplicate HLOD proxy geometry id: ${id}.`);
    seen.add(id);
    const vertices = new Float32Array(vertexLength), indices = new Uint32Array(indexLength);
    for (let i = 0; i < vertexLength; i++) {
      const value = view.getFloat32(offset, true); offset += 4;
      if (!Number.isFinite(value)) throw new TypeError(`Invalid HLOD proxy vertex in ${id}.`);
      vertices[i] = value;
    }
    for (let i = 0; i < indexLength; i++) {
      const index = view.getUint32(offset, true); offset += 4;
      if (index >= vertexLength / 6) throw new TypeError(`Invalid HLOD proxy index in ${id}.`);
      indices[i] = index;
    }
    result.push({ id, revision: 0, vertices, indices });
  }
  if (offset !== input.byteLength) throw new TypeError("Trailing bytes in HLOD proxy payload.");
  return result;
}
