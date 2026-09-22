import { materialStateForSlot, restoreMaterialSourceColors } from "./materialSlots";
import { materialIor, prepareMaterialIor } from "./materialIor";
import * as THREE from "three";
import type { SceneLayerState, SceneMaterialScreenState, SceneMaterialShaderEffect, SceneMaterialState } from "@bim-studio/contracts";
import { buildComponentRecords, type ComponentRecord } from "./analysis";
import { fragmentPropertyValue } from "./fragmentTree";
import { detachSharedPrimitiveMaterials } from "./primitiveMaterial";
import { applySourceMaterialOpacity } from "./sourceMaterialOpacity";
import type { MaterialTextureMetadataKey, MaterialTextureSlot } from "./viewerEngineTypes";
import {
  applyMaterialTextureTransform,
  hasMaterialTextureTransformPatch,
  materialTextureTransformState,
  readMaterialTextureTransform,
  resolveMaterialTextureTransform,
  writeMaterialTextureTransform,
} from "./materialTextureTransform";
import {
  createModelScreenVideoTexture,
  disposeModelScreenTexture,
  isModelScreenTexture,
  markModelScreenImageTexture,
  modelScreenSourceUrl,
  normalizeModelScreenState,
  updateModelScreenVideo,
} from "./modelScreenTexture";
import { ViewerEngineRuntime } from "./viewerEngineRuntime";

/** 构件索引与材质状态管理；指针层只处理命中和交互分发。 */
export abstract class ViewerEngineObjectState extends ViewerEngineRuntime {
  protected rebuildComponentIndex(modelId: string): void {
    const model = this.models.get(modelId);
    const objects = this.layerObjects.get(modelId);
    if (!model || !objects) return;
    const fragmentEntries = this.fragmentLayers.get(modelId);
    if (fragmentEntries) {
      const records: ComponentRecord[] = [];
      for (const [nodeId, entry] of fragmentEntries) {
        if (nodeId === "root") continue;
        const properties = { ...entry.properties };
        const level = fragmentPropertyValue(properties, ["Level", "LevelName", "Storey", "楼层"]);
        const category = entry.node.type;
        const stableSource = fragmentPropertyValue(properties, ["GlobalId", "GUID", "Id"]) || entry.localId || nodeId;
        const searchText = [model.name, entry.node.name, nodeId, category, level, ...Object.entries(properties).flat()]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase("zh-CN");
        records.push({
          id: nodeId,
          stableId: `${modelId}:${stableSource}`,
          modelId,
          modelName: model.name,
          name: entry.node.name,
          type: entry.node.type,
          path: nodeId,
          ...(level ? { level } : {}),
          ...(category ? { category } : {}),
          properties,
          searchText,
        });
      }
      this.componentRecords.set(modelId, records);
      return;
    }
    this.componentRecords.set(modelId, buildComponentRecords(modelId, model.name, objects));
  }

  protected componentRecord(modelId: string, nodeId: string): ComponentRecord | undefined {
    return this.componentRecords.get(modelId)?.find((record) => record.id === nodeId);
  }

  protected focusObject(object: THREE.Object3D): void {
    this.focusBox(new THREE.Box3().setFromObject(object));
  }

  protected updateLayerState(modelId: string, nodeId: string, patch: Omit<SceneLayerState, "nodeId">): void {
    let states = this.layerStates.get(modelId);
    if (!states) {
      states = new Map();
      this.layerStates.set(modelId, states);
    }
    const current = states.get(nodeId) ?? { nodeId };
    states.set(nodeId, { ...current, ...structuredClone(patch), nodeId });
  }

  protected materialsForMesh(mesh: THREE.Mesh): THREE.Material[] {
    const source = this.collisionOriginalMaterials.get(mesh) ?? mesh.material;
    return Array.isArray(source) ? source : source ? [source] : [];
  }

