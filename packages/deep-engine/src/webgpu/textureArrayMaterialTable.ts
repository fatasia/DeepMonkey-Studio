import type { PreparedMaterialTextures } from "../renderPacket.js";
import { DEEP_PBR_MESH_V1_BYTE_SIZES } from "../shaderAbi/contract.js";
import type { DeviceSession } from "./deviceSession.js";
import { packMaterialParameters } from "./materialBindings.js";
import { uploadBuffer } from "./meshBuffers.js";

export const MATERIAL_ARRAY_INDEX_FLOATS = 8;
export const MATERIAL_ARRAY_INDICES_BYTES = MATERIAL_ARRAY_INDEX_FLOATS * Int32Array.BYTES_PER_ELEMENT;
export const MATERIAL_ARRAY_TABLE_ROW_BYTES = DEEP_PBR_MESH_V1_BYTE_SIZES.material + MATERIAL_ARRAY_INDICES_BYTES;
/** Legacy per-material array binding; the production shared table embeds indices at binding 10. */
export const MATERIAL_ARRAY_INDICES_BINDING = 13;

export interface TextureArrayMaterialTableSource {
  readonly textures: PreparedMaterialTextures;
  readonly arrayKey: string;
  readonly textureEntries: readonly GPUBindGroupEntry[];
  readonly layerIndices: readonly number[];
}

export interface TextureArrayMaterialTableRow {
  readonly group: GPUBindGroup;
  /** Packed into instance material flags bits 10..23; low 10 bits retain material flags. */
  readonly materialRow: number;
  readonly arrayKey: string;
  /** Borrowed entries/buffers used to compose the deformation group with bindings 11/12. */
  readonly textureEntries: readonly GPUBindGroupEntry[];
  readonly table: GPUBuffer;
}

export interface TextureArrayMaterialTable {
  readonly table: GPUBuffer;
  readonly rowStride: number;
  readonly rows: readonly TextureArrayMaterialTableRow[];
  readonly groupCount: number;
  dispose(): void;
}

/** Production shared-table layout; 11/12 remain available to deformation. */
export function textureArrayMaterialTableLayoutEntries(): readonly GPUBindGroupLayoutEntry[] {
  const fragment = GPUShaderStage.FRAGMENT;
  const texture = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: fragment,
    texture: { sampleType: "float", viewDimension: "2d-array" } });
  const sampler = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: fragment, sampler: {} });
  return [
    texture(0), texture(1), texture(2), texture(3), texture(4),
    sampler(5), sampler(6), sampler(7), sampler(8), sampler(9),
    { binding: 10, visibility: fragment, buffer: { type: "read-only-storage",
      minBindingSize: MATERIAL_ARRAY_TABLE_ROW_BYTES } },
  ];
}

export function createTextureArrayMaterialTableLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({ label: "Deep shared texture-array material table",
    entries: textureArrayMaterialTableLayoutEntries() });
}

/**
 * Packs all material parameter/index rows into one tightly indexed GPU storage buffer. Bind groups
 * are interned by array combination; the instance material flags select a row without rebinding.
 */
export function createTextureArrayMaterialTable(session: DeviceSession, layout: GPUBindGroupLayout,
  sources: readonly TextureArrayMaterialTableSource[]): TextureArrayMaterialTable {
  if (!sources.length) throw new Error("Texture-array material table requires at least one row.");
  const rowStride = MATERIAL_ARRAY_TABLE_ROW_BYTES;
  const tableBytes = new Uint8Array(rowStride * sources.length);
  sources.forEach((source, row) => {
    if (source.layerIndices.length !== 8 || source.layerIndices.some(value => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Texture-array material row ${row} requires eight nonnegative integer layer indices.`);
    }
    const parameters = packMaterialParameters(source.textures);
    tableBytes.set(new Uint8Array(parameters.buffer, parameters.byteOffset, parameters.byteLength), row * rowStride);
    const indices = new Uint32Array(source.layerIndices);
    tableBytes.set(new Uint8Array(indices.buffer), row * rowStride + DEEP_PBR_MESH_V1_BYTE_SIZES.material);
  });
  const table = uploadBuffer(session, "Deep shared material table",
    new Uint32Array(tableBytes.buffer), GPUBufferUsage.STORAGE);
  try {
    const groups = new Map<string, GPUBindGroup>();
    const rows = sources.map((source, row): TextureArrayMaterialTableRow => {
      let group = groups.get(source.arrayKey);
      if (!group) {
        group = session.device.createBindGroup({ label: "Deep shared texture-array material group", layout,
          entries: [...source.textureEntries,
            { binding: 10, resource: { buffer: table } }] });
        groups.set(source.arrayKey, group);
      }
      return Object.freeze({ group, arrayKey: source.arrayKey, textureEntries: source.textureEntries,
        table, materialRow: row });
    });
    let disposed = false;
    return Object.freeze({ table, rowStride,
      rows: Object.freeze(rows), groupCount: groups.size,
      dispose(): void {
        if (disposed) return;
        disposed = true;
        session.release(table);
      } });
  } catch (error) {
    session.release(table);
    throw error;
  }
}
