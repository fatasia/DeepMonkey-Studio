import { materialSlotId, readMaterialSlot, sourceMaterialState, mergeMaterialPatch, type SelectionMaterialSlot } from "./materialSlots";
import { materialIor } from "./materialIor";
import * as THREE from "three";
import type { GlobalLightingState, SceneEnvironmentState, SceneFloorState, SceneIKConstraintState, SceneMaterialState, SceneModelEffectsState, ScenePostProcessingState, SceneRigState, Vector3Value, WeatherMode } from "@bim-studio/contracts";
import { sceneWeatherFog } from "@bim-studio/contracts";
import { readXRThumbstick } from "./xrInput";
import { describeXrEntryBlock, describeXrSessionRequestFailure, describeXrSessionSetupFailure } from "./xrSession";
import { componentFacets } from "./analysis";
import { toValue } from "./sceneObjectUtils";
import { DEFAULT_MODEL_EFFECTS, DEFAULT_SCENE_LIGHTS } from "./viewerEngineTypes";
import { ViewerEngineInteraction } from "./viewerEngineInteraction";
import { normalizeRobotKinematicsState } from "./robotKinematics";
import { normalizeFireEffect } from "./modelEffectState";
import { materialTextureTransformState } from "./materialTextureTransform";

/** Rig 职责层。 */
export abstract class ViewerEngineRig extends ViewerEngineInteraction {
  isAnimationEnabled(id: string): boolean {
      return this.animationEnabledIds.has(id);
    }
  setAnimationEnabled(id: string, enabled: boolean): void {
      const mixer = this.mixers.get(id);
      const model = this.models.get(id);
      if (!mixer || !model) return;
      const changed = this.animationEnabledIds.has(id) !== enabled;
      mixer.timeScale = enabled ? 1 : 0;
      if (enabled) {
        this.animationEnabledIds.add(id);
        const playback = this.getAnimationPlayback(id);
        if (playback && playback.loopMode === "once" && playback.time >= playback.duration) this.restartModelAnimationActions(id);
      }
      else this.animationEnabledIds.delete(id);
      this.onModelChange?.(model);
      if (changed) queueMicrotask(() => this.dispatchObjectLifecycle(enabled ? "animationStart" : "animationEnd", id));
    }
  hasSkeleton(modelId: string): boolean {
      return this.listModelBones(modelId).length > 0;
    }
  listModelBones(modelId: string): Array<{ path: string; name: string; depth: number; parentPath?: string; linkLength: number }> {
      const objects = this.layerObjects.get(modelId);
      if (!objects) return [];
      const paths = new Map([...objects.entries()].map(([path, object]) => [object, path]));
      return [...objects.entries()].flatMap(([path, object]) => {
        const bone = object as THREE.Bone;
        if (!bone.isBone) return [];
        let depth = 0;
        let parent = bone.parent;
        while (parent) { if ((parent as THREE.Bone).isBone) depth++; parent = parent.parent; }
        const parentPath = bone.parent ? paths.get(bone.parent) : undefined;
        return [{ path, name: bone.name || `Bone ${path.split("/").at(-1)}`, depth, ...(parentPath ? { parentPath } : {}), linkLength: bone.position.length() }];
      });
    }
  getBoneRotation(modelId: string, bonePath: string): Vector3Value | undefined {
      const bone = this.modelBone(modelId, bonePath);
      return bone ? toValue(bone.rotation) : undefined;
    }
  setBoneRotation(modelId: string, bonePath: string, rotation: Vector3Value): boolean {
      const bone = this.modelBone(modelId, bonePath);
      if (!bone) return false;
      bone.rotation.set(rotation.x, rotation.y, rotation.z);
      bone.updateWorldMatrix(true, true);
      const state = this.modelRigStates.get(modelId) ?? { bones: [], ik: [] };
      const pose = { bonePath, rotation: { ...rotation } };
      state.bones = [...state.bones.filter((item) => item.bonePath !== bonePath), pose];
      this.modelRigStates.set(modelId, state);
      const model = this.models.get(modelId);
      if (model) this.onModelChange?.(model);
      return true;
    }
  resetBonePose(modelId: string, bonePath?: string): void {
      const rest = this.modelBoneRestRotations.get(modelId);
      const state = this.modelRigStates.get(modelId) ?? { bones: [], ik: [] };
      for (const [path, rotation] of rest ?? []) {
        if (bonePath && path !== bonePath) continue;
        const bone = this.modelBone(modelId, path);
        if (bone) bone.quaternion.copy(rotation);
      }
      state.bones = bonePath ? state.bones.filter((item) => item.bonePath !== bonePath) : [];
      this.modelRigStates.set(modelId, state);
      const model = this.models.get(modelId);
      model?.object.updateWorldMatrix(true, true);
      if (model) this.onModelChange?.(model);
    }
  getModelRigState(modelId: string): SceneRigState | undefined {
      const state = this.modelRigStates.get(modelId);
      return state && (state.bones.length > 0 || state.ik.length > 0 || state.robot?.enabled) ? structuredClone(state) : undefined;
    }
  setModelRigState(modelId: string, rig: SceneRigState): void {
      const normalized: SceneRigState = {
        bones: rig.bones.map((item) => ({ bonePath: item.bonePath, rotation: { ...item.rotation } })),
        ik: rig.ik.map((item) => this.normalizeIKConstraint(item)),
        ...(rig.robot ? { robot: normalizeRobotKinematicsState(rig.robot) } : {})
      };
      this.modelRigStates.set(modelId, normalized);
      for (const pose of normalized.bones) {
        const bone = this.modelBone(modelId, pose.bonePath);
        if (bone) bone.rotation.set(pose.rotation.x, pose.rotation.y, pose.rotation.z);
      }
      this.models.get(modelId)?.object.updateWorldMatrix(true, true);
    }
  createIKConstraint(modelId: string, effectorBonePath: string): SceneIKConstraintState | undefined {
      const model = this.models.get(modelId);
      const bone = this.modelBone(modelId, effectorBonePath);
      if (!model || !bone) return undefined;
      const target = model.object.worldToLocal(bone.getWorldPosition(new THREE.Vector3()).clone());
      const constraint = this.normalizeIKConstraint({ id: crypto.randomUUID(), effectorBonePath, target: toValue(target), chainLength: 2, iterations: 12, enabled: true });
      const state = this.modelRigStates.get(modelId) ?? { bones: [], ik: [] };
      state.ik = [...state.ik, constraint];
      this.modelRigStates.set(modelId, state);
      this.onModelChange?.(model);
      return structuredClone(constraint);
    }
  updateIKConstraint(modelId: string, constraintId: string, patch: Partial<Omit<SceneIKConstraintState, "id">>): SceneIKConstraintState | undefined {
      const state = this.modelRigStates.get(modelId);
      const current = state?.ik.find((item) => item.id === constraintId);
      if (!state || !current) return undefined;
      const next = this.normalizeIKConstraint({ ...current, ...structuredClone(patch), id: constraintId });
      state.ik = state.ik.map((item) => item.id === constraintId ? next : item);
      const model = this.models.get(modelId);
      if (model) this.onModelChange?.(model);
      return structuredClone(next);
    }
  removeIKConstraint(modelId: string, constraintId: string): void {
      const state = this.modelRigStates.get(modelId);
      if (!state) return;
      state.ik = state.ik.filter((item) => item.id !== constraintId);
      const model = this.models.get(modelId);
      if (model) this.onModelChange?.(model);
    }
  getWeather(): WeatherMode {
      return this.weatherMode;
    }
  setWeather(mode: WeatherMode): void {
      this.weatherMode = mode;
      this.disposeWeatherEffect();
      // 雾参数取自版本化天气雾合同（值与历史字面量逐位一致），Native 交付消费同一合同。
      const weatherFog = sceneWeatherFog(mode);
      this.scene.fog = new THREE.FogExp2(parseInt(weatherFog.colorSrgbHex.slice(1), 16), weatherFog.density);
      if (mode === "rain") {
        this.weatherEffect = this.createRainEffect();
        this.scene.add(this.weatherEffect);
      } else if (mode === "snow") {
        this.weatherEffect = this.createSnowEffect();
        this.scene.add(this.weatherEffect);
      } else if (mode === "storm") {
        this.weatherEffect = this.createRainEffect();
        this.scene.add(this.weatherEffect);
      }
      this.applyLighting();
    }
  getSceneEnvironment(): SceneEnvironmentState {
      return structuredClone(this.environmentState);
    }
  setSceneEnvironment(state: SceneEnvironmentState): void {
      const backgroundColor = /^#[0-9a-f]{6}$/i.test(state.backgroundColor)
        ? state.backgroundColor
        : this.environmentState.backgroundColor;
      this.environmentState = {
        gridVisible: state.gridVisible,
        backgroundColor,
        skybox: ["none", "studio", "bright-studio", "clear", "overcast", "dawn", "sunset", "night", "industrial-night"].includes(state.skybox) ? state.skybox : "none",
        ...(state.environmentMapUrl ? { environmentMapUrl: state.environmentMapUrl } : {}),
        ...(state.environmentMapName ? { environmentMapName: state.environmentMapName } : {}),
        environmentAsBackground: state.environmentAsBackground ?? false,
        environmentIntensity: THREE.MathUtils.clamp(state.environmentIntensity ?? 1, 0, 3)
      };
      if (this.gridHelper) this.gridHelper.visible = this.environmentState.gridVisible;
      void this.applyEnvironment();
    }
  getGlobalLighting(): GlobalLightingState {
      return structuredClone(this.lightingState);
    }
  setGlobalLighting(state: GlobalLightingState): void {
      this.lightingState = {
        enabled: state.enabled,
        intensity: THREE.MathUtils.clamp(state.intensity, 0, 2.5),
        shadowsEnabled: state.shadowsEnabled ?? false,
        reflectionsEnabled: state.reflectionsEnabled ?? false,
        globalIlluminationEnabled: state.globalIlluminationEnabled ?? false,
        globalIlluminationIntensity: THREE.MathUtils.clamp(state.globalIlluminationIntensity ?? 0.45, 0, 2),
        lights: structuredClone((state.lights?.length ? state.lights : DEFAULT_SCENE_LIGHTS).map(light => ({ ...light,
          ...(light.type === "spot" ? { shadowSoftness: THREE.MathUtils.clamp(light.shadowSoftness ?? 0, 0, 1) } : {}) }))),
        ...(state.lightProfiles?.length ? { lightProfiles: structuredClone(state.lightProfiles) } : {})
      };
      this.syncSceneLights();
      this.applyLighting();
      void this.applyEnvironment();
    }
  getModelMaterialStates(id: string): SceneMaterialState[] {
      const model = this.models.get(id);
      if (!model) return [];
      const seen = new Set<THREE.Material>();
      const states: SceneMaterialState[] = [];
      model.object.traverse(child => {
        for (const material of this.materialsForMesh(child as THREE.Mesh)) {
          if (seen.has(material)) continue;
          seen.add(material);
          states.push(readMaterialSlot(material));
        }
      });
      return states;
    }
  getSelectionMaterialSlots(): SelectionMaterialSlot[] {
      const selected = this.getSelected();
      if (!selected || this.inspectedObject && this.inspectedObject !== selected.object || this.selectedFragmentNodeId) return [];
      const slots = new Map<string, SelectionMaterialSlot>();
      selected.object.traverse(child => {
        for (const material of this.materialsForMesh(child as THREE.Mesh)) {
          const id = materialSlotId(material);
          if (id && !slots.has(id)) slots.set(id, { id, name: material.name || `Material ${Number(id.slice(5)) + 1}`, material: readMaterialSlot(material), ...(sourceMaterialState(material) ? { sourceMaterial: sourceMaterialState(material)! } : {}) });
        }
      });
      return [...slots.values()].sort((a, b) => Number(a.id.slice(5)) - Number(b.id.slice(5)));
    }
  getSelectionMaterial(): SceneMaterialState {
      const selected = this.getSelected();
      const object = this.inspectedObject ?? selected?.object;
      if (!object) return {};
      let result: SceneMaterialState = {};
      object.traverse((child) => {
        if (Object.keys(result).length > 0) return;
        const material = this.materialsForMesh(child as THREE.Mesh)[0];
        if (!material) return;
        const standard = material as THREE.MeshStandardMaterial;
        result = {
          ...(standard.color ? { color: `#${standard.color.getHexString()}` } : {}),
          ...(typeof standard.userData.studioBaseColorMapUrl === "string" ? { baseColorMapUrl: standard.userData.studioBaseColorMapUrl } : {}),
          ...(typeof standard.userData.studioNormalMapUrl === "string" ? { normalMapUrl: standard.userData.studioNormalMapUrl } : {}),
          ...(typeof standard.userData.studioEmissiveMapUrl === "string" ? { emissiveMapUrl: standard.userData.studioEmissiveMapUrl } : {}),
          ...(typeof standard.userData.studioAmbientOcclusionMapUrl === "string" ? { ambientOcclusionMapUrl: standard.userData.studioAmbientOcclusionMapUrl } : {}),
          ...(typeof standard.userData.studioRoughnessMapUrl === "string" ? { roughnessMapUrl: standard.userData.studioRoughnessMapUrl } : {}),
          ...(typeof standard.userData.studioMetalnessMapUrl === "string" ? { metalnessMapUrl: standard.userData.studioMetalnessMapUrl } : {}),
          ...materialTextureTransformState(standard.userData),
          ...(standard.normalScale?.isVector2 ? { normalScale: standard.normalScale.x } : {}),
          ...(typeof standard.roughness === "number" ? { roughness: standard.roughness } : {}),
          ...(typeof standard.metalness === "number" ? { metalness: standard.metalness } : {}),
          ...(materialIor(standard) === undefined ? {} : { ior: materialIor(standard)! }),
          ...(standard.emissive ? { emissive: `#${standard.emissive.getHexString()}`, emissiveIntensity: standard.emissiveIntensity } : {}),
          ...(typeof standard.wireframe === "boolean" ? { wireframe: standard.wireframe } : {}),
          doubleSided: standard.side === THREE.DoubleSide
        };
      });
      if (object === selected?.object) {
        const saved = this.modelMaterialOverrides.get(selected.id);
        if (saved) result = { ...result, ...structuredClone(saved) };
      } else if (selected) {
        const layerId = this.selectedFragmentNodeId ?? String(object.userData.layerNodeId ?? "");
        const saved = layerId ? this.layerStates.get(selected.id)?.get(layerId)?.material : undefined;
        if (saved) result = { ...result, ...structuredClone(saved) };
      }
      return result;
    }
  setSelectionMaterial(patch: SceneMaterialState): void {
      const selected = this.getSelected();
      const object = this.inspectedObject ?? selected?.object;
      if (!selected || !object || this.isSelectionLocked()) return;
      if (this.selectedFragmentNodeId) {
        if (patch.color) this.setSelectionColor(patch.color);
        this.updateLayerState(selected.id, this.selectedFragmentNodeId, { material: patch });
        return;
      }
      this.restoreModelEffectMaterials(selected.id);
      const previous = object === selected.object ? this.modelMaterialOverrides.get(selected.id)
        : this.layerStates.get(selected.id)?.get(String(object.userData.layerNodeId))?.material;
      const merged = mergeMaterialPatch(previous, patch);
      this.applyMaterialState(object, merged);
      if (object !== selected.object) this.updateLayerState(selected.id, String(object.userData.layerNodeId), { material: merged });
      else this.modelMaterialOverrides.set(selected.id, merged);
      selected.object.updateWorldMatrix(true, true);
      this.rebuildModelEffects(selected.id);
      this.markShadowMapDirty();
      this.onModelChange?.(selected);
    }
  getModelMaterialOverride(id: string): SceneMaterialState | undefined {
      const state = this.modelMaterialOverrides.get(id);
      return state ? structuredClone(state) : undefined;
    }
  getModelMaterialState(id: string): SceneMaterialState | undefined {
      const model = this.models.get(id);
      return model ? structuredClone(this.getMaterialState(model.object)) : undefined;
    }
  setModelMaterial(id: string, patch: SceneMaterialState): void {
      const model = this.models.get(id);
      if (!model || this.isModelLocked(id)) return;
      this.restoreModelEffectMaterials(id);
      const merged = mergeMaterialPatch(this.modelMaterialOverrides.get(id), patch);
      this.applyMaterialState(model.object, merged);
      this.modelMaterialOverrides.set(id, merged);
      model.object.updateWorldMatrix(true, true);
      this.rebuildModelEffects(id);
      this.markShadowMapDirty();
      this.onModelChange?.(model);
    }
  getModelEffects(id: string): SceneModelEffectsState {
      return structuredClone(this.modelEffects.get(id) ?? DEFAULT_MODEL_EFFECTS);
    }
  setModelEffects(id: string, state: SceneModelEffectsState): void {
      if (!this.models.has(id)) return;
      this.markShadowMapDirty();
      const normalized: SceneModelEffectsState = {
        outline: Boolean(state.outline),
        glow: Boolean(state.glow),
        xray: Boolean(state.xray),
        scanline: Boolean(state.scanline),
        heatmap: Boolean(state.heatmap),
        dissolve: THREE.MathUtils.clamp(state.dissolve, 0, 0.98),
        edgeLight: Boolean(state.edgeLight),
        color: /^#[0-9a-f]{6}$/i.test(state.color) ? state.color : DEFAULT_MODEL_EFFECTS.color,
        intensity: THREE.MathUtils.clamp(state.intensity, 0, 5),
        ...(state.fire ? { fire: normalizeFireEffect(state.fire) } : {})
      };
      this.modelEffects.set(id, normalized);
      this.rebuildModelEffects(id);
      this.updatePostProcessingSelection();
      const model = this.models.get(id);
      if (model) this.onModelChange?.(model);
    }
  getPostProcessing(): ScenePostProcessingState {
      return structuredClone(this.postProcessingState);
    }
  setPostProcessing(state: ScenePostProcessingState): void {
      this.postProcessingState = {
        enabled: state.enabled,
        smaa: state.smaa ?? false,
        fxaa: state.fxaa ?? false,
        ssao: state.ssao ?? false,
        ssaoIntensity: THREE.MathUtils.clamp(state.ssaoIntensity ?? 1, 0, 4),
        gtao: state.gtao ?? false,
        gtaoIntensity: THREE.MathUtils.clamp(state.gtaoIntensity ?? 1, 0, 4),
        screenSpaceReflection: state.screenSpaceReflection ?? false,
        ssrSteps: Math.round(THREE.MathUtils.clamp(state.ssrSteps ?? 32, 8, 128)),
        ssrThickness: THREE.MathUtils.clamp(state.ssrThickness ?? 0.01, 0.001, 0.1),
        ssrMaxDistance: THREE.MathUtils.clamp(state.ssrMaxDistance ?? 2, 0.25, 4),
        bloom: state.bloom ?? false,
        bloomStrength: THREE.MathUtils.clamp(state.bloomStrength ?? 0.35, 0, 3),
        bloomThreshold: THREE.MathUtils.clamp(state.bloomThreshold ?? 0.9, 0, 1),
        outline: state.outline ?? false,
        outlineStrength: THREE.MathUtils.clamp(state.outlineStrength ?? 2.5, 0, 10),
        depthOfField: state.depthOfField ?? false,
        focusDistance: THREE.MathUtils.clamp(state.focusDistance ?? 10, 0.1, 500),
        aperture: THREE.MathUtils.clamp(state.aperture ?? 0.00002, 0, 0.001),
        maxBlur: THREE.MathUtils.clamp(state.maxBlur ?? 0.006, 0, 0.05),
        vignette: state.vignette ?? false,
        vignetteDarkness: THREE.MathUtils.clamp(state.vignetteDarkness ?? 1.2, 0, 3),
        filmGrain: state.filmGrain ?? false,
        filmGrainIntensity: THREE.MathUtils.clamp(state.filmGrainIntensity ?? 0.18, 0, 1),
        afterimage: state.afterimage ?? false,
        afterimageDamp: THREE.MathUtils.clamp(state.afterimageDamp ?? 0.9, 0, 0.99),
        colorGrading: state.colorGrading ?? false,
        hue: THREE.MathUtils.clamp(state.hue ?? 0, -180, 180),
        saturation: THREE.MathUtils.clamp(state.saturation ?? 0, -1, 1),
        brightness: THREE.MathUtils.clamp(state.brightness ?? 0, -1, 1),
        contrast: THREE.MathUtils.clamp(state.contrast ?? 0, -1, 1),
        temperature: THREE.MathUtils.clamp(state.temperature ?? 0, -1, 1),
        tint: THREE.MathUtils.clamp(state.tint ?? 0, -1, 1)
      };
      void this.syncPostProcessing();
    }
  getFloorStates(modelId?: string): SceneFloorState[] {
      const modelEntries = modelId
        ? [[modelId, this.componentRecords.get(modelId) ?? []] as const]
        : [...this.componentRecords.entries()];
      return modelEntries.flatMap(([currentModelId, records]) => componentFacets(records).levels.map((level) => {
        const key = this.floorStateKey(currentModelId, level);
        return structuredClone(this.floorStates.get(key) ?? { modelId: currentModelId, level, visible: true, expansion: 0 });
      }));
    }
  applyFloorStates(states: SceneFloorState[] | undefined): void {
      this.floorStates.clear();
      for (const state of states ?? []) {
        if (state.modelId) this.setFloorState(state.modelId, state.level, state.visible, state.expansion);
        else {
          for (const currentModelId of this.componentRecords.keys()) this.setFloorState(currentModelId, state.level, state.visible, state.expansion);
        }
      }
    }
  setFloorState(modelId: string, level: string, visible: boolean, expansion = 0): void {
      this.floorStates.set(this.floorStateKey(modelId, level), { modelId, level, visible, expansion });
      const records = (this.componentRecords.get(modelId) ?? []).filter((record) => record.level === level);
      for (const record of records) {
        const fragment = this.fragmentLayers.get(record.modelId)?.get(record.id);
        const fragmentModel = this.fragmentModels.get(record.modelId);
        if (fragment && fragmentModel) {
          void fragmentModel.setVisible(fragment.localIds, visible).then(() => this.fragments?.update(true));
          continue;
        }
        const object = this.layerObjects.get(record.modelId)?.get(record.id);
        if (!object) continue;
        object.visible = visible;
        if (object.userData.floorBaseY === undefined) object.userData.floorBaseY = object.position.y;
        object.position.y = Number(object.userData.floorBaseY) + expansion;
      }
      this.markShadowMapDirty();
    }
  selectSceneLight(id: string, handle: "position" | "target" = "position"): boolean {
      const state = this.lightingState.lights?.find((item) => item.id === id);
      const object = handle === "position" ? this.sceneLights.get(id) : this.sceneLightTargets.get(id);
      if (!state || !object || this.readOnlyMode || this.navigationMode !== "orbit") return false;
      if (handle === "position" && ["ambient", "hemisphere"].includes(state.type)) return false;
      this.select(undefined);
      this.selectedSceneLight = { id, handle };
      this.transform.setMode("translate");
      this.transform.enabled = true;
      this.transform.attach(object);
      this.transform.getHelper().visible = true;
      return true;
    }
  clearSceneLightSelection(): void {
      this.selectedSceneLight = undefined;
      this.transform.detach();
      this.updateTransformAccess();
    }
  async isXRSupported(mode: "immersive-vr" | "immersive-ar"): Promise<boolean> {
      return this.renderer instanceof THREE.WebGLRenderer && Boolean(navigator.xr && await navigator.xr.isSessionSupported(mode));
    }
  async startXR(mode: "immersive-vr" | "immersive-ar"): Promise<boolean> {
      // 重复进入防护：标记必须在首个 await 之前同步落位，否则同一轮事件里的双击
      // 会各自穿过闸门并发起两个 requestSession。
      if (this.xrStartPending) return false;
      this.xrStartPending = true;
      try {
        const block = describeXrEntryBlock({
          secureContext: window.isSecureContext,
          webxrApi: Boolean(navigator.xr),
          authorBackend: this.rendererBackend,
        });
        if (block || !(this.renderer instanceof THREE.WebGLRenderer)) throw new Error(block ?? "XR 仅支持 WebGL 渲染后端");
        let supported = false;
        try {
          supported = await navigator.xr!.isSessionSupported(mode);
        } catch (reason) {
          throw new Error(describeXrSessionRequestFailure(reason, mode));
        }
        if (!supported) throw new Error(mode === "immersive-vr" ? "当前设备不支持 VR 会话（isSessionSupported=false）" : "当前设备不支持 AR 会话（isSessionSupported=false）");
        if (this.xrSession) {
          try { await this.endXR(); } catch { /* 旧会话结束失败时继续尝试请求新会话，失败原因由 requestSession 给出 */ }
        }
        let session: XRSession;
        try {
          session = await navigator.xr!.requestSession(mode, mode === "immersive-ar" ? { requiredFeatures: ["local"], optionalFeatures: ["hit-test", "dom-overlay"], domOverlay: { root: document.body } } : { optionalFeatures: ["local-floor", "bounded-floor"] });
        } catch (reason) {
          throw new Error(describeXrSessionRequestFailure(reason, mode));
        }
        session.addEventListener("end", this.handleXRSessionEnd.bind(this), { once: true });
        this.xrActive = true;
        this.xrSession = session;
        this.xrMode = mode;
        this.xrBackground = this.scene.background;
        if (mode === "immersive-ar") this.scene.background = null;
        this.xrSavedCamera = {
          position: this.camera.position.clone(),
          quaternion: this.camera.quaternion.clone(),
          scale: this.camera.scale.clone(),
          up: this.camera.up.clone(),
          target: this.orbit.target.clone(),
          fov: this.camera.fov,
          zoom: this.camera.zoom,
          near: this.camera.near,
          far: this.camera.far
        };
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
        this.xrRig.position.set(this.camera.position.x, this.camera.position.y - this.navigationSettings.eyeHeight, this.camera.position.z);
        this.xrRig.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);
        this.camera.position.set(0, 0, 0);
        this.camera.quaternion.identity();
        cancelAnimationFrame(this.animationFrame);
        try {
          this.renderer.xr.enabled = true;
          this.renderer.xr.setReferenceSpaceType(mode === "immersive-vr" ? "local-floor" : "local");
          this.setupXRControllers();
          this.renderer.setAnimationLoop(this.animate);
          await this.renderer.xr.setSession(session);
        } catch (reason) {
          // 会话建立后接线失败必须回滚，否则 xrActive/相机清零/xr.enabled 残留会让状态机卡死。
          this.finishXRSession(session);
          throw new Error(describeXrSessionSetupFailure(reason, mode));
        }
        if (!this.xrActive || this.xrSession !== session) return false;
        this.onXRSessionChange?.(mode);
        return true;
      } finally {
        this.xrStartPending = false;
      }
    }
  async endXR(): Promise<void> {
      if (!(this.renderer instanceof THREE.WebGLRenderer)) return;
      const session = this.xrSession ?? this.renderer.xr.getSession();
      if (!session) {
        this.finishXRSession();
        return;
      }
      try {
        await session.end();
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== "InvalidStateError") throw error;
      } finally {
        if (this.renderer.xr.getSession() === session) await this.renderer.xr.setSession(null);
        this.finishXRSession(session);
      }
    }
  /**
   * 控制器创建钩子：输入映射（select/squeeze → 选择命令）由具备拾取与选择
   * 命令的职责层覆盖实现，Rig 只负责会话与位姿。
   */
  protected onXRControllerCreated(_controller: THREE.Group): void {}
  protected setupXRControllers(): void {
      if (!(this.renderer instanceof THREE.WebGLRenderer) || this.xrControllers.length > 0) return;
      for (let index = 0; index < 2; index += 1) {
        const controller = this.renderer.xr.getController(index);
        controller.name = `helper:xr-controller-${index}`;
        const ray = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -3)]),
          new THREE.LineBasicMaterial({ color: index === 0 ? 0x64b5ff : 0xf0bd58, transparent: true, opacity: 0.82 })
        );
        ray.name = "helper:xr-ray";
        controller.add(ray);
        controller.addEventListener("connected", (event) => { controller.userData.inputSource = (event as unknown as { data: XRInputSource }).data; });
        controller.addEventListener("disconnected", () => { delete controller.userData.inputSource; });
        this.onXRControllerCreated(controller);
        this.xrRig.add(controller);
        this.xrControllers.push(controller);
      }
    }
  protected updateXRLocomotion(delta: number): void {
      if (!this.xrActive || this.xrMode !== "immersive-vr" || !(this.renderer instanceof THREE.WebGLRenderer)) return;
      let exitPressed = false;
      for (const controller of this.xrControllers) {
        const source = controller.userData.inputSource as XRInputSource | undefined;
        const gamepad = source?.gamepad;
        if (!source || !gamepad) continue;
        const { x, y, exitPressed: controllerExitPressed } = readXRThumbstick(gamepad.axes, gamepad.buttons);
        if (source.handedness === "left" && Math.hypot(x, y) > 0.16) {
          const xrCamera = this.renderer.xr.getCamera();
          const forward = xrCamera.getWorldDirection(new THREE.Vector3());
          forward.y = 0;
          if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
          forward.normalize();
          const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
          this.xrRig.position.addScaledVector(forward, -y * delta * 3).addScaledVector(right, x * delta * 3);
        }
        if (source.handedness === "right") {
          if (Math.abs(x) > 0.72 && this.xrSnapTurnReady) {
            const head = this.renderer.xr.getCamera().getWorldPosition(new THREE.Vector3());
            const angle = -Math.sign(x) * Math.PI / 6;
            this.xrRig.position.sub(head).applyAxisAngle(new THREE.Vector3(0, 1, 0), angle).add(head);
            this.xrRig.rotateY(angle);
            this.xrSnapTurnReady = false;
          } else if (Math.abs(x) < 0.25) this.xrSnapTurnReady = true;
        }
        exitPressed ||= controllerExitPressed;
      }
      if (exitPressed && !this.xrExitPressed) void this.endXR();
      this.xrExitPressed = exitPressed;
    }
  protected handleXRSessionEnd(event: Event): void {
      const session = event.currentTarget as unknown as XRSession | null;
      // The WebXRManager listener restores its framebuffer after session `end`
      // listeners run. Defer our editor restore until that browser event finishes.
      queueMicrotask(() => this.finishXRSession(session ?? undefined));
    }
  protected finishXRSession(session?: XRSession): void {
      if (!(this.renderer instanceof THREE.WebGLRenderer)) return;
      if (session && this.xrSession && session !== this.xrSession) return;
      if (!this.xrActive && !this.xrSession && !this.xrMode) return;
      this.renderer.setAnimationLoop(null);
      this.renderer.xr.enabled = false;
      this.xrActive = false;
      this.xrSession = undefined;
      this.xrMode = undefined;
      this.scene.background = this.xrBackground ?? null;
      for (const controller of this.xrControllers.splice(0)) this.disposeObject(controller);
      this.xrRig.position.set(0, 0, 0);
      this.xrRig.rotation.set(0, 0, 0);
      if (this.xrSavedCamera) {
        this.camera.position.copy(this.xrSavedCamera.position);
        this.camera.quaternion.copy(this.xrSavedCamera.quaternion);
        this.camera.scale.copy(this.xrSavedCamera.scale);
        this.camera.up.copy(this.xrSavedCamera.up);
        this.camera.fov = this.xrSavedCamera.fov;
        this.camera.zoom = this.xrSavedCamera.zoom;
        this.camera.near = this.xrSavedCamera.near;
        this.camera.far = this.xrSavedCamera.far;
        this.orbit.target.copy(this.xrSavedCamera.target);
        this.camera.updateMatrix();
        this.camera.updateMatrixWorld(true);
      }
      this.xrSavedCamera = undefined;
      this.resize();
      this.xrSnapTurnReady = true;
      this.xrExitPressed = false;
      this.onXRSessionChange?.(undefined);
      this.animate();
    }
}