  protected setObjectOpacity(object: THREE.Object3D, opacity: number): void {
    detachSharedPrimitiveMaterials(object, this.collisionOriginalMaterials);
    object.traverse((child) => {
      for (const material of this.materialsForMesh(child as THREE.Mesh)) {
        applySourceMaterialOpacity(material, opacity);
      }
    });
  }

  protected setObjectColor(object: THREE.Object3D, color: string): void {
    detachSharedPrimitiveMaterials(object, this.collisionOriginalMaterials);
    object.traverse((child) => {
      for (const source of this.materialsForMesh(child as THREE.Mesh)) {
        const material = source as THREE.Material & { color?: THREE.Color };
        if (!material.color?.isColor) continue;
        material.color.set(color);
        material.needsUpdate = true;
      }
    });
  }

  protected getMaterialState(object: THREE.Object3D): SceneMaterialState {
    let result: SceneMaterialState = {};
    object.traverse((child) => {
      if (Object.keys(result).length) return;
      const material = this.materialsForMesh(child as THREE.Mesh)[0] as THREE.MeshStandardMaterial | undefined;
      if (!material) return;
      result = {
        ...(material.color?.isColor ? { color: `#${material.color.getHexString()}` } : {}),
        ...materialColorAdjustmentState(material),
        ...materialTextureState(material),
        ...(material.userData.studioShaderEffect ? { shaderEffect: structuredClone(material.userData.studioShaderEffect) } : {}),
        ...(material.normalScale?.isVector2 ? { normalScale: material.normalScale.x } : {}),
        ...(typeof material.roughness === "number" ? { roughness: material.roughness } : {}),
        ...(typeof material.metalness === "number" ? { metalness: material.metalness } : {}),
        ...(materialIor(material) === undefined ? {} : { ior: materialIor(material)! }),
        ...(material.emissive?.isColor
          ? { emissive: `#${material.emissive.getHexString()}`, emissiveIntensity: material.emissiveIntensity }
          : {}),
        ...(typeof material.wireframe === "boolean" ? { wireframe: material.wireframe } : {}),
        doubleSided: material.side === THREE.DoubleSide,
      };
    });
    return result;
  }

  protected applyMaterialState(object: THREE.Object3D, patch: SceneMaterialState): void {
    detachSharedPrimitiveMaterials(object, this.collisionOriginalMaterials);
    prepareMaterialIor(object, patch, this.collisionOriginalMaterials, (source, target) => {
      const textures = this.originalMaterialTextures.get(source);
      if (textures) this.originalMaterialTextures.set(target, textures);
      const screen = this.modelScreenOriginals.get(source);
      if (screen) this.modelScreenOriginals.set(target, screen);
    });
    object.traverse((child) => {
      for (const source of this.materialsForMesh(child as THREE.Mesh)) {
        const material = source as THREE.MeshStandardMaterial;
        const state = materialStateForSlot(patch, material);
        if (!state) continue;
        applyMaterialColorAdjustment(material, state);
        this.applyMaterialTexture(material, "map", "studioBaseColorMapUrl", state.baseColorMapUrl, state, true);
        this.applyMaterialTexture(material, "normalMap", "studioNormalMapUrl", state.normalMapUrl, state, false);
        this.applyMaterialTexture(material, "emissiveMap", "studioEmissiveMapUrl", state.emissiveMapUrl, state, true);
        this.applyMaterialTexture(material, "aoMap", "studioAmbientOcclusionMapUrl", state.ambientOcclusionMapUrl, state, false);
        this.applyMaterialTexture(material, "roughnessMap", "studioRoughnessMapUrl", state.roughnessMapUrl, state, false);
        this.applyMaterialTexture(material, "metalnessMap", "studioMetalnessMapUrl", state.metalnessMapUrl, state, false);
        if (state.uvAnimation !== undefined) {
          material.userData.studioUvAnimation = structuredClone(state.uvAnimation);
          material.userData.studioUvAnimationElapsed = 0;
        }
        if (state.screen?.enabled === false) this.applyModelScreen(material, state.screen);
        applyMaterialNumbers(material, state);
        restoreMaterialSourceColors(material, state);
        if (state.screen?.enabled !== false) this.applyModelScreen(material, state.screen);
        material.needsUpdate = true;
      }
    });
  }

