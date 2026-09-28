import { applySourceMaterialOverrides, assertStaticMaterialOverrides, assertMaterialSlotsResolve } from "./sceneMaterialOverrides";
import { getSceneModelAssetId, type SceneModelState, type SceneSnapshot } from "@bim-studio/contracts";
import { prepareRenderPacket, type RenderPacket } from "@bim-studio/deep-engine";
import { invertAffineSceneMatrix, multiplySceneMatrices } from "@bim-studio/deep-engine/scene";
import { HLOD_PROXY_MATERIAL_ID, type HlodClusterStreamBinding } from "@bim-studio/deep-engine/three-bridge";
import { decodeTexturedGlb, type GltfImageDecoder } from "@bim-studio/deep-engine/gltf";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { sceneModelMatrixValues } from "./sceneModelMatrixValues";
import { sceneSnapshotToRenderPacket } from "./sceneSnapshotRenderPacket";
import { worldToLocal } from "./sceneLocalCoordinates";
import { createSceneGeometryPrecisionValidator } from "./sceneGeometryPrecision";
import { sceneHexToLinearRgb, staticSceneEffectEmissive, unsupportedStaticSceneEffectFields } from "./sceneNeutralAppearance";
import { compileSceneAuxiliaryGrid } from "./compileSceneAuxiliaryGrid";
import { readSceneModelMaterialState } from "./sceneAuthorMaterialState";
import { bindWebHlodAsset, type WebHlodPackage } from "./webHlodPackage";

