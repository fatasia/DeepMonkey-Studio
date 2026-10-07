import { applySourceMaterialOverrides, assertStaticMaterialOverrides, assertMaterialSlotsResolve, sourceMaterialSlot } from "./sceneMaterialOverrides";
import { AuthorTextureResolver, authorTextureTransform, effectiveTextureState, ensureGeometryTangents,
  isSupportedAuthorTextureField, sceneHasAuthorTextureOverrides } from "./sceneTextureOverrides";
import { getSceneModelAssetId, type SceneMaterialState, type SceneModelState, type SceneSnapshot } from "@bim-studio/contracts";
import { prepareRenderPacketAsync, STOCK_MATERIAL_INSTANCE_OPTIONS, type RenderPacket } from "@bim-studio/deep-engine";
import { invertAffineSceneMatrix, multiplySceneMatrices } from "@bim-studio/deep-engine/scene";
import { HLOD_PROXY_MATERIAL_ID, type HlodClusterStreamBinding } from "@bim-studio/deep-engine/three-bridge";
import { decodeDeformablePacketGlb, GltfImportError, type DeformablePacketMode, type GltfDeformationFeature } from "@bim-studio/deep-engine/gltf";
import { capImageDimension, glbEmbeddedImageDimensions, textureDimensionCap } from "./textureBudget";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { sceneModelMatrixValues } from "./sceneModelMatrixValues";
import { sceneSnapshotToRenderPacket } from "./sceneSnapshotRenderPacket";
import { worldToLocal } from "./sceneLocalCoordinates";
import { createSceneGeometryPrecisionValidator } from "./sceneGeometryPrecision";
import { sceneHexToLinearRgb, staticSceneEffectEmissive, unsupportedStaticSceneEffectFields, appearanceUnsupportedError } from "./sceneNeutralAppearance";
import { compileSceneAuxiliaryGrid } from "./compileSceneAuxiliaryGrid";
import { readSceneModelMaterialState } from "./sceneAuthorMaterialState";
import { bindWebHlodAsset, type WebHlodPackage } from "./webHlodPackage";
import type { GltfImageDecoder } from "@bim-studio/deep-engine/gltf";
import { isAuthorModelNormalizationFailure, type AuthorModelDecoder } from "./authorModelDecode";

