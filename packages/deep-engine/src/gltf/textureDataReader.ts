import { MAX_BYTES, budget, integer, invalid, list, noExtensions, object, reference, unsupported, type JsonObject } from "./validation.js";
import { applySparseAccessor, validateSparseAccessor, type SparseBufferView } from "./accessorSparse.js";

interface BufferView extends SparseBufferView {}

/** 纹理旁路只读取调用者提供的 buffer，图像与 UV 都不会触发外部 IO。 */
export class TextureDataReader {
  private readonly views: BufferView[];
  private readonly accessors: JsonObject[];
  private readonly uvCache = new Map<number, Float32Array<ArrayBuffer>>();
  private readonly tangentCache = new Map<number, Float32Array<ArrayBuffer>>();
  private decodedBytes = 0;

  constructor(document: JsonObject, bytes: readonly Uint8Array[], private readonly signal?: AbortSignal) {
    signal?.throwIfAborted();
    const buffers = list(document.buffers, "buffers", 4096);
    if (!Array.isArray(bytes) || bytes.length !== buffers.length) invalid("buffers", "Provide one byte array for every declared buffer.");
    let total = 0;
    const data = buffers.map((value, index) => {
      if ((index & 0x3ff) === 0) signal?.throwIfAborted();
      const path = `buffers[${index}]`, buffer = object(value, path), source = bytes[index];
      noExtensions(buffer, path);
      const length = integer(buffer.byteLength, `${path}.byteLength`, 1);
      if (buffer.uri !== undefined && typeof buffer.uri !== "string") invalid(`${path}.uri`, "Buffer URI must be a string.");
      if (!(source instanceof Uint8Array) || source.byteLength < length) invalid(path, "Buffer bytes are missing or truncated.");
      total += source.byteLength; budget(total, MAX_BYTES, "buffers");
      return new DataView(source.buffer, source.byteOffset, length);
    });
    this.views = list(document.bufferViews, "bufferViews").map((value, index) => {
      if ((index & 0x3ff) === 0) signal?.throwIfAborted();
      const path = `bufferViews[${index}]`, view = object(value, path);
      noExtensions(view, path);
      const source = data[reference(data, view.buffer, `${path}.buffer`)]!;
      const offset = integer(view.byteOffset === undefined ? 0 : view.byteOffset, `${path}.byteOffset`);
      const length = integer(view.byteLength, `${path}.byteLength`, 1);
      if (offset + length > source.byteLength) invalid(path, "Buffer view exceeds its declared buffer.");
      const result: BufferView = { data: source, offset, length };
      if (view.byteStride !== undefined) {
        const stride = integer(view.byteStride, `${path}.byteStride`, 4);
        if (stride > 252 || stride % 4) invalid(path, "Vertex stride must be a multiple of four in 4..252.");
        result.stride = stride;
      }
      if (view.target !== undefined) {
        if (view.target !== 34962 && view.target !== 34963) invalid(`${path}.target`, "Unknown buffer target.");
        result.target = view.target;
      }
      return result;
    });
    this.accessors = list(document.accessors, "accessors").map((value, index) => {
      if ((index & 0x3ff) === 0) signal?.throwIfAborted();
      const path = `accessors[${index}]`, accessor = object(value, path);
      noExtensions(accessor, path);
      if (accessor.normalized !== undefined && typeof accessor.normalized !== "boolean") invalid(`${path}.normalized`, "normalized must be boolean.");
      validateSparseAccessor(accessor, path);
      return accessor;
    });
  }

  imageBytes(value: unknown, path: string, remaining = MAX_BYTES): Uint8Array<ArrayBuffer> {
    this.signal?.throwIfAborted();
    const view = this.views[reference(this.views, value, path)]!;
    if (view.stride !== undefined || view.target !== undefined) invalid(path, "Image buffer views cannot declare byteStride or target.");
    budget(view.length, remaining, "images");
    const source = new Uint8Array(view.data.buffer, view.data.byteOffset + view.offset, view.length);
    const owned = new Uint8Array(source.length); owned.set(source);
    return owned;
  }

  accessorCount(value: unknown, path: string): number {
    const index = reference(this.accessors, value, path);
    return integer(this.accessors[index]!.count, `accessors[${index}].count`, 1);
  }

