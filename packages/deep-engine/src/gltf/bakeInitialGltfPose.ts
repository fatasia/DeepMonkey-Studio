import type { GeometryResource, RenderPacket } from "../renderPacket.js";
import { cpuDeformMorphVertices, prepareMorphInput } from "../webgpu/gpuMorphPacking.js";
import { cpuDeformMorphSkinVertices, prepareMorphSkinningInput } from "../webgpu/gpuMorphSkinningPacking.js";
import { cpuSkinVertices, prepareSkinningInput } from "../webgpu/gpuSkinningPacking.js";
import { attachRuntimeDeformation } from "./decodeDeformablePacketGlb.js";
import type { DecodedRuntimeGlb, RuntimeGlbImportOptions } from "./decodeRuntimeGlb.js";
import { GltfRenderAnimationBridge } from "./renderAnimationBridge.js";
import { budget, invalid, MAX_BYTES } from "./validation.js";

/** Static hosts consume the authored initial shape, with both animation clips disabled. */
export function bakeInitialGltfPose(decoded: DecodedRuntimeGlb,
  options: Pick<RuntimeGlbImportOptions, "signal" | "maxDeformationBytes"> = {}): RenderPacket {
  options.signal?.throwIfAborted();
  const packet = attachRuntimeDeformation(decoded);
  if (!packet.deformation) return packet;
  const frame = new GltfRenderAnimationBridge(instanceSources(decoded), { instances: decoded.instanceProjection,
    selection: { transformClipId: null, morphClipId: null } }).frame;
  const nodeByInstance = new Map(decoded.instanceProjection.bindings.map(binding => [binding.id, binding.nodeId]));
  const sources = new Map(packet.deformation.sources.map(source => [source.id, source]));
  const poses = new Map(packet.deformation.poses.map(pose => [pose.id, pose]));
  const geometries = new Map(packet.geometries.map(geometry => [geometry.id, geometry]));
  const skins = new Map(frame.skinPalettes.map(skin => [skin.nodeId, skin]));
  const morphs = new Map(frame.morphWeights.map(morph => [morph.nodeId, morph]));
  // Account for retained output and the largest kernel working set before allocating it.
  let ownedBytes = decoded.decodedBytes, scratchBytes = 0;
  for (const source of sources.values()) {
    for (const input of [source.skinning, source.morph]) if (input) {
      ownedBytes += input.positions.byteLength + (input.normals?.byteLength ?? 0);
    }
  }
  for (const instance of packet.instances) {
    if (!instance.pose) continue;
    const source = sources.get(poses.get(instance.pose)!.source)!;
    const geometry = geometries.get(instance.geometry)!, vertices = geometry.vertices.length / 6;
    ownedBytes += geometry.vertices.byteLength + (geometry.tangents?.byteLength ?? 0);
    const targets = source.morph?.primitive.targets.length ?? 0;
    const joints = skins.get(nodeByInstance.get(instance.id)!)?.palette.matrices.length ?? 0;
    scratchBytes = Math.max(scratchBytes, vertices * (192 + targets * 48) + joints * 7);
  }
  budget(ownedBytes + scratchBytes, options.maxDeformationBytes ?? MAX_BYTES, "initialPose.decodedBytes");
  const baked: GeometryResource[] = [];
  const instances = packet.instances.map(instance => {
    options.signal?.throwIfAborted();
    if (!instance.pose) return instance;
    const source = sources.get(poses.get(instance.pose)!.source)!, geometry = geometries.get(instance.geometry)!;
    const node = nodeByInstance.get(instance.id)!;
    const skin = skins.get(node), morph = morphs.get(node);
    const primitiveId = nodePrimitiveId(instance.geometry, node);
    if (source.skinning && (!skin || !skin.primitiveIds.includes(primitiveId))) {
      invalid("initialPose.skin", `Missing initial skin palette for ${instance.id}.`);
    }
    if (source.morph && (!morph || !morph.primitiveIds.includes(primitiveId))) {
      invalid("initialPose.morph", `Missing initial morph weights for ${instance.id}.`);
    }
    const output = source.skinning
      ? source.morph
        ? cpuDeformMorphSkinVertices(prepareMorphSkinningInput(source.morph, source.skinning, morph!.weights, skin!.palette))
        : cpuSkinVertices(prepareSkinningInput(source.skinning, skin!.palette))
      : cpuDeformMorphVertices(prepareMorphInput(source.morph!, morph!.weights));
    const vertices = new Float32Array(geometry.vertices.length), count = vertices.length / 6, stride = output.length / count;
    const tangents = geometry.tangents ? new Float32Array(count * 4) : undefined;
    for (let vertex = 0; vertex < count; vertex++) {
      vertices.set(output.subarray(vertex * stride, vertex * stride + 3), vertex * 6);
      vertices.set(output.subarray(vertex * stride + 4, vertex * stride + 7), vertex * 6 + 3);
      tangents?.set(output.subarray(vertex * stride + 8, vertex * stride + 12), vertex * 4);
    }
    const id = `${instance.id}/initial-pose`;
    if (geometries.has(id)) invalid("initialPose.geometry", `Geometry identity collision: ${id}.`);
    baked.push({ ...geometry, id, vertices, ...(tangents ? { tangents } : {}) });
    const { pose: _pose, ...staticInstance } = instance;
    return { ...staticInstance, geometry: id };
  });
  options.signal?.throwIfAborted();
  const used = new Set(instances.map(instance => instance.geometry));
  const { deformation: _deformation, ...staticPacket } = packet;
  return { ...staticPacket, geometries: [...packet.geometries.filter(geometry => used.has(geometry.id)), ...baked], instances };
}

/** Bridge primitive identities describe poses; shared GLTF mesh storage can have several node poses. */
function instanceSources(decoded: DecodedRuntimeGlb): DecodedRuntimeGlb {
  const skinPrimitives = new Map(decoded.skinning.primitives.map(primitive => [primitive.id, primitive]));
  const morphPrimitives = new Map(decoded.morph.primitives.map(primitive => [primitive.id, primitive]));
  return { ...decoded,
    skinning: { ...decoded.skinning,
      bindings: decoded.skinning.bindings.map(binding => ({ ...binding,
        primitiveIds: binding.primitiveIds.map(id => nodePrimitiveId(id, binding.nodeId)) })),
      primitives: decoded.skinning.bindings.flatMap(binding => binding.primitiveIds.map(id => ({
        ...skinPrimitives.get(id)!, id: nodePrimitiveId(id, binding.nodeId) }))) },
    morph: { ...decoded.morph,
      bindings: decoded.morph.bindings.map(binding => ({ ...binding,
        primitiveIds: binding.primitiveIds.map(id => nodePrimitiveId(id, binding.nodeId)) })),
      primitives: decoded.morph.bindings.flatMap(binding => binding.primitiveIds.map(id => ({
        ...morphPrimitives.get(id)!, id: nodePrimitiveId(id, binding.nodeId) }))) },
  };
}
function nodePrimitiveId(primitiveId: string, nodeId: number): string { return `${primitiveId}/pose-node/${nodeId}`; }
