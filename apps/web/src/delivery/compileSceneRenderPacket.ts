import { getSceneModelAssetId, type SceneModelState, type SceneSnapshot } from "@bim-studio/contracts";
import { prepareRenderPacket, type RenderPacket } from "@bim-studio/deep-engine";
import { decodeTexturedGlb, type GltfImageDecoder } from "@bim-studio/deep-engine/gltf";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { Color, Matrix4 } from "three";
import { sceneModelMatrix } from "./sceneModelMatrix";
import { sceneSnapshotToRenderPacket } from "./sceneSnapshotRenderPacket";
import { worldToLocal } from "./sceneLocalCoordinates";
import { createSceneGeometryPrecisionValidator } from "./sceneGeometryPrecision";

export interface CompileSceneRenderOptions {
  readonly loadModel: (assetId: string, signal: AbortSignal) => Promise<Uint8Array>;
  readonly imageDecoder?: GltfImageDecoder;
  readonly signal?: AbortSignal;
  readonly maxSourceBytes?: number;
}
export interface SceneRenderCompilation {
  readonly packet: RenderPacket;
  readonly objectBindings: readonly { nodeId: string; instanceIds: readonly string[] }[];
  readonly sourceBytes: number;
}

/** 将已保存快照和宿主提供的 GLB 转成静态绘制数据，不访问编辑器当前 GPU 状态。 */
export async function compileSceneRenderPacket(input: SceneSnapshot,
  options: CompileSceneRenderOptions): Promise<SceneRenderCompilation> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const scene = structuredClone(input), maxBytes = options.maxSourceBytes ?? 256 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024) {
    throw new Error("场景源资源预算必须为 1..268435456 字节");
  }
  const ids = new Set<string>();
  for (const item of [...scene.primitives, ...scene.models]) {
    if (!item.modelId || ids.has(item.modelId)) throw new Error(`重复或缺少对象 ID：${item.modelId}`);
    ids.add(item.modelId);
  }
  const base = sceneSnapshotToRenderPacket({ ...scene, models: [] });
  const geometries = [...base.geometries], materials = [...base.materials], instances = [...base.instances];
  const textures: NonNullable<RenderPacket["textures"]>[number][] = [];
  const objectBindings = scene.primitives.map(item => ({ nodeId: item.modelId,
    instanceIds: item.visible ? [item.modelId] : [] }));
  const assets = new Map<string, RenderPacket>();
  const verifyGeometryPrecision = createSceneGeometryPrecisionValidator();
  const sourceGeometries = new Map<string, RenderPacket["geometries"][number]>();
  let sourceBytes = 0;
  for (const model of [...scene.models].sort((a, b) => compare(a.modelId, b.modelId))) {
    signal.throwIfAborted();
    if (!model.visible) { objectBindings.push({ nodeId: model.modelId, instanceIds: [] }); continue; }
    assertStaticModel(model);
    const root = sceneModelMatrix(model.transform, model.modelId), assetId = getSceneModelAssetId(model);
    let source = assets.get(assetId);
    if (!source) {
      const bytes = await options.loadModel(assetId, signal);
      signal.throwIfAborted();
      sourceBytes += bytes.byteLength;
      if (sourceBytes > maxBytes) throw new Error(`对象 ${model.modelId} 的模型资源超过场景预算`);
      source = await decodeTexturedGlb(Uint8Array.from(bytes), options.imageDecoder, {
        resourcePrefix: `asset-${runtimeContentSha256(assetId)}`, signal,
      });
      signal.throwIfAborted();
      assets.set(assetId, source);
      geometries.push(...source.geometries); textures.push(...source.textures ?? []);
      for (const geometry of source.geometries) sourceGeometries.set(geometry.id, geometry);
    }
    const materialMap = new Map<string, string>(), prefix = `model-${runtimeContentSha256(model.modelId)}`;
    const color = model.colorOverride ? new Color(model.colorOverride) : undefined;
    // 发布查看器的 applyModelState 会显式应用实例透明度，包括 1。
    for (const material of source.materials) {
      const masked = material.alphaMode === "MASK";
      const blended = model.opacity < 0.999;
      if (masked && blended && (material.alphaCutoff ?? 0.5) > 0) {
        throw new Error(`对象 ${model.modelId} 的镂空材质与半透明叠加尚未适配`);
      }
      const id = `${prefix}/${material.id}`;
      materials.push({ ...material, id, ...(color ? { baseColor: [color.r, color.g, color.b] as const } : {}),
        baseColorAlpha: model.opacity, alphaMode: blended ? "BLEND" : masked ? "MASK" : "OPAQUE" });
      materialMap.set(material.id, id);
    }
    const instanceIds: string[] = [];
    for (const instance of source.instances) {
      const id = `${prefix}/${instance.id}`;
      const composed = new Matrix4().multiplyMatrices(root, new Matrix4().fromArray(Array.from(instance.transform)));
      // GLB 内部变换与作者根变换合成后，再核对最终平移的 Float32 精度。
      worldToLocal({ x: composed.elements[12]!, y: composed.elements[13]!, z: composed.elements[14]! },
        { x: 0, y: 0, z: 0 }, `models[${model.modelId}].instances[${instance.id}].position`);
      const transform = new Float32Array(composed.elements);
      const geometry = sourceGeometries.get(instance.geometry);
      if (!geometry) throw new Error(`对象 ${model.modelId} 缺少几何 ${instance.geometry}`);
      verifyGeometryPrecision(geometry, composed.elements, `models[${model.modelId}].instances[${instance.id}]`);
      instances.push({ ...instance, id, transform, material: materialMap.get(instance.material)! });
      instanceIds.push(id);
    }
    objectBindings.push({ nodeId: model.modelId, instanceIds });
  }
  signal.throwIfAborted();
  const packet: RenderPacket = { geometries, materials, instances, ...(textures.length ? { textures } : {}) };
  prepareRenderPacket(packet);
  return { packet, objectBindings: objectBindings.sort((a, b) => compare(a.nodeId, b.nodeId)), sourceBytes };
}

function assertStaticModel(model: SceneModelState): void {
  if (!Number.isFinite(model.opacity) || model.opacity < 0 || model.opacity > 1) throw new Error(`对象 ${model.modelId} 的透明度无效`);
  if (model.colorOverride && !/^#[\da-f]{6}$/i.test(model.colorOverride)) throw new Error(`对象 ${model.modelId} 的颜色无效`);
  if (model.material || model.effects || model.prefab || model.rig || model.layers?.length || model.explosionFactor
    || model.robotPose && Object.keys(model.robotPose).length) {
    throw new Error(`对象 ${model.modelId} 的扩展外观需要模型适配`);
  }
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
