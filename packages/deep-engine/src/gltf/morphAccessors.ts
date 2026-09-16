import type { GltfMorphImportConfiguration } from "./morphTypes.js";
import { budget, integer, invalid, list, noExtensions, object, reference, unsupported, vector, type JsonObject } from "./validation.js";
import { applySparseAccessor, validateSparseAccessor, type SparseBufferView } from "./accessorSparse.js";

type MorphAccessorUsage = "vertex" | "animation";
interface MorphBufferView extends SparseBufferView {}
interface MorphAccessorLayout {
  readonly accessor: JsonObject; readonly location: string; readonly view?: MorphBufferView;
  readonly count: number; readonly offset: number; readonly stride: number;
}
export interface MorphAccessorData { readonly count: number; readonly values: Float32Array<ArrayBuffer> }

/** FLOAT-only reader for morph deltas and variable-width weight animation streams. */
export class MorphAccessorReader {
  private readonly accessors: readonly JsonObject[];
  private readonly views: readonly MorphBufferView[];
  private readonly usage = new Map<MorphBufferView, MorphAccessorUsage>();
  private decoded = 0;

  constructor(document: JsonObject, buffers: readonly Uint8Array[], private readonly limits: GltfMorphImportConfiguration,
    private readonly signal?: AbortSignal) {
    signal?.throwIfAborted();
    const declarations = list(document.buffers, "buffers", 1);
    if (declarations.length !== buffers.length) invalid("buffers", "Embedded morph buffers are missing or inconsistent.");
    const data = declarations.map((value, index) => {
      if ((index & 0x3ff) === 0) signal?.throwIfAborted();
      const path = `buffers[${index}]`, buffer = object(value, path), bytes = buffers[index];
      noExtensions(buffer, path);
      if (buffer.uri !== undefined) unsupported(`${path}.uri`, "external morph buffers");
      const length = integer(buffer.byteLength, `${path}.byteLength`, 1);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < length) invalid(path, "Embedded morph buffer is truncated.");
      return new DataView(bytes.buffer, bytes.byteOffset, length);
    });
    this.views = list(document.bufferViews, "bufferViews", 250_000).map((value, index) => {
      if ((index & 0x3ff) === 0) signal?.throwIfAborted();
      const path = `bufferViews[${index}]`, view = object(value, path);
      noExtensions(view, path);
      const source = data[reference(data, view.buffer, `${path}.buffer`)]!;
      const offset = integer(view.byteOffset ?? 0, `${path}.byteOffset`), length = integer(view.byteLength, `${path}.byteLength`, 1);
      if (offset + length > source.byteLength) invalid(path, "Buffer view exceeds the embedded buffer.");
      const stride = view.byteStride === undefined ? undefined : integer(view.byteStride, `${path}.byteStride`, 4);
      if (stride !== undefined && (stride > 252 || stride % 4 !== 0)) invalid(`${path}.byteStride`, "byteStride must be a multiple of four in 4..252.");
      const target = view.target === undefined ? undefined : integer(view.target, `${path}.target`);
      if (target !== undefined && target !== 34962 && target !== 34963) invalid(`${path}.target`, "Unknown buffer target.");
      return { data: source, offset, length, ...(stride === undefined ? {} : { stride }), ...(target === undefined ? {} : { target }) };
    });
    this.accessors = list(document.accessors, "accessors", 250_000).map((value, index) => {
      if ((index & 0x3ff) === 0) signal?.throwIfAborted();
      const path = `accessors[${index}]`, accessor = object(value, path);
      noExtensions(accessor, path);
      if (accessor.normalized !== undefined && typeof accessor.normalized !== "boolean") invalid(`${path}.normalized`, "normalized must be boolean.");
      validateSparseAccessor(accessor, path);
      return accessor;
    });
  }

  get decodedBytes(): number { return this.decoded; }
  reserve(bytes: number): void { this.decoded += bytes; budget(this.decoded, this.limits.maxDecodedBytes, "morph.decodedBytes"); }

  validateBase(value: unknown, type: "VEC3" | "VEC4", maximum: number, path: string): number {
    const layout = this.layout(value, type, type === "VEC3" ? 3 : 4, maximum, "vertex", path);
    this.scan(layout, type === "VEC3" ? 3 : 4);
    return layout.count;
  }

  readDelta(value: unknown, maximum: number, path: string): MorphAccessorData {
    const layout = this.layout(value, "VEC3", 3, maximum, "vertex", path);
    this.reserve(layout.count * 12);
    const values = new Float32Array(layout.count * 3);
    this.scan(layout, 3, values);
    return Object.freeze({ count: layout.count, values });
  }

  readScalar(value: unknown, maximum: number, path: string): MorphAccessorData {
    const layout = this.layout(value, "SCALAR", 1, maximum, "animation", path);
    this.reserve(layout.count * 4);
    const values = new Float32Array(layout.count);
    this.scan(layout, 1, values);
    return Object.freeze({ count: layout.count, values });
  }

  private layout(value: unknown, type: "SCALAR" | "VEC3" | "VEC4", width: number, maximum: number,
    usage: MorphAccessorUsage, path: string): MorphAccessorLayout {
    const index = reference(this.accessors, value, path), location = `accessors[${index}]`, accessor = this.accessors[index]!;
    if (accessor.componentType !== 5126 || accessor.type !== type) invalid(location, `Morph accessor must be FLOAT ${type}.`);
    if (accessor.normalized === true) invalid(`${location}.normalized`, "FLOAT morph accessors cannot be normalized.");
    for (const field of ["min", "max"] as const) if (accessor[field] !== undefined) vector(accessor[field], width, `${location}.${field}`);
    const count = integer(accessor.count, `${location}.count`, 1); budget(count, maximum, `${location}.count`);
    const offset = integer(accessor.byteOffset ?? 0, `${location}.byteOffset`);
    const view = accessor.bufferView === undefined ? undefined
      : this.views[reference(this.views, accessor.bufferView, `${location}.bufferView`)]!;
    const elementBytes = width * 4, stride = view?.stride ?? elementBytes;
    if (!view && (offset !== 0 || accessor.sparse === undefined)) {
      invalid(`${location}.bufferView`, "Morph accessor without a buffer view requires sparse storage and zero byteOffset.");
    }
    if (view && usage === "vertex" && view.target !== undefined && view.target !== 34962) invalid(location, "Buffer target conflicts with morph vertex usage.");
    if (view && usage === "animation" && view.target !== undefined) invalid(location, "Morph animation buffer views cannot declare a GPU target.");
    const prior = view ? this.usage.get(view) : undefined;
    if (prior !== undefined && prior !== usage) invalid(location, "A buffer view cannot mix morph vertex and animation data.");
    if (view && (offset % 4 !== 0 || view.offset % 4 !== 0 || stride < elementBytes || stride % 4 !== 0)) {
      invalid(location, "Morph accessor alignment or stride is invalid.");
    }
    if (view && offset + (count - 1) * stride + elementBytes > view.length) invalid(location, "Morph accessor exceeds its buffer view.");
    if (view) this.usage.set(view, usage);
    return { accessor, location, ...(view ? { view } : {}), count, offset, stride };
  }

  private scan(layout: MorphAccessorLayout, width: number, output?: Float32Array<ArrayBuffer>): void {
    const view = layout.view;
    for (let item = 0; view && item < layout.count; item += 1) for (let component = 0; component < width; component += 1) {
      if (component === 0 && (item & 0x3ff) === 0) this.signal?.throwIfAborted();
      const value = view.data.getFloat32(view.offset + layout.offset + item * layout.stride + component * 4, true);
      if (!Number.isFinite(value)) invalid(layout.location, "Morph accessor contains a non-finite value.");
      if (output) output[item * width + component] = value;
    }
    applySparseAccessor({ accessor: layout.accessor, location: layout.location, views: this.views,
      count: layout.count, width, componentSize: 4, ...(output ? { output } : {}),
      readValue: (data, position) => data.getFloat32(position, true), signal: this.signal });
  }
}
