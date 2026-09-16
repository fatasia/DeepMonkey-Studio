import { integer, invalid, noExtensions, object, reference, type JsonObject } from "./validation.js";

export interface SparseBufferView {
  readonly data: DataView;
  readonly offset: number;
  readonly length: number;
  stride?: number;
  target?: number;
}

interface SparseApplyOptions<T extends Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>> {
  readonly accessor: JsonObject;
  readonly location: string;
  readonly views: readonly SparseBufferView[];
  readonly count: number;
  readonly width: number;
  readonly componentSize: number;
  /** Omit only when a caller needs validation without retaining expanded values. */
  readonly output?: T;
  readonly readValue: (view: DataView, byteOffset: number) => number;
  readonly signal: AbortSignal | undefined;
}

export function validateSparseAccessor(accessor: JsonObject, location: string): void {
  if (accessor.sparse === undefined) return;
  const path = `${location}.sparse`, sparse = object(accessor.sparse, path);
  noExtensions(sparse, path);
  const accessorCount = integer(accessor.count, `${location}.count`, 1);
  const count = integer(sparse.count, `${path}.count`, 1);
  if (count > accessorCount) invalid(`${path}.count`, "Sparse count exceeds accessor count.");
  const indicesPath = `${path}.indices`, indices = object(sparse.indices, indicesPath);
  noExtensions(indices, indicesPath);
  const componentType = integer(indices.componentType, `${indicesPath}.componentType`);
  if (componentType !== 5121 && componentType !== 5123 && componentType !== 5125) {
    invalid(`${indicesPath}.componentType`, "Sparse indices must use UNSIGNED_BYTE, UNSIGNED_SHORT, or UNSIGNED_INT.");
  }
  integer(indices.bufferView, `${indicesPath}.bufferView`);
  integer(indices.byteOffset ?? 0, `${indicesPath}.byteOffset`);
  const valuesPath = `${path}.values`, values = object(sparse.values, valuesPath);
  noExtensions(values, valuesPath);
  integer(values.bufferView, `${valuesPath}.bufferView`);
  integer(values.byteOffset ?? 0, `${valuesPath}.byteOffset`);
}

function sparseView(views: readonly SparseBufferView[], value: unknown, path: string): SparseBufferView {
  const view = views[reference(views, value, path)]!;
  if (view.stride !== undefined || view.target !== undefined) {
    invalid(path, "Sparse buffer views cannot declare byteStride or target.");
  }
  return view;
}

function assertRange(view: SparseBufferView, offset: number, length: number, alignment: number, path: string): void {
  if (offset % alignment || (view.offset + offset) % alignment) invalid(path, "Sparse data alignment is invalid.");
  if (!Number.isSafeInteger(length) || offset + length > view.length) invalid(path, "Sparse data exceeds its buffer view.");
}

function readIndex(view: DataView, offset: number, componentType: number): number {
  return componentType === 5121 ? view.getUint8(offset)
    : componentType === 5123 ? view.getUint16(offset, true) : view.getUint32(offset, true);
}

/** Applies a glTF sparse overlay only after all expanded-output allocation budgets have passed. */
export function applySparseAccessor<T extends Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>>(
  options: SparseApplyOptions<T>,
): void {
  if (options.accessor.sparse === undefined) return;
  const path = `${options.location}.sparse`, sparse = object(options.accessor.sparse, path);
  noExtensions(sparse, path);
  const count = integer(sparse.count, `${path}.count`, 1);
  if (count > options.count) invalid(`${path}.count`, "Sparse count exceeds accessor count.");

  const indicesPath = `${path}.indices`, indices = object(sparse.indices, indicesPath);
  noExtensions(indices, indicesPath);
  const indexType = integer(indices.componentType, `${indicesPath}.componentType`);
  if (indexType !== 5121 && indexType !== 5123 && indexType !== 5125) {
    invalid(`${indicesPath}.componentType`, "Sparse indices must use UNSIGNED_BYTE, UNSIGNED_SHORT, or UNSIGNED_INT.");
  }
  const indexSize = indexType === 5121 ? 1 : indexType === 5123 ? 2 : 4;
  const indexOffset = integer(indices.byteOffset ?? 0, `${indicesPath}.byteOffset`);
  const indexView = sparseView(options.views, indices.bufferView, `${indicesPath}.bufferView`);
  assertRange(indexView, indexOffset, count * indexSize, indexSize, indicesPath);

  const valuesPath = `${path}.values`, values = object(sparse.values, valuesPath);
  noExtensions(values, valuesPath);
  const valueOffset = integer(values.byteOffset ?? 0, `${valuesPath}.byteOffset`);
  const valueView = sparseView(options.views, values.bufferView, `${valuesPath}.bufferView`);
  assertRange(valueView, valueOffset, count * options.width * options.componentSize,
    options.componentSize, valuesPath);

  let previous = -1;
  for (let item = 0; item < count; item++) {
    if ((item & 0x3ff) === 0) options.signal?.throwIfAborted();
    const index = readIndex(indexView.data, indexView.offset + indexOffset + item * indexSize, indexType);
    if (index <= previous) invalid(indicesPath, "Sparse indices must be strictly increasing.");
    if (index >= options.count) invalid(indicesPath, "Sparse index exceeds accessor count.");
    previous = index;
    const source = valueView.offset + valueOffset + item * options.width * options.componentSize;
    for (let axis = 0; axis < options.width; axis++) {
      const decoded = options.readValue(valueView.data, source + axis * options.componentSize);
      if (!Number.isFinite(decoded)) invalid(valuesPath, "Sparse accessor contains a non-finite value.");
      if (options.output) options.output[index * options.width + axis] = decoded;
    }
  }
}