  /**
   * 只遍历启用 UV 动画的可见对象，并对同一张贴图去重更新。
   * 这样输送带等动态材质不会触发材质重编译，也不会重复上传纹理。
   */
  protected updateMaterialUvAnimations(delta: number): void {
    const updatedTextures = new Set<THREE.Texture>();
    for (const model of this.models.values()) {
      if (!model.visible || !model.object.visible) continue;
      model.object.traverse((child) => {
        for (const material of this.materialsForMesh(child as THREE.Mesh)) {
          const standard = material as THREE.MeshStandardMaterial;
          const animation = standard.userData.studioUvAnimation as SceneMaterialState["uvAnimation"];
          if (!animation?.enabled) continue;
          const elapsed = Number(standard.userData.studioUvAnimationElapsed ?? 0);
          const duration = Math.max(0.05, animation.durationSeconds ?? 5);
          if (animation.loopMode === "once" && elapsed >= duration) continue;
          const frameDelta = animation.loopMode === "once" ? Math.min(delta, duration - elapsed) : delta;
          standard.userData.studioUvAnimationElapsed = elapsed + frameDelta;
          for (const texture of materialTextures(standard)) {
            if (updatedTextures.has(texture)) continue;
            updatedTextures.add(texture);
            texture.offset.x = THREE.MathUtils.euclideanModulo(texture.offset.x + animation.offsetSpeedX * frameDelta, 1);
            texture.offset.y = THREE.MathUtils.euclideanModulo(texture.offset.y + animation.offsetSpeedY * frameDelta, 1);
            texture.rotation += animation.rotationSpeed * frameDelta;
          }
        }
      });
    }
  }

  protected applyMaterialTexture(
    material: THREE.MeshStandardMaterial,
    slot: MaterialTextureSlot,
    metadataKey: MaterialTextureMetadataKey,
    url: string | undefined,
    state: SceneMaterialState,
    srgb: boolean,
  ): void {
    const transformChanged = hasMaterialTextureTransformPatch(state);
    const animate = state.uvAnimation?.enabled === true;
    if (url === undefined && !transformChanged && !animate) return;
    if (
      url === undefined
      && isModelScreenTexture(material[slot])
      && typeof material.userData[metadataKey] !== "string"
    ) return;
    let originals = this.originalMaterialTextures.get(material);
    if (!originals) {
      originals = {};
      this.originalMaterialTextures.set(material, originals);
    }
    if (!(slot in originals)) originals[slot] = material[slot] ?? null;
    if (url !== undefined) material.userData[metadataKey] = url;
    const requestedUrl = url ?? (typeof material.userData[metadataKey] === "string" ? material.userData[metadataKey] : "");
    const transform = resolveMaterialTextureTransform(state, readMaterialTextureTransform(material.userData));
    writeMaterialTextureTransform(material.userData, transform);
    if (!requestedUrl) {
      delete material.userData[metadataKey];
      if (url !== undefined && !animate) {
        this.disposeManagedMaterialTexture(material[slot]);
        material[slot] = originals[slot] ?? null;
        material.needsUpdate = true;
        return;
      }
      const source = originals[slot];
      if (!source) return;
      const current = material[slot];
      const texture = current?.userData.studioManagedTextureTransform ? current : source.clone();
      texture.userData.studioManagedTextureTransform = true;
      if (transformChanged) applyMaterialTextureTransform(texture, transform);
      material[slot] = texture;
      material.needsUpdate = true;
      return;
    }
    const current = material[slot];
    if (current?.userData.studioManagedTextureUrl === requestedUrl) {
      applyMaterialTextureTransform(current, transform);
      material.needsUpdate = true;
      return;
    }
    void this.loadMaterialTextureSource(requestedUrl, srgb)
      .then((source) => {
        if (material.userData[metadataKey] !== requestedUrl) return;
        const texture = source.clone();
        texture.userData.studioManagedTextureUrl = requestedUrl;
        // 加载期间用户仍可能继续微调 UV，挂载时读取最新状态，避免旧异步结果回写覆盖。
        applyMaterialTextureTransform(texture, readMaterialTextureTransform(material.userData));
        this.disposeManagedMaterialTexture(material[slot]);
        material[slot] = texture;
        material.needsUpdate = true;
        this.markShadowMapDirty();
      })
      .catch(() => {
        if (material.userData[metadataKey] === requestedUrl) delete material.userData[metadataKey];
      });
  }

