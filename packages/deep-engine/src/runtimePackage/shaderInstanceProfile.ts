import type { PreparedBatch } from "../renderPacketTypes.js";
import { DEEP_PBR_MESH_V2, DEEP_PBR_MESH_V3 } from "../shaderAbi/index.js";

export interface ShaderPackageInstanceStream {
  readonly shaderAbi: "deep.pbr.mesh.v2" | "deep.pbr.mesh.v3";
  readonly arrayStride: number;
  readonly data: Float32Array<ArrayBuffer>;
  readonly instanceIds: readonly string[];
}

/** CPU binding adapter only; no upload/draw is implied. v2 retains its original stream byte-for-byte. */
export function prepareShaderPackageInstanceStream(
  batch: Pick<PreparedBatch, "data" | "count" | "instanceIds">,
  shaderAbi: ShaderPackageInstanceStream["shaderAbi"],
  objectIds?: ReadonlyMap<string, number>,
): ShaderPackageInstanceStream {
  if (shaderAbi !== "deep.pbr.mesh.v2" && shaderAbi !== "deep.pbr.mesh.v3") throw new Error("Unsupported shader instance ABI.");
  const v2 = DEEP_PBR_MESH_V2.vertexStreams.find(stream => stream.id === "instance")!;
  const sourceFloats = v2.arrayStride / Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(batch.count) || batch.count < 0 || batch.count > 16_384
    || batch.data.length !== batch.count * sourceFloats || batch.instanceIds.length !== batch.count
    || new Set(batch.instanceIds).size !== batch.count || !batch.instanceIds.every(id => typeof id === "string" && id.length > 0)
    || !batch.data.every(Number.isFinite)) throw new Error("Shader instance stream has invalid count, identity or v2 stride.");
  if (shaderAbi === "deep.pbr.mesh.v2") return { shaderAbi, arrayStride: v2.arrayStride,
    data: batch.data, instanceIds: batch.instanceIds };
  const v3 = DEEP_PBR_MESH_V3.vertexStreams.find(stream => stream.id === "instance")!;
  const idAttribute = v3.attributes.find(attribute => attribute.semantic === "OBJECT_ID_RGBA8")!;
  const destinationFloats = v3.arrayStride / Float32Array.BYTES_PER_ELEMENT;
  const idOffset = idAttribute.byteOffset / Float32Array.BYTES_PER_ELEMENT;
  const ids = batch.instanceIds.map(instanceId => {
    const id = objectIds?.get(instanceId);
    if (!Number.isSafeInteger(id) || id! < 1 || id! > 0xffff_ffff) {
      throw new Error(`v3 instance ${instanceId} requires a nonzero uint32 object-id mapping.`);
    }
    return id!;
  });
  const data = new Float32Array(batch.count * destinationFloats);
  for (let row = 0; row < batch.count; row++) {
    const target = row * destinationFloats;
    data.set(batch.data.subarray(row * sourceFloats, (row + 1) * sourceFloats), target);
    for (let channel = 0; channel < 4; channel++) data[target + idOffset + channel] = ((ids[row]! >>> (channel * 8)) & 255) / 255;
  }
  return { shaderAbi, arrayStride: v3.arrayStride, data, instanceIds: batch.instanceIds };
}
