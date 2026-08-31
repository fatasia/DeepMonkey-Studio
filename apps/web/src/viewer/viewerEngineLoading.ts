import type * as FRAGS from "@thatopen/fragments";
import * as THREE from "three";
import type { ModelManifest, PrimitiveKind } from "@bim-studio/contracts";
import { hydrateNativeBimMetadata, type NativeBimPropertiesFile } from "./bimMetadata";
import { primitiveGroundOffset } from "./primitiveGeometry";
import { ModelLoadSupersededError, shouldRenderSceneLightProxy, type LoadedSceneModel } from "./viewerTypes";
import { DEFAULT_SCENE_LIGHTS } from "./viewerEngineTypes";
import { ViewerEngineSpatialAudio } from "./viewerEngineSpatialAudio";
import { loadViewerAssetBuffer } from "./viewerAssetTransport";
import { loadLegacyModel, type LegacyViewerKind } from "./legacyModelLoader";
import { loadOpenUsdModel } from "./openUsdModelLoader";

/** Loading 职责层。 */
export abstract class ViewerEngineLoading extends ViewerEngineSpatialAudio {
  async loadManifest(manifest: ModelManifest): Promise<LoadedSceneModel> {
      const existing = this.models.get(manifest.modelId);
      if (existing) return existing;
      const epoch = this.modelLoads.currentEpoch;
      return this.modelLoads.run(manifest.modelId, epoch, () => this.loadManifestOnce(manifest, epoch));
    }
  /**
     * IFC/Fragments 仅在实际加载对应模型时初始化。常规 glTF、FBX 与 DXF 浏览不再承担
     * web-ifc、Fragments worker 和空间树运行时的下载与内存成本。
     */
    protected async ensureFragmentRuntime(): Promise<void> {
      if (this.fragments && this.importer && this.fragmentApi) return;
      if (!this.fragmentRuntimeInit) {
        this.fragmentRuntimeInit = Promise.all([
          import("@thatopen/fragments"),
          import("@thatopen/fragments/worker?url")
        ]).then(([fragmentsModule, workerModule]) => {
          const fragments = new fragmentsModule.FragmentsModels(workerModule.default);
          const importer = new fragmentsModule.IfcImporter();
          importer.wasm = { absolute: true, path: `${import.meta.env.BASE_URL}wasm/` };
          fragments.onModelLoaded.add((model) => {
            model.useCamera(this.camera);
            void fragments.update(true);
          });
          this.fragments = fragments;
          this.importer = importer;
          this.fragmentApi = fragmentsModule;
        }).finally(() => { this.fragmentRuntimeInit = undefined; });
      }
      await this.fragmentRuntimeInit;
    }
  protected requireFragmentRuntime(): { fragments: FRAGS.FragmentsModels; importer: FRAGS.IfcImporter; api: typeof import("@thatopen/fragments") } {
      if (!this.fragments || !this.importer || !this.fragmentApi) throw new Error("IFC/Fragments 运行时尚未初始化");
      return { fragments: this.fragments, importer: this.importer, api: this.fragmentApi };
    }
  protected async loadManifestOnce(manifest: ModelManifest, epoch: number): Promise<LoadedSceneModel> {
      if (!manifest.geometryUrl || !manifest.viewerKind) throw new Error("模型清单缺少几何数据");
      let object: THREE.Object3D;
      let animations: THREE.AnimationClip[] = [];
      let fragmentsModel: FRAGS.FragmentsModel | undefined;
      let progressiveGltf: { levels: Array<{ url: string; name: string }>; metadata?: NativeBimPropertiesFile } | undefined;
      if (manifest.viewerKind === "gltf") {
        const lowLod = manifest.lods?.find((item) => item.level === "low");
        const [gltf, bimMetadata] = await Promise.all([
          this.gltfLoader.loadAsync(lowLod?.url ?? manifest.geometryUrl),
          manifest.propertiesUrl ? this.loadNativeBimMetadata(manifest.propertiesUrl) : Promise.resolve(undefined)
        ]);
        if (lowLod) {
          const group = new THREE.Group();
          gltf.scene.name ||= "低精度预览";
          group.add(gltf.scene);
          object = group;
          const medium = manifest.lods?.find((item) => item.level === "medium");
          progressiveGltf = {
            levels: [...(medium ? [{ url: medium.url, name: "中精度" }] : []), { url: manifest.geometryUrl, name: "完整精度" }],
            ...(bimMetadata ? { metadata: bimMetadata } : {})
          };
        } else object = gltf.scene;
        animations = gltf.animations;
        if (bimMetadata) hydrateNativeBimMetadata(object, bimMetadata);
      } else if (manifest.viewerKind === "fbx") {
        object = await this.fbxLoader.loadAsync(manifest.geometryUrl);
        animations = object.animations;
      } else if (manifest.viewerKind === "ifc") {
        await this.ensureFragmentRuntime();
        const { fragments, importer, api } = this.requireFragmentRuntime();
        const buffer = await loadViewerAssetBuffer(manifest.geometryUrl, "IFC");
        const fragmentsBytes = await importer.process({ bytes: new Uint8Array(buffer) });
        const model = await fragments.load(fragmentsBytes, { modelId: manifest.modelId });
        model.useCamera(this.camera);
        await model.setLodMode(api.LodMode.DEFAULT);
        fragmentsModel = model;
        object = model.object;
      } else if (manifest.viewerKind === "fragments") {
        await this.ensureFragmentRuntime();
        const { fragments, api } = this.requireFragmentRuntime();
        const buffer = await loadViewerAssetBuffer(manifest.geometryUrl, "Fragments");
        const model = await fragments.load(buffer, { modelId: manifest.modelId });
        model.useCamera(this.camera);
        await model.setLodMode(api.LodMode.DEFAULT);
        fragmentsModel = model;
        object = model.object;
      } else if (manifest.viewerKind === "usd") {
        const loaded = await loadOpenUsdModel(manifest.geometryUrl);
        object = loaded.object;
        animations = loaded.animations;
      } else if (isLegacyViewerKind(manifest.viewerKind)) {
        const loaded = await loadLegacyModel(manifest.viewerKind, manifest.geometryUrl);
        object = loaded.object;
        animations = loaded.animations;
      } else {
        object = await this.loadDxf(manifest.geometryUrl);
      }
      if (!this.modelLoads.isCurrent(epoch)) {
        if (fragmentsModel) await fragmentsModel.dispose();
        else this.disposeObject(object);
        throw new ModelLoadSupersededError();
      }
      const loaded = this.registerObject(manifest.modelId, manifest.sourceName, object, "model");
      if (fragmentsModel) await this.registerFragmentsModel(manifest.modelId, fragmentsModel, manifest.sourceName);
      if (animations.length > 0) {
        const mixer = new THREE.AnimationMixer(object);
        animations.forEach((clip) => mixer.clipAction(clip).play());
        this.mixers.set(manifest.modelId, mixer);
        this.animationClips.set(manifest.modelId, animations);
        this.animationClipSelection.delete(manifest.modelId);
        this.animationEnabledIds.add(manifest.modelId);
      }
      // 低精度层只用于加快首帧；无论运行策略如何，最终都会升级到完整资产。
      if (progressiveGltf) void this.streamGltfLevels(manifest.modelId, object, progressiveGltf, epoch);
      this.fitAll();
      this.dispatchObjectLifecycle("load", manifest.modelId);
      if (animations.length > 0) queueMicrotask(() => this.dispatchObjectLifecycle("animationStart", manifest.modelId));
      return loaded;
    }
  protected async streamGltfLevels(modelId: string, container: THREE.Object3D, stream: { levels: Array<{ url: string; name: string }>; metadata?: NativeBimPropertiesFile }, epoch: number): Promise<void> {
      for (const level of stream.levels) {
        try {
          const gltf = await this.gltfLoader.loadAsync(level.url);
          if (!this.modelLoads.isCurrent(epoch) || this.models.get(modelId)?.object !== container) {
            this.disposeObject(gltf.scene);
            return;
          }
          if (stream.metadata) hydrateNativeBimMetadata(gltf.scene, stream.metadata);
          gltf.scene.name ||= level.name;
          this.restoreModelEffectMaterials(modelId);
          this.modelEffectRuntimes.delete(modelId);
          const previous = container.children[0];
          if (previous) {
            container.remove(previous);
            this.disposeObject(previous);
          }
          container.add(gltf.scene);
          const savedStates = this.getLayerStates(modelId);
          this.layerObjects.set(modelId, this.indexModelObject(modelId, container));
          this.captureModelBoneRestPose(modelId);
          const rig = this.modelRigStates.get(modelId);
          if (rig) this.setModelRigState(modelId, rig);
          this.rebuildComponentIndex(modelId);
          this.applyLayerStates(modelId, savedStates);
          this.rebuildModelEffects(modelId);
          const previousMixer = this.mixers.get(modelId);
          if (previousMixer) previousMixer.stopAllAction();
          if (gltf.animations.length > 0) {
            const mixer = new THREE.AnimationMixer(container);
            gltf.animations.forEach((clip) => mixer.clipAction(clip).play());
            this.mixers.set(modelId, mixer);
            this.animationClips.set(modelId, gltf.animations);
            this.animationClipSelection.delete(modelId);
            this.animationEnabledIds.add(modelId);
          }
          const model = this.models.get(modelId);
          if (model) this.onModelChange?.(model);
          this.markShadowMapDirty();
          this.scheduleRendererPipelineWarmup();
        } catch (error) {
          console.warn(`渐进加载 ${level.name} 失败，保留当前精度`, error);
          return;
        }
      }
    }
  createPrimitive(id: string, name: string, kind: PrimitiveKind = "box", color = "#d9a441", position?: THREE.Vector3): LoadedSceneModel {
      const geometry = this.primitiveGeometryCache.get(kind);
      const material = this.primitiveMaterialCache.get(color);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(position ?? new THREE.Vector3(0, primitiveGroundOffset(kind), 0));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.primitiveKind = kind;
      const loaded = this.registerObject(id, name, mesh, "primitive");
      this.select(id);
      queueMicrotask(() => this.dispatchObjectLifecycle("load", id));
      return loaded;
    }
  createBox(id: string, name: string, color = "#d9a441"): LoadedSceneModel {
      return this.createPrimitive(id, name, "box", color);
    }
  startPrimitivePlacement(kind: PrimitiveKind): void {
      this.primitivePlacementKind = kind;
      this.setMeasureEnabled(false);
      this.setAnnotationPlacementEnabled(false);
      this.updateToolCursor();
    }
  cancelPrimitivePlacement(): void {
      this.primitivePlacementKind = undefined;
      this.updateToolCursor();
    }
  removeModel(id: string): void {
      const model = this.models.get(id);
      if (!model) return;
      this.removePhysicsBody(id);
      this.physicsBodyStates.delete(id);
      this.restoreModelEffectMaterials(id);
      this.modelEffectRuntimes.delete(id);
      this.modelEffects.delete(id);
      this.clearIsolation();
      this.setExplosion(id, 0);
      if (this.selectedId === id) this.select(undefined);
      this.setCollisionHighlight(model, false);
      model.object.removeFromParent();
      const mixer = this.mixers.get(id);
      if (mixer) {
        mixer.stopAllAction();
        mixer.uncacheRoot(model.object);
        this.mixers.delete(id);
        this.animationClips.delete(id);
        this.animationClipSelection.delete(id);
        this.animationEnabledIds.delete(id);
      }
      // 音频节点必须在模型对象销毁前停止并断开，避免 Web Audio 引用已移除的三维对象。
      this.spatialAudioStates.delete(id);
      this.disposeSpatialAudioRuntime(id);
      // 统一释放路径会保留查看器级共享几何；逐对象直接 dispose 会让同类设备反复上传 GPU。
      this.disposeObject(model.object);
      this.models.delete(id);
      const fragmentsModel = this.fragmentModels.get(id);
      if (fragmentsModel) {
        void fragmentsModel.resetHighlight().finally(() => fragmentsModel.dispose());
        this.fragmentModels.delete(id);
        this.fragmentLayers.delete(id);
        this.fragmentTrees.delete(id);
        this.fragmentNodeIdsByLocalId.delete(id);
      }
      this.layerObjects.delete(id);
      this.layerStates.delete(id);
      this.componentRecords.delete(id);
      this.modelColorOverrides.delete(id);
      this.modelMaterialOverrides.delete(id);
      this.modelRigStates.delete(id);
      this.modelBoneRestRotations.delete(id);
      this.modelAnimationPlaybackStates.delete(id);
      this.modelPrefabStates.delete(id);
      this.motionRouteRuntimes.delete(id);
      // 楼层展开/可见状态属于模型会话，模型移除后不能残留到下一次场景加载。
      for (const [key, state] of this.floorStates) {
        if (state.modelId === id) this.floorStates.delete(key);
      }
      for (const [key, visual] of this.spaceVisuals) {
        if (visual.modelId !== id) continue;
        this.disposeObject(visual.object);
        this.spaceVisuals.delete(key);
      }
      this.explosionPositions.delete(id);
      this.explosionFactors.delete(id);
      this.explosionModes.delete(id);
      this.collisionEnabledIds.delete(id);
      this.collidingIds.delete(id);
      this.updateCollisions(true);
      this.markShadowMapDirty();
      this.onModelChange?.(model);
    }
  setReadOnly(readOnly: boolean): void {
      const changed = this.readOnlyMode !== readOnly;
      this.readOnlyMode = readOnly;
      if (readOnly) {
        this.setMeasureEnabled(false);
        this.setAnnotationPlacementEnabled(false);
        if (this.selectedSceneLight) this.clearSceneLightSelection();
        this.disposeSceneLightProxies();
      } else if (changed) {
        for (const state of this.lightingState.lights ?? DEFAULT_SCENE_LIGHTS) {
          if (shouldRenderSceneLightProxy(false, state.type) && this.sceneLights.has(state.id)) this.createSceneLightProxy(state);
        }
      }
      if (changed) {
        for (const id of this.annotations.keys()) this.refreshAnnotationVisual(id);
      }
      this.updateTransformAccess();
    }
  clearSceneModels(): void {
      this.modelLoads.invalidate();
      if (this.rendererBackend === "webgpu" && !this.rendererDisposalStarted && this.models.size > 0) {
        this.primitiveMaterialCache.beginSceneGeneration();
      }
      for (const id of [...this.models.keys()]) this.removeModel(id);
      for (const orphan of [...this.modelRoot.children]) {
        orphan.removeFromParent();
        this.disposeObject(orphan);
      }
      this.clearMeasurements();
      this.clearAnnotations();
      this.measurementPoints.length = 0;
      this.measurementTargets.length = 0;
      this.onMeasurementDraftChange?.(false);
      this.updatePostProcessingSelection();
    }
}

function isLegacyViewerKind(kind: NonNullable<ModelManifest["viewerKind"]>): kind is LegacyViewerKind {
  return kind === "obj" || kind === "stl" || kind === "3mf" || kind === "dae" || kind === "3ds";
}