  protected applyModelScreen(material: THREE.MeshStandardMaterial, screen: SceneMaterialScreenState | undefined): void {
    if (screen === undefined) return;
    const normalized = normalizeModelScreenState(screen);
    material.userData.studioScreenState = structuredClone(normalized);
    const sourceUrl = modelScreenSourceUrl(normalized.url, window.location.href);
    if (!normalized.enabled || !sourceUrl) {
      this.restoreModelScreenMaterial(material);
      material.userData.studioScreenState = structuredClone(normalized);
      material.needsUpdate = true;
      return;
    }

    if (!this.modelScreenOriginals.has(material)) {
      this.modelScreenOriginals.set(material, {
        map: material.map,
        emissiveMap: material.emissiveMap,
        emissive: material.emissive.clone(),
        emissiveIntensity: material.emissiveIntensity,
      });
    }
    const requestKey = `${normalized.sourceType}:${sourceUrl}`;
    material.userData.studioScreenRequestKey = requestKey;
    if (material.map?.userData.studioModelScreenKey === requestKey) {
      updateModelScreenVideo(material.map, normalized);
      material.emissive.set("#ffffff");
      material.emissiveIntensity = normalized.emissiveIntensity;
      material.needsUpdate = true;
      return;
    }

    if (normalized.sourceType === "video") {
      const texture = createModelScreenVideoTexture(normalized, sourceUrl);
      texture.userData.studioModelScreenKey = requestKey;
      this.attachModelScreenTexture(material, texture, normalized, requestKey);
      return;
    }
    void this.loadMaterialTextureSource(sourceUrl, true)
      .then((source) => {
        if (material.userData.studioScreenRequestKey !== requestKey) return;
        const texture = source.clone();
        texture.flipY = false;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.userData.studioModelScreenKey = requestKey;
        markModelScreenImageTexture(texture);
        this.attachModelScreenTexture(material, texture, normalized, requestKey);
      })
      .catch(() => undefined);
  }

  protected attachModelScreenTexture(
    material: THREE.MeshStandardMaterial,
    texture: THREE.Texture,
    screen: SceneMaterialScreenState,
    requestKey: string,
  ): void {
    if (material.userData.studioScreenRequestKey !== requestKey) {
      disposeModelScreenTexture(texture);
      return;
    }
    const active = new Set([material.map, material.emissiveMap].filter((texture): texture is THREE.Texture => Boolean(texture) && isModelScreenTexture(texture)));
    active.forEach(disposeModelScreenTexture);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    material.map = texture;
    material.emissiveMap = texture;
    material.emissive.set("#ffffff");
    material.emissiveIntensity = screen.emissiveIntensity;
    material.needsUpdate = true;
    this.markShadowMapDirty();
  }

  protected restoreModelScreenMaterial(material: THREE.MeshStandardMaterial): void {
    delete material.userData.studioScreenRequestKey;
    const original = this.modelScreenOriginals.get(material);
    if (!original) return;
    const active = new Set([material.map, material.emissiveMap].filter((texture): texture is THREE.Texture => Boolean(texture) && isModelScreenTexture(texture)));
    active.forEach(disposeModelScreenTexture);
    material.map = original.map;
    material.emissiveMap = original.emissiveMap;
    material.emissive.copy(original.emissive);
    material.emissiveIntensity = original.emissiveIntensity;
    this.modelScreenOriginals.delete(material);
  }

