import type { GltfAnimationImportConfiguration } from "./animationTypes.js";
import { budget, integer, invalid, list, noExtensions, object, reference, unsupported, vector, type JsonObject } from "./validation.js";

interface AnimationBufferView {
  readonly data: DataView;
  readonly offset: number;
  readonly length: number;
  readonly stride?: number;
  readonly target?: number;
}

export interface FloatAccessorData {
  readonly count: number;
  readonly values: Float32Array<ArrayBuffer>;
}

/** Strict FLOAT-only accessor reader which always copies GLB bytes into owned arrays. */
export class AnimationAccessorReader {
  private readonly accessors: readonly JsonObject[];
  private readonly views: readonly AnimationBufferView[];
  private decoded = 0;

  constructor(document: JsonObject, buffers: readonly Uint8Array[], private readonly limits: GltfAnimationImportConfiguration) {
    const declarations = list(document.buffers, "buffers", 1);
    if (declarations.length !== buffers.length) invalid("buffers", "Embedded animation buffers are missing or inconsistent.");
    const data = declarations.map((value, index) => {
      const path = `buffers[${index}]`, declaration = object(value, path), bytes = buffers[index];
      noExtensions(declaration, path);
      if (declaration.uri !== undefined) unsupported(`${path}.uri`, "external animation buffers");
      const length = integer(declaration.byteLength, `${path}.byteLength`, 1);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < length) invalid(path, "Embedded animation buffer is truncated.");
      return new DataView(bytes.buffer, bytes.byteOffset, length);
    });
    this.views = list(document.bufferViews, "bufferViews", 250_000).map((value, index) => {
      const path = `bufferViews[${index}]`, view = object(value, path);
      noExtensions(view, path);
      const source = data[reference(data, view.buffer, `${path}.buffer`)]!;
      const offset = integer(view.byteOffset ?? 0, `${path}.byteOffset`);
      const length = integer(view.byteLength, `${path}.byteLength`, 1);
      if (offset + length > source.byteLength) invalid(path, "Buffer view exceeds the embedded buffer.");
      const stride = view.byteStride === undefined ? undefined : integer(view.byteStride, `${path}.byteStride`, 4);
      if (stride !== undefined && (stride > 252 || stride % 4 !== 0)) invalid(`${path}.byteStride`, "Animation byteStride must be a multiple of four in 4..252.");
      const target = view.target === undefined ? undefined : integer(view.target, `${path}.target`);
      if (target !== undefined && target !== 34962 && target !== 34963) invalid(`${path}.target`, "Unknown buffer target.");
      return { data: source, offset, length, ...(stride === undefined ? {} : { stride }), ...(target === undefined ? {} : { target }) };
    });
    this.accessors = list(document.accessors, "accessors", 250_000).map((value, index) => {
      const path = `accessors[${index}]`, accessor = object(value, path);
      noExtensions(accessor, path);
      if (accessor.normalized !== undefined && typeof accessor.normalized !== "boolean") invalid(`${path}.normalized`, "normalized must be boolean.");
      return accessor;
    });
  }

  get decodedBytes(): number { return this.decoded; }

  readFloat(value: unknown, expectedType: "SCALAR" | "VEC3" | "VEC4", maximumCount: number, path: string): FloatAccessorData {
    const index = reference(this.accessors, value, path), location = `accessors[${index}]`, accessor = this.accessors[index]!;
    if (accessor.sparse !== undefined) unsupported(`${location}.sparse`, "sparse animation accessors");
    if (accessor.componentType !== 5126 || accessor.type !== expectedType) invalid(location, `Animation accessor must be FLOAT ${expectedType}.`);
    if (accessor.normalized === true) invalid(`${location}.normalized`, "FLOAT animation accessors cannot be normalized.");
    const width = componentWidth(expectedType);
    for (const field of ["min", "max"] as const) if (accessor[field] !== undefined) vector(accessor[field], width, `${location}.${field}`);
    const count = integer(accessor.count, `${location}.count`, 1);
    budget(count, maximumCount, `${location}.count`);
    const offset = integer(accessor.byteOffset ?? 0, `${location}.byteOffset`);
    const view = this.views[reference(this.views, accessor.bufferView, `${location}.bufferView`)]!;
    if (view.target !== undefined) invalid(location, "Animation buffer views cannot declare a vertex or index target.");
    const elementBytes = width * 4, stride = view.stride ?? elementBytes;
    if (offset % 4 !== 0 || (view.offset + offset) % 4 !== 0 || stride < elementBytes || stride % 4 !== 0) invalid(location, "Animation accessor alignment or stride is invalid.");
    if (offset + (count - 1) * stride + elementBytes > view.length) invalid(location, "Animation accessor exceeds its buffer view.");
    this.decoded += count * elementBytes;
    budget(this.decoded, this.limits.maxDecodedBytes, "animations.decodedBytes");
    const values = new Float32Array(count * width);
    for (let item = 0; item < count; item += 1) for (let component = 0; component < width; component += 1) {
      const number = view.data.getFloat32(view.offset + offset + item * stride + component * 4, true);
      if (!Number.isFinite(number)) invalid(location, "Animation accessor contains a non-finite value.");
      values[item * width + component] = number;
    }
    return Object.freeze({ count, values });
  }
}

function componentWidth(type: unknown): number {
  if (type === "SCALAR") return 1;
  if (type === "VEC3") return 3;
  if (type === "VEC4") return 4;
  invalid("accessor.type", "Animation accessor type must be SCALAR, VEC3, or VEC4.");
}