export interface CompileSceneRenderOptions {
  readonly loadModel: (assetId: string, signal: AbortSignal) => Promise<Uint8Array>;
  readonly imageDecoder?: GltfImageDecoder;
  /** 宿主解压几何；原始文件仍用于来源哈希和读取预算。 */
  readonly normalizeModel?: (bytes: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>;
  readonly signal?: AbortSignal;
  readonly maxSourceBytes?: number;
  /** 已局部化运行空间中，作者世界原点的位置；辅助网格仍与 Three 的世界原点对齐。 */
  readonly auxiliaryGridOrigin?: { readonly x: number; readonly y: number; readonly z: number };
  /** Opt-in：assetId → 已校验 HLOD 包；提供即把簇代理几何与逐放置簇绑定随编译产出。 */
  readonly hlodPackages?: ReadonlyMap<string, WebHlodPackage>;
}
/** 单个折叠簇在某放置下的代理绘制（结构兼容 deep-engine HlodClusterProxyDraw）。 */
export interface SceneHlodProxyDraw {
  readonly instanceId: string;
  readonly geometryId: string;
  /** 作者世界 4x4 列主序（= 模型根变换；代理几何顶点在资产源空间）。 */
  readonly transform: readonly number[];
}
/** 逐放置（模型实例）簇绑定；manifest 树在资产源空间，决策相机经 decisionFromWorld 换算。 */
export interface SceneHlodClusterBinding extends HlodClusterStreamBinding {
  readonly assetId: string;
  readonly modelId: string;
}

export interface SceneRenderCompilation {
  readonly packet: RenderPacket;
  readonly objectBindings: readonly { nodeId: string; instanceIds: readonly string[] }[];
  readonly sourceBytes: number;
  readonly hlodClusters?: readonly SceneHlodClusterBinding[];
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
  const grid = compileSceneAuxiliaryGrid(scene.environment?.gridVisible === true, options.auxiliaryGridOrigin);
  const geometries = [...base.geometries, ...grid.geometries], materials = [...base.materials, ...grid.materials],
    instances = [...base.instances, ...grid.instances];
  // B4 opt-in:簇代理 overlay 批的合成材质;仅 hlodPackages 路径入包,与源材质去重。
  if (options.hlodPackages?.size && !materials.some(material => material.id === HLOD_PROXY_MATERIAL_ID)) {
    materials.push({ id: HLOD_PROXY_MATERIAL_ID, baseColor: [0.55, 0.55, 0.58], metallic: 0, roughness: 1 });
  }
  const textures: NonNullable<RenderPacket["textures"]>[number][] = [];
  const objectBindings = scene.primitives.map(item => ({ nodeId: item.modelId,
    instanceIds: item.visible ? base.instances.filter(instance => instance.id === item.modelId
      || instance.id.startsWith(`${item.modelId}/prefab/`)).map(instance => instance.id) : [] }));
  const assets = new Map<string, RenderPacket>();
  /** 资产级(源空间)叶绑定:manifest + apiId → 源包实例 id;共享资产只建一次。 */
  const assetHlodBindings = new Map<string, { readonly manifest: WebHlodPackage["manifest"];
    readonly sourceInstanceIdsByNode: ReadonlyMap<string, readonly string[]> }>();
  const hlodClusters: SceneHlodClusterBinding[] = [];
  const verifyGeometryPrecision = createSceneGeometryPrecisionValidator();
  const sourceGeometries = new Map<string, RenderPacket["geometries"][number]>();
  let sourceBytes = 0;
  for (const model of [...scene.models].sort((a, b) => compare(a.modelId, b.modelId))) {
    signal.throwIfAborted();
    if (!model.visible) { objectBindings.push({ nodeId: model.modelId, instanceIds: [] }); continue; }
    assertStaticModel(model);
    const root = sceneModelMatrixValues(model.transform, model.modelId), assetId = getSceneModelAssetId(model);
    let source = assets.get(assetId);
    if (!source) {
      const bytes = await options.loadModel(assetId, signal);
      signal.throwIfAborted();
      sourceBytes += bytes.byteLength;
      if (sourceBytes > maxBytes) throw new Error(`对象 ${model.modelId} 的模型资源超过场景预算`);
      const decodedBytes = options.normalizeModel ? await options.normalizeModel(Uint8Array.from(bytes), signal) : bytes;
      signal.throwIfAborted();
      if (decodedBytes.byteLength > maxBytes) throw new Error(`对象 ${model.modelId} 的解压模型超过场景预算`);
      source = await decodeTexturedGlb(Uint8Array.from(decodedBytes), options.imageDecoder, {
        resourcePrefix: `asset-${runtimeContentSha256(assetId)}`, signal,
      });
      signal.throwIfAborted();
      assets.set(assetId, source);
      geometries.push(...source.geometries); textures.push(...source.textures ?? []);
      for (const geometry of source.geometries) sourceGeometries.set(geometry.id, geometry);
      const hlod = options.hlodPackages?.get(assetId);
      if (hlod) {
        // B4 opt-in：簇代理几何随包分发；节点绑定在资产源包上建立（实例 id 为 asset 前缀），
        // 逐放置展开在下方模型循环完成（共享资产多放置各有根变换与决策逆）。
        const instanceIdsByNode = bindWebHlodAsset(decodedBytes, source, hlod.manifest);
        for (const proxy of hlod.proxies) {
          if (sourceGeometries.has(proxy.id)) throw new Error(`HLOD 簇代理几何与源包冲突：${proxy.id}`);
          geometries.push(proxy); sourceGeometries.set(proxy.id, proxy);
        }
        assetHlodBindings.set(assetId, { manifest: hlod.manifest, sourceInstanceIdsByNode: instanceIdsByNode });
      }
    }
    // Runtime compilation consumes the persisted author contract. It must not
    // read the live Three material through ViewerEngine, because WASM/Native
    // publication has no viewer instance.
    const authoredMaterial = readSceneModelMaterialState(scene, model.modelId);
    assertMaterialSlotsResolve(source.materials, authoredMaterial, model.modelId);
    const materialMap = new Map<string, string>(), prefix = `model-${runtimeContentSha256(model.modelId)}`;
    const color = model.colorOverride ? sceneHexToLinearRgb(model.colorOverride) : undefined;
    const effectEmissive = staticSceneEffectEmissive(model.effects);
    const effectColor = effectEmissive ? sceneHexToLinearRgb(effectEmissive.color) : undefined;
    // 发布查看器的 applyModelState 会显式应用实例透明度，包括 1。
    for (const material of source.materials) {
      const masked = material.alphaMode === "MASK";
      const blended = model.opacity < 0.999;
      if (masked && blended && (material.alphaCutoff ?? 0.5) > 0) {
        throw new Error(`对象 ${model.modelId} 的镂空材质与半透明叠加尚未适配`);
      }
      const id = `${prefix}/${material.id}`;
      materials.push({ ...applySourceMaterialOverrides({ ...material,
        ...(color ? { baseColor: color } : {}) }, authoredMaterial, model.modelId), id,
        ...(effectColor ? { emissiveFactor: effectColor,
          emissiveStrength: effectEmissive!.strength } : {}),
        baseColorAlpha: model.opacity, alphaMode: blended ? "BLEND" : masked ? "MASK" : "OPAQUE" });
      materialMap.set(material.id, id);
    }
    const instanceIds: string[] = [];
    for (const instance of source.instances) {
      const id = `${prefix}/${instance.id}`;
      const composed = multiplySceneMatrices(root, instance.transform);
      // GLB 内部变换与作者根变换合成后，再核对最终平移的 Float32 精度。
      worldToLocal({ x: composed[12], y: composed[13], z: composed[14] },
        { x: 0, y: 0, z: 0 }, `models[${model.modelId}].instances[${instance.id}].position`);
      const transform = new Float32Array(composed);
      const geometry = sourceGeometries.get(instance.geometry);
      if (!geometry) throw new Error(`对象 ${model.modelId} 缺少几何 ${instance.geometry}`);
      verifyGeometryPrecision(geometry, composed, `models[${model.modelId}].instances[${instance.id}]`);
      instances.push({ ...instance, id, transform, material: materialMap.get(instance.material)!,
        ...(model.effects?.outline ? { outline: true } : {}) });
      instanceIds.push(id);
    }
    objectBindings.push({ nodeId: model.modelId, instanceIds });
    // B4:逐放置簇绑定。manifest 树/代理几何在资产源空间;决策相机经根逆变换换算,
    // 代理绘制 = 根变换(顶点已在源空间,与源实例同一前缀规则展开)。
    const hlodBinding = assetHlodBindings.get(assetId);
    if (hlodBinding) {
      const inverse = invertAffineSceneMatrix(root);
      if (!inverse) throw new Error(`对象 ${model.modelId} 的簇级决策逆变换不可逆`);
      const modelPrefix = `${prefix}/`;
      const instanceIdsByNode = new Map<string, readonly string[]>();
      for (const [apiId, ids] of hlodBinding.sourceInstanceIdsByNode) {
        instanceIdsByNode.set(apiId, ids.map(id => `${modelPrefix}${id}`));
      }
      const proxyDrawsByNode = new Map<string, readonly SceneHlodProxyDraw[]>(
        hlodBinding.manifest.proxies.map(proxy => [proxy.nodeId, [{ instanceId: `${modelPrefix}hlod-cluster-proxy/${proxy.nodeId}`,
          geometryId: proxy.geometryId, transform: root }]]));
      hlodClusters.push({ assetId, modelId: model.modelId, manifest: hlodBinding.manifest,
        instanceIdsByNode, proxyDrawsByNode, decisionFromWorld: [...inverse] });
    }
  }
  signal.throwIfAborted();
  // 节点级拾取映射:compilation.objectBindings 保留"每个作者对象一条(不可见为空)"语义,
  // 供发布兼容与物理编译消费;进包的映射只保留非空绑定(包校验拒绝空 instanceIds)。
  const packetBindings = objectBindings.filter(binding => binding.instanceIds.length > 0)
    .map(binding => ({ nodeId: binding.nodeId, instanceIds: binding.instanceIds }));
  const packet: RenderPacket = { geometries, materials, instances,
    ...(packetBindings.length ? { objectBindings: packetBindings } : {}),
    ...(textures.length ? { textures } : {}) };
  prepareRenderPacket(packet);
  return { packet, objectBindings: objectBindings.sort((a, b) => compare(a.nodeId, b.nodeId)), sourceBytes,
    ...(hlodClusters.length ? { hlodClusters } : {}) };
}

function assertStaticModel(model: SceneModelState): void {
  if (!Number.isFinite(model.opacity) || model.opacity < 0 || model.opacity > 1) throw new Error(`对象 ${model.modelId} 的透明度无效`);
  if (model.colorOverride && !/^#[\da-f]{6}$/i.test(model.colorOverride)) throw new Error(`对象 ${model.modelId} 的颜色无效`);
  assertStaticMaterialOverrides(model.material, model.modelId);
  const activeEffects = unsupportedStaticSceneEffectFields(model.effects);
  if (activeEffects.length || model.prefab || model.rig || model.layers?.length || model.explosionFactor
    || model.robotPose && Object.keys(model.robotPose).length) {
    const fields = [...activeEffects, model.prefab ? "prefab" : undefined, model.rig ? "rig" : undefined,
      model.layers?.length ? "layers" : undefined, model.explosionFactor ? "explosionFactor" : undefined,
      model.robotPose && Object.keys(model.robotPose).length ? "robotPose" : undefined]
      .filter((value): value is string => value !== undefined);
    throw new Error(`对象 ${model.modelId} 的扩展外观需要模型适配：${fields.join(", ")}`);
  }
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