  protected loadMaterialTextureSource(url: string, srgb: boolean): Promise<THREE.Texture> {
    const key = `${srgb ? "srgb" : "linear"}:${url}`;
    const cached = this.materialTextureSources.get(key);
    if (cached) return cached;
    const request = new THREE.TextureLoader().loadAsync(url).then((texture) => {
      if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    }).catch((error) => {
      this.materialTextureSources.delete(key);
      throw error;
    });
    this.materialTextureSources.set(key, request);
    return request;
  }

  protected disposeManagedMaterialTexture(texture: THREE.Texture | null): void {
    if (isModelScreenTexture(texture)) disposeModelScreenTexture(texture);
    else if (texture?.userData.studioManagedTextureUrl || texture?.userData.studioManagedTextureTransform) texture.dispose();
  }

  protected objectColor(object: THREE.Object3D | undefined): string {
    if (!object) return "#d4a84f";
    let result: string | undefined;
    object.traverse((child) => {
      if (result) return;
      const material = this.materialsForMesh(child as THREE.Mesh)[0] as THREE.Material & { color?: THREE.Color };
      if (material?.color?.isColor) result = `#${material.color.getHexString()}`;
    });
    return result ?? "#d4a84f";
  }
}

function materialTextureState(material: THREE.MeshStandardMaterial): SceneMaterialState {
  const data = material.userData;
  return {
    ...(typeof data.studioBaseColorMapUrl === "string" ? { baseColorMapUrl: data.studioBaseColorMapUrl } : {}),
    ...(typeof data.studioNormalMapUrl === "string" ? { normalMapUrl: data.studioNormalMapUrl } : {}),
    ...(typeof data.studioEmissiveMapUrl === "string" ? { emissiveMapUrl: data.studioEmissiveMapUrl } : {}),
    ...(typeof data.studioAmbientOcclusionMapUrl === "string" ? { ambientOcclusionMapUrl: data.studioAmbientOcclusionMapUrl } : {}),
    ...(typeof data.studioRoughnessMapUrl === "string" ? { roughnessMapUrl: data.studioRoughnessMapUrl } : {}),
    ...(typeof data.studioMetalnessMapUrl === "string" ? { metalnessMapUrl: data.studioMetalnessMapUrl } : {}),
    ...materialTextureTransformState(data),
    ...(data.studioShaderEffect ? { shaderEffect: structuredClone(data.studioShaderEffect) } : {}),
    ...(data.studioUvAnimation ? { uvAnimation: structuredClone(data.studioUvAnimation) } : {}),
    ...(data.studioScreenState ? { screen: structuredClone(data.studioScreenState) } : {}),
  };
}

function materialTextures(material: THREE.MeshStandardMaterial): THREE.Texture[] {
  return [material.map, material.normalMap, material.emissiveMap, material.aoMap, material.roughnessMap, material.metalnessMap]
    .filter((texture): texture is THREE.Texture => Boolean(texture));
}

function applyMaterialNumbers(material: THREE.MeshStandardMaterial, state: SceneMaterialState) {
  if (state.emissive && material.emissive?.isColor) material.emissive.set(state.emissive);
  if (state.normalScale !== undefined && material.normalScale?.isVector2) {
    material.normalScale.setScalar(THREE.MathUtils.clamp(state.normalScale, 0, 4));
  }
  if (state.roughness !== undefined) material.roughness = THREE.MathUtils.clamp(state.roughness, 0, 1);
  if (state.metalness !== undefined) material.metalness = THREE.MathUtils.clamp(state.metalness, 0, 1);
  if (state.emissiveIntensity !== undefined) {
    material.emissiveIntensity = THREE.MathUtils.clamp(state.emissiveIntensity, 0, 10);
  }
  if (state.wireframe !== undefined) material.wireframe = state.wireframe;
  if (state.doubleSided !== undefined) material.side = state.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
  applyMaterialShaderEffect(material, state.shaderEffect);
}