  texCoord(value: unknown, path: string): Float32Array<ArrayBuffer> {
    const index = reference(this.accessors, value, path), cached = this.uvCache.get(index);
    if (cached) {
      this.decodedBytes += cached.byteLength; budget(this.decodedBytes, MAX_BYTES, "texture coordinates");
      return cached.slice();
    }
    const location = `accessors[${index}]`, accessor = this.accessors[index]!;
    if (accessor.type !== "VEC2" || ![5121, 5123, 5126].includes(accessor.componentType as number)) {
      unsupported(location, "texture coordinates other than FLOAT or normalized unsigned VEC2");
    }
    const component = accessor.componentType as number, size = component === 5121 ? 1 : component === 5123 ? 2 : 4;
    if (component === 5126 && accessor.normalized === true) invalid(`${location}.normalized`, "FLOAT texture coordinates cannot be normalized.");
    if (component !== 5126 && accessor.normalized !== true) invalid(`${location}.normalized`, "Integer texture coordinates must be normalized.");
    const count = integer(accessor.count, `${location}.count`, 1);
    const offset = integer(accessor.byteOffset === undefined ? 0 : accessor.byteOffset, `${location}.byteOffset`);
    this.decodedBytes += count * 2 * 4; budget(this.decodedBytes, MAX_BYTES, "texture coordinates");
    const result = new Float32Array(count * 2), divisor = component === 5121 ? 255 : component === 5123 ? 65_535 : 1;
    const readValue = (view: DataView, position: number): number => {
      const number = component === 5126 ? view.getFloat32(position, true)
        : component === 5121 ? view.getUint8(position) : view.getUint16(position, true);
      return number / divisor;
    };
    if (accessor.bufferView !== undefined) {
      const view = this.views[reference(this.views, accessor.bufferView, `${location}.bufferView`)]!;
      if (view.target === 34963) invalid(location, "Texture coordinates cannot use an index buffer view.");
      const stride = view.stride ?? size * 2;
      if (offset % size || (view.offset + offset) % size || stride < size * 2 || stride % size) invalid(location, "Accessor alignment or stride is invalid.");
      if (offset + (count - 1) * stride + size * 2 > view.length) invalid(location, "Accessor exceeds its buffer view.");
      for (let item = 0; item < count; item++) for (let axis = 0; axis < 2; axis++) {
        if (axis === 0 && (item & 0x3ff) === 0) this.signal?.throwIfAborted();
        const number = readValue(view.data, view.offset + offset + item * stride + axis * size);
        if (!Number.isFinite(number)) invalid(location, "Texture coordinate contains a non-finite value.");
        result[item * 2 + axis] = number;
      }
    } else {
      if (offset !== 0) invalid(`${location}.byteOffset`, "Accessor without a buffer view cannot have a byte offset.");
      if (accessor.sparse === undefined) invalid(`${location}.bufferView`, "Accessor without a buffer view requires sparse storage.");
    }
    applySparseAccessor({ accessor, location, views: this.views, count, width: 2,
      componentSize: size, output: result, readValue, signal: this.signal });
    this.uvCache.set(index, result);
    return result;
  }

  tangent4(value: unknown, path: string): Float32Array<ArrayBuffer> {
    const index = reference(this.accessors, value, path), cached = this.tangentCache.get(index);
    if (cached) {
      this.decodedBytes += cached.byteLength; budget(this.decodedBytes, MAX_BYTES, "tangents");
      return cached.slice();
    }
    const location = `accessors[${index}]`, accessor = this.accessors[index]!;
    if (accessor.type !== "VEC4" || accessor.componentType !== 5126) unsupported(location, "TANGENT accessors other than FLOAT VEC4");
    if (accessor.normalized === true) invalid(`${location}.normalized`, "FLOAT tangents cannot be normalized storage.");
    const count = integer(accessor.count, `${location}.count`, 1);
    const offset = integer(accessor.byteOffset === undefined ? 0 : accessor.byteOffset, `${location}.byteOffset`);
    this.decodedBytes += count * 16; budget(this.decodedBytes, MAX_BYTES, "tangents");
    const result = new Float32Array(count * 4);
    const readValue = (view: DataView, position: number): number => view.getFloat32(position, true);
    if (accessor.bufferView !== undefined) {
      const view = this.views[reference(this.views, accessor.bufferView, `${location}.bufferView`)]!;
      if (view.target === 34963) invalid(location, "Tangents cannot use an index buffer view.");
      const stride = view.stride ?? 16;
      if (offset % 4 || (view.offset + offset) % 4 || stride < 16 || stride % 4) invalid(location, "Accessor alignment or stride is invalid.");
      if (offset + (count - 1) * stride + 16 > view.length) invalid(location, "Accessor exceeds its buffer view.");
      for (let item = 0; item < count; item++) {
        if ((item & 0x3ff) === 0) this.signal?.throwIfAborted();
        const target = item * 4, source = view.offset + offset + item * stride;
        for (let axis = 0; axis < 4; axis++) result[target + axis] = readValue(view.data, source + axis * 4);
      }
    } else {
      if (offset !== 0) invalid(`${location}.byteOffset`, "Accessor without a buffer view cannot have a byte offset.");
      if (accessor.sparse === undefined) invalid(`${location}.bufferView`, "Accessor without a buffer view requires sparse storage.");
    }
    applySparseAccessor({ accessor, location, views: this.views, count, width: 4,
      componentSize: 4, output: result, readValue, signal: this.signal });
    for (let item = 0; item < count; item++) {
      const target = item * 4;
      const x = result[target]!, y = result[target + 1]!, z = result[target + 2]!, w = result[target + 3]!;
      if (!Number.isFinite(x + y + z + w) || Math.abs(Math.hypot(x, y, z) - 1) > 1e-3 || (w !== -1 && w !== 1)) {
        invalid(location, "TANGENT must contain unit XYZ and W equal to -1 or +1.");
      }
    }
    this.tangentCache.set(index, result);
    return result;
  }
}
