import type { DeformationPose, DeformationSource } from "../deformation/types.js";
import type { GeometryResource, RenderPacket } from "../renderPacket.js";
import type { GpuMorphSource } from "../webgpu/gpuMorphTypes.js";
import type { SkinningSource } from "../webgpu/gpuSkinningTypes.js";
import { decodeRuntimeGltf, type DecodedRuntimeGlb, type RuntimeGlbImportOptions } from "./decodeRuntimeGlb.js";
import { decodeTexturedGltf, decodeTexturedGltfDocument } from "./decodeTexturedGltf.js";
import { parseGlb } from "./parseGlb.js";
import type { GltfImageDecoder } from "./textureTypes.js";
import { GltfImportError } from "./validation.js";

/** 静态 RenderPacket 无法自行驱动的 glTF 变形特性。 */
export type GltfDeformationFeature = "animations" | "skins" | "morphTargets";

/**
 * - `static`:资产不含任何变形特性,与 decodeTexturedGltf 完全等价(零额外开销)。
 * - `live`:几何带蒙皮/形变源与绑定姿态,instance.pose 指向各自姿态,由宿主逐帧提供姿态。
 * - `bind-pose`:变形特性被剥离,按绑定姿态/初始变换静态显示(宿主不提供逐帧姿态,或该资产超出可驱动子集)。
 */
export type DeformablePacketMode = "static" | "live" | "bind-pose";

export interface DeformablePacketOptions extends RuntimeGlbImportOptions {
  /** 宿主能逐帧提供姿态时为 true;否则变形资产降级为绑定姿态静态显示。 */
  readonly liveDeformation?: boolean;
}

export interface DeformablePacketGlb {
  readonly packet: RenderPacket;
  readonly mode: DeformablePacketMode;
  readonly features: readonly GltfDeformationFeature[];
  /** 请求 live 却降级为 bind-pose 时的原因(精确到不支持的特性)。 */
  readonly fallbackReason?: string;
}

/** 只读 JSON 判定变形特性,不触碰缓冲。 */
export function inspectGltfDeformationFeatures(json: unknown): readonly GltfDeformationFeature[] {
  const document = json as { readonly animations?: readonly unknown[]; readonly skins?: readonly unknown[];
    readonly meshes?: readonly { readonly primitives?: readonly { readonly targets?: unknown }[] }[] };
  const features: GltfDeformationFeature[] = [];
  if (document.animations?.length) features.push("animations");
  if (document.skins?.length) features.push("skins");
  if (document.meshes?.some(mesh => mesh.primitives?.some(primitive => primitive.targets !== undefined))) features.push("morphTargets");
  return features;
}

/**
 * 带纹理 GLB → RenderPacket,并对含骨骼/形变目标的资产提供可由宿主逐帧驱动的变形源。
 * 不含变形特性的资产走既有静态路径;不可驱动的子集只降级该资产,不会使整份导入失败。
 */
export async function decodeDeformablePacketGlb(bytes: Uint8Array, imageDecoder: GltfImageDecoder | undefined,
  options: DeformablePacketOptions = {}): Promise<DeformablePacketGlb> {
  options.signal?.throwIfAborted();
  const parsed = parseGlb(bytes), features = inspectGltfDeformationFeatures(parsed.json);
  if (!features.length) {
    return { packet: await decodeTexturedGltf(parsed.json, parsed.buffers, imageDecoder, options), mode: "static", features };
  }
  const drivable = features.includes("skins") || features.includes("morphTargets");
  let fallbackReason: string | undefined;
  if (options.liveDeformation === true && drivable) {
    try {
      const decoded = await decodeRuntimeGltf(parsed.json, parsed.buffers, imageDecoder, options);
      return { packet: attachRuntimeDeformation(decoded), mode: "live", features };
    } catch (error) {
      if (!(error instanceof GltfImportError) || error.code === "limit") throw error;
      fallbackReason = `${error.feature ?? error.path}: ${error.message}`;
    }
  }
  const packet = await decodeTexturedGltfDocument(parsed.json, parsed.buffers, imageDecoder, options, true);
  return { packet, mode: "bind-pose", features, ...(fallbackReason ? { fallbackReason } : {}) };
}

/** 稳定姿态 ID:每个带变形的 instance 一个独立姿态,与 instance.id 同名。 */
export function deformationPoseId(instanceId: string): string { return instanceId; }