/**
 * 菲涅尔轮廓光：通过 onBeforeCompile 向标准 PBR 输出叠加视角边缘自发光。
 * 只注入 emissive 项，不替换光照模型；效果关闭时恢复原始编译钩子并触发重编译。
 */
function applyMaterialShaderEffect(material: THREE.MeshStandardMaterial, effect: SceneMaterialShaderEffect | undefined): void {
  const previous = material.userData.studioShaderEffectInstance as
    | { kind: string; detach: (target: THREE.MeshStandardMaterial) => void }
    | undefined;
  if (!effect) {
    if (previous) {
      previous.detach(material);
      delete material.userData.studioShaderEffectInstance;
    }
    delete material.userData.studioShaderEffect;
    material.needsUpdate = true;
    return;
  }
  const previousState = material.userData.studioShaderEffect as SceneMaterialShaderEffect | undefined;
  if (previous?.kind === effect.kind && previousState?.color === effect.color && previousState?.intensity === effect.intensity) return;
  const color = new THREE.Color(effect.color);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uStudioRimColor = { value: color };
    shader.uniforms.uStudioRimIntensity = { value: THREE.MathUtils.clamp(effect.intensity, 0, 4) };
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uStudioRimColor;\nuniform float uStudioRimIntensity;")
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\nfloat studioRim = pow(1.0 - saturate(dot(normalize(vNormal), normalize(vViewPosition))), 2.5);\n totalEmissiveRadiance += uStudioRimColor * studioRim * uStudioRimIntensity;",
      );
  };
  material.customProgramCacheKey = () => "studio-fresnel-rim";
  material.userData.studioShaderEffect = { kind: effect.kind, color: effect.color, intensity: effect.intensity };
  material.userData.studioShaderEffectInstance = {
    kind: effect.kind,
    detach: (target: THREE.MeshStandardMaterial) => {
      target.onBeforeCompile = () => undefined;
      target.customProgramCacheKey = () => "";
    },
  };
  material.needsUpdate = true;
}

type MaterialColorAdjustment = Required<Pick<SceneMaterialState, "hue" | "saturation" | "brightness" | "contrast">>;

function materialColorAdjustmentState(material: THREE.MeshStandardMaterial): SceneMaterialState {
  const value = material.userData.studioColorAdjustment as Partial<MaterialColorAdjustment> | undefined;
  return value ? {
    hue: value.hue ?? 0,
    saturation: value.saturation ?? 0,
    brightness: value.brightness ?? 0,
    contrast: value.contrast ?? 0,
  } : {};
}

function applyMaterialColorAdjustment(material: THREE.MeshStandardMaterial, state: SceneMaterialState): void {
  if (!material.color?.isColor) return;
  const current = materialColorAdjustmentState(material);
  const next: MaterialColorAdjustment = {
    hue: THREE.MathUtils.clamp(state.hue ?? current.hue ?? 0, -180, 180),
    saturation: THREE.MathUtils.clamp(state.saturation ?? current.saturation ?? 0, -1, 1),
    brightness: THREE.MathUtils.clamp(state.brightness ?? current.brightness ?? 0, -1, 1),
    contrast: THREE.MathUtils.clamp(state.contrast ?? current.contrast ?? 0, -1, 1),
  };
  const baseColor = state.color
    ?? (typeof material.userData.studioUngradedColor === "string" ? material.userData.studioUngradedColor : `#${material.color.getHexString()}`);
  material.userData.studioUngradedColor = baseColor;
  material.userData.studioColorAdjustment = next;
  material.color.set(baseColor);
  material.color.offsetHSL(next.hue / 360, next.saturation, next.brightness * 0.5);
  const factor = next.contrast + 1;
  material.color.setRGB(
    THREE.MathUtils.clamp((material.color.r - 0.5) * factor + 0.5, 0, 1),
    THREE.MathUtils.clamp((material.color.g - 0.5) * factor + 0.5, 0, 1),
    THREE.MathUtils.clamp((material.color.b - 0.5) * factor + 0.5, 0, 1),
  );
}
