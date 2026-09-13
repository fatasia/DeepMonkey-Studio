import type { GltfSkinImportConfiguration } from "./skinTypes.js";
import { budget, integer, invalid, list, noExtensions, object, reference, unsupported, vector, type JsonObject } from "./validation.js";

type SkinAccessorUsage = "vertex" | "inverse-bind";
interface SkinBufferView {
  readonly data: DataView;
  readonly offset: number;
  readonly length: number;
  readonly stride?: number;
  readonly target?: number;
}
interface AccessorLayout {
  readonly accessor: JsonObject;
  readonly location: string;
  readonly view: SkinBufferView;
  readonly count: number;
  readonly stride: number;
  readonly offset: number;
}
export interface SkinAttributeData<T extends Uint16Array<ArrayBuffer> | Float32Array<ArrayBuffer>> {
  readonly count: number;
  readonly values: T;
}

/** Strict skin accessor reader. Every returned typed array owns its backing ArrayBuffer. */
export class SkinAccessorReader {
  private readonly accessors: readonly JsonObject[];
  private readonly views: readonly SkinBufferView[];
  private readonly usage = new Map<SkinBufferView, SkinAccessorUsage>();
  private decoded = 0;

  constructor(document: JsonObject, buffers: readonly Uint8Array[], private readonly limits: GltfSkinImportConfiguration) {
    const declarations = list(document.buffers, "buffers", 1);
    if (declarations.length !== buffers.length) invalid("buffers", "Embedded skin buffers are missing or inconsistent.");
    const data = declarations.map((value, index) => {
      const path = `buffers[${index}]`, declaration = object(value, path), bytes = buffers[index];
      noExtensions(declaration, path);
      if (declaration.uri !== undefined) unsupported(`${path}.uri`, "external skin buffers");
      const length = integer(declaration.byteLength, `${path}.byteLength`, 1);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < length) invalid(path, "Embedded skin buffer is truncated.");
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
      if (stride !== undefined && (stride > 252 || stride % 4 !== 0)) invalid(`${path}.byteStride`, "Vertex byteStride must be a multiple of four in 4..252.");
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

  reserve(bytes: number, path: string): void {
    this.decoded += bytes;
    budget(this.decoded, this.limits.maxDecodedBytes, path);
  }

  readInverseBindMatrices(value: unknown, maximum: number, path: string): SkinAttributeData<Float32Array<ArrayBuffer>> {
    const layout = this.layout(value, "MAT4", 5126, 16, 4, maximum, "inverse-bind", path);
    this.assertNormalized(layout.accessor, false, layout.location);
    this.reserve(layout.count * 64, "skins.decodedBytes");
    const values = new Float32Array(layout.count * 16);
    this.copy(layout, 16, (position) => layout.view.data.getFloat32(position, true), values);
    for (let matrix = 0; matrix < layout.count; matrix += 1) {
      const base = matrix * 16;
      if (Math.abs(values[base + 3]!) > 1e-5 || Math.abs(values[base + 7]!) > 1e-5
        || Math.abs(values[base + 11]!) > 1e-5 || Math.abs(values[base + 15]! - 1) > 1e-5) {
        invalid(layout.location, "Inverse bind matrices must be affine.");
      }
    }
    return Object.freeze({ count: layout.count, values });
  }

  readJoints(value: unknown, maximum: number, path: string): SkinAttributeData<Uint16Array<ArrayBuffer>> {
    const { accessor, location } = this.accessor(value, path);
    if (accessor.type !== "VEC4" || (accessor.componentType !== 5121 && accessor.componentType !== 5123)) {
      invalid(location, "JOINTS_0 must be an unsigned byte or unsigned short VEC4 accessor.");
    }
    this.assertNormalized(accessor, false, location);
    const size = accessor.componentType === 5121 ? 1 : 2;
    const layout = this.layoutAt(accessor, location, 4, size, maximum, "vertex");
    this.reserve(layout.count * 8, "skins.decodedBytes");
    const values = new Uint16Array(layout.count * 4);
    this.copy(layout, 4, (position) => size === 1 ? layout.view.data.getUint8(position) : layout.view.data.getUint16(position, true), values);
    return Object.freeze({ count: layout.count, values });
  }

  readWeights(value: unknown, maximum: number, path: string): SkinAttributeData<Float32Array<ArrayBuffer>> {
    const { accessor, location } = this.accessor(value, path), component = accessor.componentType;
    if (accessor.type !== "VEC4" || (component !== 5126 && component !== 5121 && component !== 5123)) {
      invalid(location, "WEIGHTS_0 must be a FLOAT or normalized unsigned byte/short VEC4 accessor.");
    }
    this.assertNormalized(accessor, component !== 5126, location);
    const size = component === 5121 ? 1 : component === 5123 ? 2 : 4;
    const layout = this.layoutAt(accessor, location, 4, size, maximum, "vertex");
    this.reserve(layout.count * 16, "skins.decodedBytes");
    const values = new Float32Array(layout.count * 4), divisor = component === 5121 ? 255 : component === 5123 ? 65_535 : 1;
    this.copy(layout, 4, (position) => component === 5126 ? layout.view.data.getFloat32(position, true)
      : component === 5121 ? layout.view.data.getUint8(position) / divisor : layout.view.data.getUint16(position, true) / divisor, values);
    const tolerance = component === 5121 ? 4 / 255 + 1e-6 : component === 5123 ? 4 / 65_535 + 1e-6 : 1e-4;
    for (let vertex = 0; vertex < layout.count; vertex += 1) normalizeWeights(values, vertex * 4, tolerance, location);
    return Object.freeze({ count: layout.count, values });
  }

  validatePosition(value: unknown, maximum: number, path: string): number {
    const layout = this.layout(value, "VEC3", 5126, 3, 4, maximum, "vertex", path);
    this.assertNormalized(layout.accessor, false, layout.location);
    this.copy(layout, 3, (position) => layout.view.data.getFloat32(position, true));
    return layout.count;
  }

  private accessor(value: unknown, path: string): { accessor: JsonObject; location: string } {
    const index = reference(this.accessors, value, path);
    const accessor = this.accessors[index]!, location = `accessors[${index}]`;
    if (accessor.sparse !== undefined) unsupported(`${location}.sparse`, "sparse skin accessors");
    for (const field of ["min", "max"] as const) if (accessor[field] !== undefined) {
      vector(accessor[field], accessorWidth(accessor.type, `${location}.type`), `${location}.${field}`);
    }
    return { accessor, location };
  }

  private layout(value: unknown, type: string, component: number, width: number, size: number, maximum: number,
    usage: SkinAccessorUsage, path: string): AccessorLayout {
    const result = this.accessor(value, path);
    if (result.accessor.type !== type || result.accessor.componentType !== component) {
      invalid(result.location, `Accessor must be FLOAT ${type}.`);
    }
    return this.layoutAt(result.accessor, result.location, width, size, maximum, usage);
  }

  private layoutAt(accessor: JsonObject, location: string, width: number, size: number, maximum: number,
    usage: SkinAccessorUsage): AccessorLayout {
    const count = integer(accessor.count, `${location}.count`, 1);
    budget(count, maximum, `${location}.count`);
    const offset = integer(accessor.byteOffset ?? 0, `${location}.byteOffset`);
    const view = this.views[reference(this.views, accessor.bufferView, `${location}.bufferView`)]!;
    if (usage === "vertex" && view.target !== undefined && view.target !== 34962) invalid(location, "Buffer target conflicts with vertex attribute usage.");
    if (usage === "inverse-bind" && view.target !== undefined) invalid(location, "Inverse bind matrix buffer views cannot declare a GPU target.");
    const prior = this.usage.get(view);
    if (prior !== undefined && prior !== usage) invalid(location, "A buffer view cannot mix vertex attributes and inverse bind matrices.");
    const elementBytes = width * size, stride = view.stride ?? elementBytes;
    const absoluteOffset = view.offset + offset;
    if (offset % size !== 0 || absoluteOffset % size !== 0
      || (usage === "vertex" && (offset % 4 !== 0 || view.offset % 4 !== 0))
      || stride < elementBytes || stride % size !== 0) {
      invalid(location, "Accessor alignment or stride is invalid.");
    }
    if (offset + (count - 1) * stride + elementBytes > view.length) invalid(location, "Accessor exceeds its buffer view.");
    this.usage.set(view, usage);
    return { accessor, location, view, count, stride, offset };
  }

  private assertNormalized(accessor: JsonObject, expected: boolean, path: string): void {
    const normalized = accessor.normalized ?? false;
    if (normalized !== expected) invalid(`${path}.normalized`, expected ? "Integer weights must set normalized=true." : "Accessor must not be normalized.");
  }

  private copy(layout: AccessorLayout, width: number, read: (position: number) => number,
    output?: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>): void {
    const size = layout.accessor.componentType === 5121 ? 1 : layout.accessor.componentType === 5123 ? 2 : 4;
    for (let item = 0; item < layout.count; item += 1) for (let component = 0; component < width; component += 1) {
      const value = read(layout.view.offset + layout.offset + item * layout.stride + component * size);
      if (!Number.isFinite(value)) invalid(layout.location, "Accessor contains a non-finite value.");
      if (output) output[item * width + component] = value;
    }
  }
}

function normalizeWeights(values: Float32Array, offset: number, tolerance: number, path: string): void {
  const sum = values[offset]! + values[offset + 1]! + values[offset + 2]! + values[offset + 3]!;
  if (values[offset]! < 0 || values[offset + 1]! < 0 || values[offset + 2]! < 0 || values[offset + 3]! < 0
    || sum <= Number.EPSILON || Math.abs(sum - 1) > tolerance) {
    invalid(path, "Skin weights must be non-negative and normalized per vertex.");
  }
  const inverse = 1 / sum;
  for (let component = 0; component < 4; component += 1) values[offset + component] = values[offset + component]! * inverse;
}

function accessorWidth(value: unknown, path: string): number {
  const widths: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  if (typeof value !== "string" || widths[value] === undefined) invalid(path, "Accessor type is invalid.");
  return widths[value]!;
}