async function byteSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export interface CompileSceneRenderOptions {
  readonly loadModel: (assetId: string, signal: AbortSignal) => Promise<Uint8Array>;
  readonly imageDecoder?: GltfImageDecoder;
  /** 宿主解压几何；原始文件仍用于来源哈希和读取预算。 */
  readonly normalizeModel?: (bytes: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>;
  /** Browser author opt-in: host owns normalization and decoding of each unique asset. */
  readonly decodeModel?: AuthorModelDecoder;
  /**
   * 跨编译资产解码缓存:键为 `assetId:sha256(bytes)`,值为解码产物(几何/材质/
   * 变形,消费合同为只读)。同一资产在切换/刷新的重复编译间跳过整段 GLB 解码;
   * 命中键含内容哈希,资产字节任何变化都会自然失效。*/
  readonly decodedAssetCache?: {
    get(key: string): { decodedBytes: Uint8Array; decoded: Awaited<ReturnType<typeof decodeDeformablePacketGlb>> } | undefined;
    set(key: string, entry: { decodedBytes: Uint8Array; decoded: Awaited<ReturnType<typeof decodeDeformablePacketGlb>> }): void;
  };
  readonly signal?: AbortSignal;
  readonly maxSourceBytes?: number;
  /** 已局部化运行空间中，作者世界原点的位置；辅助网格仍与 Three 的世界原点对齐。 */
  readonly auxiliaryGridOrigin?: { readonly x: number; readonly y: number; readonly z: number };
  /** Opt-in：assetId → 已校验 HLOD 包；提供即把簇代理几何与逐放置簇绑定随编译产出。 */
  readonly hlodPackages?: ReadonlyMap<string, WebHlodPackage>;
  /**
   * 宿主逐帧提供蒙皮/形变姿态(编辑器 Deep WebGPU)时为 true:含骨骼/形变目标的模型带变形源进包。
   * 缺省按绑定姿态静态显示,不会因动画/蒙皮使整份场景编译失败。
   */
  readonly liveDeformation?: boolean;
  /** Browser advanced material capability; keeps untextured transmission/clearcoat lobes. */
  readonly advancedMaterials?: boolean;
  /** 每个资产的纹理解码总预算(字节);超出时按需降低该资产纹理边长。缺省不降采样。 */
  readonly textureBudgetBytes?: number;
  /**
   * 项目资源 URL → 贴图字节。提供(且提供 imageDecoder)时,作者贴图覆盖
   * (baseColor/normal/AO/roughness/metalness 五槽)进入 Deep 原生链;预算沿用
   * textureBudgetBytes 作为整场作者贴图预算,超限/格式不支持 fail-closed 回退投影
   * 路径。缺省保持独立发布包的严格语义(贴图 URL 仍按 SceneAppearanceUnsupported 拒绝)。
   */
  readonly loadTexture?: (url: string, signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;
  /** 引擎导入子集之外的资产只隐藏对应模型并经 skippedModels 报告,而不是使整份编译失败(仅编辑器切换使用)。 */
  readonly skipUndecodableModels?: boolean;
}
/** 作者贴图槽接线产物(可变局部;展开进材质后与 PbrMaterial 只读合同对齐)。 */
type AuthorTextureWiring = {
  baseColorTexture?: RenderPacket["materials"][number]["baseColorTexture"];
  metallicRoughnessTexture?: RenderPacket["materials"][number]["metallicRoughnessTexture"];
  normalTexture?: RenderPacket["materials"][number]["normalTexture"];
  occlusionTexture?: RenderPacket["materials"][number]["occlusionTexture"];
};

/** 因引擎无法导入而未进包的模型放置。 */
export interface SceneSkippedModel {
  readonly modelId: string;
  readonly assetId: string;
  readonly reason: string;
}
/** 按槽丢弃的作者法线贴图:切线基不可交付,对象仍以无凹凸渲染,损失如实披露。 */
export interface SceneTextureLoss {
  readonly modelId: string;
  readonly slot: "normal";
  readonly reason: string;
}
/** Source glTF material fallback, retained per author placement for visible diagnostics. */
export interface SceneMaterialLoss {
  readonly modelId: string;
  readonly assetId: string;
  readonly loss: NonNullable<RenderPacket["materialLosses"]>[number];
}
/** 含 glTF 动画/蒙皮/形变目标的放置,以及它在包内的呈现方式。 */
export interface SceneDeformedModel {
  readonly modelId: string;
  readonly assetId: string;
  readonly mode: Exclude<DeformablePacketMode, "static">;
  readonly features: readonly GltfDeformationFeature[];
  /** 请求 live 却降级为静态绑定姿态时的精确原因。 */
  readonly fallbackReason?: string;
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
  /** 含变形特性的模型放置;缺省 = 场景中没有。 */
  readonly deformedModels?: readonly SceneDeformedModel[];
  /** 被隐藏的不可导入模型(仅 skipUndecodableModels)。 */
  readonly skippedModels?: readonly SceneSkippedModel[];
  /** 按槽丢弃的作者法线贴图(切线基不可交付);缺省 = 无损失。 */
  readonly textureLosses?: readonly SceneTextureLoss[];
  readonly materialLosses?: readonly SceneMaterialLoss[];
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
  const assetDeformation = new Map<string, Omit<SceneDeformedModel, "modelId" | "assetId">>();
  const deformationSources: NonNullable<RenderPacket["deformation"]>["sources"][number][] = [];
  const deformationPoses: NonNullable<RenderPacket["deformation"]>["poses"][number][] = [];
  const posesByAsset = new Map<string, ReadonlyMap<string, NonNullable<RenderPacket["deformation"]>["poses"][number]>>();
  const deformedModels: SceneDeformedModel[] = [];
  const materialLosses: SceneMaterialLoss[] = [];
  const skippedAssets = new Map<string, string>(), skippedModels: SceneSkippedModel[] = [];
  const skipModel = (modelId: string, assetId: string): void => {
    objectBindings.push({ nodeId: modelId, instanceIds: [] });
    skippedModels.push({ modelId, assetId, reason: skippedAssets.get(assetId)! });
  };
  let sourceBytes = 0;
  // 作者贴图覆盖(loadTexture + imageDecoder 齐备才启用):budget 沿用 textureBudgetBytes
  // 作为整场作者贴图预算,超限按 SceneAppearanceUnsupported 回退宿主投影降级。
  const textureFields = options.loadTexture && options.imageDecoder ? isSupportedAuthorTextureField : undefined;
  const textureResolver = textureFields ? new AuthorTextureResolver({
    loadTexture: options.loadTexture!, imageDecoder: options.imageDecoder!,
  }, options.textureBudgetBytes, signal) : undefined;
  const textureLosses: SceneTextureLoss[] = [];
  /** 作者法线贴图的切线升级:几何被同一资产的多个放置共享,打包前统一替换。 */
  const upgradedGeometries = new Map<string, RenderPacket["geometries"][number]>();
  // 场景带作者贴图覆盖时,解码保留无源纹理基元的 UV 流(deep-engine preserveTexCoords)。
  const preserveTexCoords = textureFields !== undefined && sceneHasAuthorTextureOverrides(scene.models);
  /**
   * 作者贴图槽 → Deep 材质纹理槽。URL 解码进包(textureResolver),UV 变换按作者画布
   * 同一 three 矩阵口径拆解;法线贴图缺切线时按 GLB N5 先例生成,不可交付按槽丢弃并
   * 记 textureLosses(对象仍渲染,不拖垮整场编译)。
   */
  const wireAuthorTextures = async (modelId: string, asset: RenderPacket,
    material: RenderPacket["materials"][number],
    state: SceneMaterialState | undefined): Promise<AuthorTextureWiring> => {
    if (!state || !textureResolver) return {};
    const url = (value: string | undefined): string | undefined => value?.trim() ? value : undefined;
    const baseColorUrl = url(state.baseColorMapUrl), normalUrl = url(state.normalMapUrl);
    const occlusionUrl = url(state.ambientOcclusionMapUrl);
    const roughUrl = url(state.roughnessMapUrl), metalUrl = url(state.metalnessMapUrl);
    if (!baseColorUrl && !normalUrl && !occlusionUrl && !roughUrl && !metalUrl) return {};
    // 引擎在打包时对带纹理材质强制 UV0(validateGeometryFeatures);此处提前以
    // SceneAppearanceUnsupported 表达,让宿主走既有投影降级而非整场切换失败。
    for (const instance of asset.instances) {
      if (instance.material !== material.id) continue;
      if (!sourceGeometries.get(instance.geometry)?.uv0) {
        throw appearanceUnsupportedError(`对象 ${modelId} 的材质贴图需要 UV0(几何 ${instance.geometry} 缺失)`);
      }
    }
    const transform = authorTextureTransform(state);
    return {
      ...(baseColorUrl ? { baseColorTexture: { texture: await textureResolver.resolve(baseColorUrl, "baseColor"), ...transform } } : {}),
      ...(occlusionUrl ? { occlusionTexture: { texture: await textureResolver.resolve(occlusionUrl, "occlusion"),
        ...transform, strength: 1 } } : {}),
      ...(roughUrl || metalUrl ? { metallicRoughnessTexture: await wireMetallicRoughness(modelId, material, roughUrl, metalUrl, transform) } : {}),
      ...(normalUrl ? await wireNormalTexture(modelId, asset, material, normalUrl, transform, state) : {}),
    };
  };
  /** Deep 的 metallicRoughness 是单槽;源包已带组合贴图时作者单通道覆盖无法表达,如实降级。 */
  const wireMetallicRoughness = async (modelId: string, material: RenderPacket["materials"][number],
    roughUrl: string | undefined, metalUrl: string | undefined,
    transform: ReturnType<typeof authorTextureTransform>): Promise<AuthorTextureWiring["metallicRoughnessTexture"]> => {
    if (material.metallicRoughnessTexture) {
      throw appearanceUnsupportedError(`对象 ${modelId} 的源金属粗糙度贴图与作者粗糙度/金属度覆盖需要模型适配`);
    }
    return { texture: await textureResolver!.resolveMetallicRoughness(roughUrl, metalUrl), ...transform };
  };
  /** 法线贴图缺切线基时按 GLB N5 先例按槽丢弃并记 loss(对象仍渲染,不拖垮整场编译)。 */
  const wireNormalTexture = async (modelId: string, asset: RenderPacket,
    material: RenderPacket["materials"][number], normalUrl: string,
    transform: ReturnType<typeof authorTextureTransform>, state: SceneMaterialState): Promise<AuthorTextureWiring> => {
    let tangentFailure: string | undefined;
    for (const instance of asset.instances) {
      if (instance.material !== material.id) continue;
      const geometry = upgradedGeometries.get(instance.geometry) ?? sourceGeometries.get(instance.geometry)!;
      try {
        const upgraded = ensureGeometryTangents(geometry, `models[${modelId}].${instance.geometry}`);
        if (upgraded !== geometry) upgradedGeometries.set(instance.geometry, upgraded);
      } catch (error) {
        if (!(error instanceof GltfImportError)) throw error;
        tangentFailure = `${error.path}: ${error.message}`;
        break;
      }
    }
    if (tangentFailure !== undefined) { textureLosses.push({ modelId, slot: "normal", reason: tangentFailure }); return {}; }
    const normalScale = state.normalScale;
    if (normalScale !== undefined && (!Number.isFinite(normalScale) || normalScale < 0)) {
      throw new Error(`对象 ${modelId} 的法线强度必须为非负有限数值`);
    }
    return { normalTexture: { texture: await textureResolver!.resolve(normalUrl, "normal"), ...transform,
      ...(normalScale === undefined ? {} : { normalScale: Math.min(4, normalScale) }) } };
  };
  for (const model of [...scene.models].sort((a, b) => compare(a.modelId, b.modelId))) {
    signal.throwIfAborted();
    if (!model.visible) { objectBindings.push({ nodeId: model.modelId, instanceIds: [] }); continue; }
    assertStaticModel(model, textureFields);
    const root = sceneModelMatrixValues(model.transform, model.modelId), assetId = getSceneModelAssetId(model);
    if (skippedAssets.has(assetId)) { skipModel(model.modelId, assetId); continue; }
    let source = assets.get(assetId);
    if (!source) {
      const bytes = await options.loadModel(assetId, signal);
      signal.throwIfAborted();
      sourceBytes += bytes.byteLength;
      if (sourceBytes > maxBytes) throw new Error(`对象 ${model.modelId} 的模型资源超过场景预算`);
      let decodedBytes = !options.decodeModel && options.normalizeModel
        ? await options.normalizeModel(Uint8Array.from(bytes), signal) : bytes;
      signal.throwIfAborted();
      if (decodedBytes.byteLength > maxBytes) throw new Error(`对象 ${model.modelId} 的解压模型超过场景预算`);
      const cacheKey = options.decodedAssetCache ? `asset-${await byteSha256(bytes)}:${bytes.byteLength}` : undefined;
      const cache = options.decodedAssetCache;
      const cached = cacheKey && cache ? cache.get(cacheKey) : undefined;
      if (cached && cacheKey) {
        decodedBytes = cached.decodedBytes;
        source = cached.decoded.packet;
        if (cached.decoded.mode !== "static") {
          assetDeformation.set(assetId, { mode: cached.decoded.mode, features: cached.decoded.features,
            ...(cached.decoded.fallbackReason ? { fallbackReason: cached.decoded.fallbackReason } : {}) });
          deformationSources.push(...cached.decoded.packet.deformation?.sources ?? []);
          posesByAsset.set(assetId, new Map(cached.decoded.packet.deformation?.poses.map(pose => [pose.id, pose])));
        }
        geometries.push(...cached.decoded.packet.geometries); textures.push(...cached.decoded.packet.textures ?? []);
        for (const geometry of cached.decoded.packet.geometries) sourceGeometries.set(geometry.id, geometry);
        assets.set(assetId, cached.decoded.packet);
      }
      let decoded: Awaited<ReturnType<typeof decodeDeformablePacketGlb>> | undefined = cached?.decoded;
      try {
        if (!decoded && options.decodeModel) {
          const result = await options.decodeModel(bytes, {
            resourcePrefix: `asset-${runtimeContentSha256(assetId)}`, modelId: model.modelId, maxDecodedBytes: maxBytes,
            ...(options.textureBudgetBytes === undefined ? {} : { textureBudgetBytes: options.textureBudgetBytes }),
            ...(options.liveDeformation === true ? { liveDeformation: true } : {}),
            ...(options.advancedMaterials === true ? { advancedMaterials: true } : {}),
            ...(preserveTexCoords ? { preserveTexCoords: true } : {}),
          }, signal);
          decodedBytes = result.normalizedBytes;
          if (decodedBytes.byteLength > maxBytes) throw new Error(`对象 ${model.modelId} 的解压模型超过场景预算`);
          decoded = result.decoded;
        } else if (!decoded) {
        const glb = Uint8Array.from(decodedBytes);
        const cap = options.textureBudgetBytes === undefined || !options.imageDecoder ? undefined
          : textureDimensionCap(glbEmbeddedImageDimensions(glb), options.textureBudgetBytes);
        decoded = await decodeDeformablePacketGlb(glb, cap === undefined || !options.imageDecoder ? options.imageDecoder
          : capImageDimension(options.imageDecoder, cap), {
          resourcePrefix: `asset-${runtimeContentSha256(assetId)}`, signal,
          ...(options.liveDeformation === true ? { liveDeformation: true } : {}),
          ...(options.advancedMaterials === true ? { advancedMaterials: true } : {}),
          // 场景带作者贴图覆盖时,无源纹理基元保留既有 UV 流,作者贴图才能映射到几何。
          ...(preserveTexCoords ? { preserveTexCoords: true } : {}),
        });
        }
      } catch (error) {
        // 编辑器 Deep 切换:单个资产超出引擎导入子集只隐藏它并如实提示,不拖垮整份场景。
        if (options.skipUndecodableModels !== true || !(error instanceof GltfImportError)
          || isAuthorModelNormalizationFailure(error)) throw error;
        skippedAssets.set(assetId, `${error.path}: ${error.message}`);
        skipModel(model.modelId, assetId);
        continue;
      }
      signal.throwIfAborted();
      source = decoded.packet;
      assets.set(assetId, source);
      if (cacheKey && decoded && cache) cache.set(cacheKey, { decodedBytes, decoded });
      if (decoded.mode !== "static") {
        assetDeformation.set(assetId, { mode: decoded.mode, features: decoded.features,
          ...(decoded.fallbackReason ? { fallbackReason: decoded.fallbackReason } : {}) });
        deformationSources.push(...source.deformation?.sources ?? []);
        posesByAsset.set(assetId, new Map(source.deformation?.poses.map(pose => [pose.id, pose])));
      }
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
    for (const loss of source.materialLosses ?? []) materialLosses.push({ modelId: model.modelId, assetId, loss });
    assertMaterialSlotsResolve(source.materials, authoredMaterial, model.modelId);
    const materialMap = new Map<string, string>(), prefix = `model-${runtimeContentSha256(model.modelId)}`;
    const color = model.colorOverride ? sceneHexToLinearRgb(model.colorOverride) : undefined;
    const effectEmissive = staticSceneEffectEmissive(model.effects);
    const effectColor = effectEmissive ? sceneHexToLinearRgb(effectEmissive.color) : undefined;
    // 场景透明度与 Three sourceMaterialOpacity 同口径：倍率作用于源 alpha，
    // 默认值 1 保留导入玻璃/镂空材质的覆盖率及透明模式。
    for (const material of source.materials) {
      const masked = material.alphaMode === "MASK";
      const blended = model.opacity < 0.999;
      if (masked && blended && (material.alphaCutoff ?? 0.5) > 0) {
        throw new Error(`对象 ${model.modelId} 的镂空材质与半透明叠加尚未适配`);
      }
      const id = `${prefix}/${material.id}`;
      const textureSlotKey = sourceMaterialSlot(material.id);
      const textureWiring = textureResolver && authoredMaterial ? await wireAuthorTextures(model.modelId, source,
        material, effectiveTextureState(authoredMaterial,
          textureSlotKey === undefined ? undefined : authoredMaterial.slotOverrides?.[textureSlotKey]))
        : undefined;
      materials.push({ ...applySourceMaterialOverrides({ ...material,
        ...(color ? { baseColor: color } : {}) }, authoredMaterial, model.modelId, textureFields), id,
        ...(effectColor ? { emissiveFactor: effectColor,
          emissiveStrength: effectEmissive!.strength } : {}),
        baseColorAlpha: (material.baseColorAlpha ?? 1) * model.opacity,
        alphaMode: blended || material.alphaMode === "BLEND" ? "BLEND" : masked ? "MASK" : "OPAQUE",
        // exactOptionalPropertyTypes 会把可选属性展开加宽为 | undefined;按槽条件展开保持引擎合同的精确可选。
        ...(textureWiring?.baseColorTexture ? { baseColorTexture: textureWiring.baseColorTexture } : {}),
        ...(textureWiring?.normalTexture ? { normalTexture: textureWiring.normalTexture } : {}),
        ...(textureWiring?.occlusionTexture ? { occlusionTexture: textureWiring.occlusionTexture } : {}),
        ...(textureWiring?.metallicRoughnessTexture ? { metallicRoughnessTexture: textureWiring.metallicRoughnessTexture } : {}) });
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
      const pose = instance.pose === undefined ? undefined : posesByAsset.get(assetId)?.get(instance.pose);
      instances.push({ ...instance, id, transform, material: materialMap.get(instance.material)!,
        ...(pose ? { pose: id } : {}), ...(model.effects?.outline ? { outline: true } : {}) });
      if (pose) deformationPoses.push({ ...pose, id });
      instanceIds.push(id);
    }
    const deformed = assetDeformation.get(assetId);
    if (deformed) deformedModels.push({ modelId: model.modelId, assetId, ...deformed });
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
  // 作者法线贴图的切线升级落到共享几何(顶点流不变,仅附加切线);作者纹理统一入包,
  // 未被任何材质消费的条目由 prepareRenderPacket 过滤。
  for (let index = 0; index < geometries.length; index++) {
    const upgraded = upgradedGeometries.get(geometries[index]!.id);
    if (upgraded) geometries[index] = upgraded;
  }
  if (textureResolver) textures.push(...textureResolver.registered());
  // 节点级拾取映射:compilation.objectBindings 保留"每个作者对象一条(不可见为空)"语义,
  // 供发布兼容与物理编译消费;进包的映射只保留非空绑定(包校验拒绝空 instanceIds)。
  const packetBindings = objectBindings.filter(binding => binding.instanceIds.length > 0)
    .map(binding => ({ nodeId: binding.nodeId, instanceIds: binding.instanceIds }));
  const packet: RenderPacket = { geometries, materials, instances,
    ...(packetBindings.length ? { objectBindings: packetBindings } : {}),
    ...(textures.length ? { textures } : {}),
    ...(deformationPoses.length ? { deformation: { sources: deformationSources, poses: deformationPoses } } : {}) };
  // 与运行时包/GPU 上传同一实例 ABI(v5),非默认 IOR 的真实材质才不会在编译期被误拒。
  await prepareRenderPacketAsync(packet, STOCK_MATERIAL_INSTANCE_OPTIONS, signal);
  return { packet, objectBindings: objectBindings.sort((a, b) => compare(a.nodeId, b.nodeId)), sourceBytes,
    ...(hlodClusters.length ? { hlodClusters } : {}), ...(deformedModels.length ? { deformedModels } : {}),
    ...(skippedModels.length ? { skippedModels } : {}), ...(textureLosses.length ? { textureLosses } : {}),
    ...(materialLosses.length ? { materialLosses } : {}) };
}

function assertStaticModel(model: SceneModelState,
  acceptTextureField?: (key: string, value: unknown) => boolean): void {
  if (!Number.isFinite(model.opacity) || model.opacity < 0 || model.opacity > 1) throw new Error(`对象 ${model.modelId} 的透明度无效`);
  if (model.colorOverride && !/^#[\da-f]{6}$/i.test(model.colorOverride)) throw new Error(`对象 ${model.modelId} 的颜色无效`);
  assertStaticMaterialOverrides(model.material, model.modelId, acceptTextureField);
  const activeEffects = unsupportedStaticSceneEffectFields(model.effects);
  if (activeEffects.length || model.prefab || model.rig || model.layers?.length || model.explosionFactor
    || model.robotPose && Object.keys(model.robotPose).length) {
    const fields = [...activeEffects, model.prefab ? "prefab" : undefined, model.rig ? "rig" : undefined,
      model.layers?.length ? "layers" : undefined, model.explosionFactor ? "explosionFactor" : undefined,
      model.robotPose && Object.keys(model.robotPose).length ? "robotPose" : undefined]
      .filter((value): value is string => value !== undefined);
    throw appearanceUnsupportedError(`对象 ${model.modelId} 的扩展外观需要模型适配：${fields.join(", ")}`);
  }
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