/** 把运行时解码得到的蒙皮/形变源挂到静态包上;姿态初始化为绑定姿态(单位调色板/初始权重)。 */
export function attachRuntimeDeformation(decoded: DecodedRuntimeGlb): RenderPacket {
  const { packet } = decoded;
  const geometries = new Map<string, GeometryResource>(packet.geometries.map(geometry => [geometry.id, geometry]));
  const skinPrimitives = new Map(decoded.skinning.primitives.map(primitive => [primitive.id, primitive]));
  const morphPrimitives = new Map(decoded.morph.primitives.map(primitive => [primitive.id, primitive]));
  const sources = new Map<string, DeformationSource>();
  for (const id of new Set([...skinPrimitives.keys(), ...morphPrimitives.keys()])) {
    const geometry = geometries.get(id);
    if (!geometry) continue;
    const count = geometry.vertices.length / 6;
    const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
    for (let vertex = 0; vertex < count; vertex++) {
      positions.set(geometry.vertices.subarray(vertex * 6, vertex * 6 + 3), vertex * 3);
      normals.set(geometry.vertices.subarray(vertex * 6 + 3, vertex * 6 + 6), vertex * 3);
    }
    const skin = skinPrimitives.get(id), morph = morphPrimitives.get(id);
    const skinning: SkinningSource | undefined = skin ? { revision: 0, positions, normals,
      ...(geometry.tangents ? { tangents: geometry.tangents } : {}), joints: skin.joints, weights: skin.weights } : undefined;
    const morphing: GpuMorphSource | undefined = morph ? { revision: 0, primitive: morph, positions: skin ? positions.slice() : positions,
      normals: skin ? normals.slice() : normals, ...(geometry.tangents ? { tangents: geometry.tangents } : {}) } : undefined;
    sources.set(id, { id: `${id}/deform`, revision: 0, geometry: id, semantics: "three-r185",
      kind: morphing ? skinning ? "morph-skin" : "morph" : "skin",
      ...(morphing ? { morph: morphing } : {}), ...(skinning ? { skinning } : {}) });
  }
  if (!sources.size) return packet;
  const jointCounts = new Map(decoded.skinning.skins.map(skin => [skin.id, skin.joints.length]));
  const skinNodes = new Map<string, number>(), morphWeights = new Map<string, Float32Array<ArrayBuffer>>();
  for (const binding of decoded.skinning.bindings) for (const id of binding.primitiveIds) {
    skinNodes.set(`${binding.nodeId}|${id}`, jointCounts.get(binding.skinId) ?? 0);
  }
  for (const binding of decoded.morph.bindings) for (const id of binding.primitiveIds) {
    morphWeights.set(`${binding.nodeId}|${id}`, binding.initialWeights);
  }
  const nodeByInstance = new Map(decoded.instanceProjection.bindings.map(binding => [binding.id, binding.nodeId]));
  const poses: DeformationPose[] = [];
  const instances = packet.instances.map(instance => {
    const source = sources.get(instance.geometry);
    if (!source) return instance;
    const key = `${nodeByInstance.get(instance.id)}|${instance.geometry}`;
    const joints = skinNodes.get(key), weights = morphWeights.get(key);
    const id = deformationPoseId(instance.id);
    poses.push({ id, source: source.id, revision: 0,
      ...(source.morph ? { morphWeights: { revision: 0, values: (weights ?? new Float32Array(source.morph.primitive.targets.length)).slice() } } : {}),
      ...(source.skinning ? { palette: identityPalette(joints ?? 0) } : {}) });
    return { ...instance, pose: id };
  });
  return { ...packet, instances, deformation: { sources: [...sources.values()], poses } };
}

function identityPalette(jointCount: number): { revision: number; matrices: Float32Array<ArrayBuffer>; normalMatrices: Float32Array<ArrayBuffer> } {
  const matrices = new Float32Array(jointCount * 16), normalMatrices = new Float32Array(jointCount * 12);
  for (let joint = 0; joint < jointCount; joint++) {
    for (let axis = 0; axis < 4; axis++) matrices[joint * 16 + axis * 5] = 1;
    for (let row = 0; row < 3; row++) normalMatrices[joint * 12 + row * 4 + row] = 1;
  }
  return { revision: 0, matrices, normalMatrices };
}
