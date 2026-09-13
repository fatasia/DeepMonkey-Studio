import { MAX_BYTES, budget, integer, invalid, list, noExtensions, object, reference, unsupported, type JsonObject } from "./validation.js";
import { applySparseAccessor, validateSparseAccessor, type SparseBufferView } from "./accessorSparse.js";

interface BufferView extends SparseBufferView {}
export interface AccessorData { readonly count: number; readonly values: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer> }
type AccessorKind = "vertex" | "tangent" | "indices";

/** 只读取调用者显式提供的字节；URI 不会触发网络或文件访问。 */
export class AccessorReader {
  private readonly views: BufferView[];
  private readonly accessors: JsonObject[];
  private readonly cache = new Map<string, AccessorData>();
  private readonly usage = new Map<BufferView, "vertex" | "indices">();
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
      total += source.byteLength;
      budget(total, MAX_BYTES, "buffers");
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
      if (accessor.normalized !== undefined && typeof accessor.normalized !== "boolean") invalid(path, "normalized must be boolean.");
      validateSparseAccessor(accessor, path);
      return accessor;
    });
  }

  read(value: unknown, kind: AccessorKind, path: string): AccessorData {
    const index = reference(this.accessors, value, path), key = `${kind}:${index}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const location = `accessors[${index}]`, accessor = this.accessors[index]!;
    const component = accessor.componentType;
    if (kind === "vertex" && (component !== 5126 || accessor.type !== "VEC3")) unsupported(location, "non-float VEC3 vertex attributes");
    if (kind === "tangent" && (component !== 5126 || accessor.type !== "VEC4")) unsupported(location, "TANGENT accessors other than FLOAT VEC4");
    if (kind === "indices" && (accessor.type !== "SCALAR" || ![5121, 5123, 5125].includes(component as number))) unsupported(location, "non-unsigned scalar indices");
    if (accessor.normalized === true) invalid(`${location}.normalized`, "This accessor semantic cannot use normalized storage.");
    const size = component === 5121 ? 1 : component === 5123 ? 2 : 4;
    const width = kind === "vertex" ? 3 : kind === "tangent" ? 4 : 1;
    const count = integer(accessor.count, `${location}.count`, 1), offset = integer(accessor.byteOffset === undefined ? 0 : accessor.byteOffset, `${location}.byteOffset`);
    const usage = kind === "indices" ? "indices" : "vertex";
    this.decodedBytes += count * width * 4;
    budget(this.decodedBytes, MAX_BYTES, "accessors");
    const values = kind === "indices" ? new Uint32Array(count) : new Float32Array(count * width);
    const readValue = (view: DataView, position: number): number => {
      const number = component === 5126 ? view.getFloat32(position, true)
        : size === 1 ? view.getUint8(position) : size === 2 ? view.getUint16(position, true) : view.getUint32(position, true);
      if (kind === "indices" && number === 2 ** (size * 8) - 1) invalid(location, "Primitive restart indices are forbidden by glTF.");
      return number;
    };
    let baseView: BufferView | undefined;
    if (accessor.bufferView !== undefined) {
      baseView = this.views[reference(this.views, accessor.bufferView, `${location}.bufferView`)]!;
      const stride = baseView.stride ?? size * width;
      if (kind === "indices" && baseView.stride !== undefined) invalid(location, "Index buffer views cannot have byteStride.");
      if (baseView.target !== undefined && baseView.target !== (usage === "vertex" ? 34962 : 34963)) invalid(location, "Buffer target conflicts with accessor usage.");
      if (this.usage.has(baseView) && this.usage.get(baseView) !== usage) invalid(location, "A buffer view cannot mix indices and vertex attributes.");
      if (offset % size || (baseView.offset + offset) % size || stride < size * width || stride % size) invalid(location, "Accessor alignment or stride is invalid.");
      if (offset + (count - 1) * stride + size * width > baseView.length) invalid(location, "Accessor exceeds its buffer view.");
      for (let item = 0; item < count; item++) {
        if ((item & 0x3ff) === 0) this.signal?.throwIfAborted();
        for (let axis = 0; axis < width; axis++) {
          const number = readValue(baseView.data, baseView.offset + offset + item * stride + axis * size);
          if (!Number.isFinite(number)) invalid(location, "Accessor contains a non-finite value.");
          values[item * width + axis] = number;
        }
      }
    } else {
      if (offset !== 0) invalid(`${location}.byteOffset`, "Accessor without a buffer view cannot have a byte offset.");
      if (accessor.sparse === undefined) invalid(`${location}.bufferView`, "Accessor without a buffer view requires sparse storage.");
    }
    applySparseAccessor({ accessor, location, views: this.views, count, width, componentSize: size,
      output: values, readValue, signal: this.signal });
    const result = { count, values };
    if (baseView) this.usage.set(baseView, usage);
    this.cache.set(key, result);
    return result;
  }
}
