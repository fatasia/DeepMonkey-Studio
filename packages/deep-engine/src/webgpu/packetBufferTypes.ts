import type { GeometryResource, PreparedBatch } from "../renderPacket.js";
import type { MeshBuffers } from "./meshBuffers.js";
import type { MaterialBinding } from "./materialBindings.js";
import type { TextureArrayMaterialTableRow } from "./textureArrayMaterialTable.js";

export interface CachedPacketGeometry {
  readonly source: GeometryResource;
  readonly mesh: MeshBuffers;
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

export interface CachedPacketBatch {
  readonly source: PreparedBatch;
  readonly buffer: GPUBuffer;
  readonly capacity: number;
  readonly previousBuffer: GPUBuffer;
  readonly previousCapacity: number;
  readonly previousTransforms: Float32Array<ArrayBuffer>;
  readonly material?: MaterialBinding;
  readonly arrayMaterial?: TextureArrayMaterialTableRow;
}
