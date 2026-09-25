import * as THREE from "three";
import type { ClippingGroup } from "three/webgpu";
import type {
  CameraConstraintsState,
  CameraState,
  ClippingState,
  ExplosionMode,
  IndustrialPrefabInstanceState,
  ModelTransform,
  NavigationSettingsState,
  PrimitiveKind,
  PrimitiveState,
  SceneLayerState,
  SceneMaterialState,
  SceneModelEffectsState,
  SceneModelAnimationPlaybackState,
  ScenePhysicsBodyState,
  SceneRigState,
  SceneSpatialAudioState,
  Vector3Value,
} from "@bim-studio/contracts";
import { normalizeNavigationSettings } from "../navigationSettings";
import { type CollisionRecord } from "./analysis";
import { type NativeBimPropertiesFile } from "./bimMetadata";
import { setTreeVisibility } from "./fragmentTree";
import { explosionTargets, objectTransform, toValue, visibleObjectBox } from "./sceneObjectUtils";
import { detachSharedPrimitiveMaterials } from "./primitiveMaterial";
import { applySourceMaterialOpacity } from "./sourceMaterialOpacity";
import { type MeasureMode, type NavigationCollisionDiagnostics, type NavigationMode, type SelectionScope, type StandardView, type TransformMode } from "./viewerTypes";
import { DEFAULT_CAMERA_CONSTRAINTS, finiteCameraNumber } from "./viewerEngineTypes";
import { ViewerEngineMeasurements } from "./viewerEngineMeasurements";
import { loadViewerAssetJson } from "./viewerAssetTransport";
import { writeRobotPose } from "./robotPoseRuntime";

/** NavigationTools 职责层。 */
export abstract class ViewerEngineNavigationTools extends ViewerEngineMeasurements {
  /** TransformControls 是否正在拖拽;Deep 输入会话据此抑制视口手势。 */
  get isTransformDragging(): boolean { return this.transformDragging; }

  /** Deep 演示后端的视口手势接管开关;WebGL 兼容模式必须恢复 true。 */
  setViewportOrbitEnabled(enabled: boolean): void {
    this.viewportOrbitIntent = enabled;
    this.orbit.enabled = enabled && this.navigationMode !== "firstPerson";
  }

  /** 深色演示后端的手势接管缝:停用 OrbitControls,姿态经 applyViewportCameraPose 写回。 */
  enableViewportGestureTakeover(): boolean {
    if (this.navigationMode !== "orbit") return false;
    this.setViewportOrbitEnabled(false);
    return true;
  }

  disableViewportGestureTakeover(): void {
    this.setViewportOrbitEnabled(true);
  }

  isViewportGestureSuppressed(): boolean {
    return this.transformDragging;
  }

  /** 引擎中立姿态写回:相机单一事实源仍是 viewer.camera + orbit.target。 */
  applyViewportCameraPose(pose: { readonly eye: readonly [number, number, number]; readonly target: readonly [number, number, number] }): void {
    this.camera.position.set(pose.eye[0], pose.eye[1], pose.eye[2]);
    this.orbit.target.set(pose.target[0], pose.target[1], pose.target[2]);
    this.camera.updateMatrixWorld(true);
    this.cameraCollisionDirty = true;
  }

  select(id: string | undefined): void {
    this.selectedSceneLight = undefined;
    this.focusedSpaceKey = undefined;
    if (this.selectedAnnotationId) {
      const previous = this.selectedAnnotationId;
      this.selectedAnnotationId = undefined;
      this.refreshAnnotationVisual(previous);
      this.onAnnotationSelectionChange?.(undefined);
    }
    if (this.selectedId && this.fragmentModels.has(this.selectedId)) {
      void this.fragmentModels.get(this.selectedId)?.resetHighlight();
    }
    this.selectedId = id;
    this.selectedFragmentNodeId = undefined;
    this.inspectedObject = id ? this.models.get(id)?.object : undefined;
    this.updatePostProcessingSelection();
    const model = id ? this.models.get(id) : undefined;
    if (!model) this.transform.detach();
    this.updateTransformAccess();
    this.updateSelectionHelper();
    this.onSelectionChange?.(model);
  }
  setVisible(id: string, visible: boolean): void {
    const model = this.models.get(id);
    if (!model) return;
    model.visible = visible;
    model.object.visible = visible;
    const effectRuntime = this.modelEffectRuntimes.get(id);
    if (effectRuntime?.helper) effectRuntime.helper.visible = visible;
    const fragmentEntry = this.fragmentLayers.get(id)?.get("root");
    const fragmentModel = this.fragmentModels.get(id);
    if (fragmentEntry && fragmentModel) {
      setTreeVisibility(fragmentEntry.node, visible);
      if (!visible) {
        this.fragmentSelectionVersion += 1;
        void fragmentModel.resetHighlight();
      }
      void fragmentModel.setVisible(fragmentEntry.localIds, visible).then(() => this.fragments?.update(true));
    }
    if (!visible && this.selectedId === id) {
      this.removeSelectionHelper();
      this.updatePostProcessingSelection();
    } else this.updateSelectionHelper();
    this.syncSpaceVisuals();
    this.updateCollisions(true);
    this.markShadowMapDirty();
    this.onModelChange?.(model);
  }
  setOpacity(id: string, opacity: number): void {
    const model = this.models.get(id);
    if (!model) return;
    this.markShadowMapDirty();
    detachSharedPrimitiveMaterials(model.object, this.collisionOriginalMaterials);
    model.opacity = opacity;
    const fragmentEntry = this.fragmentLayers.get(id)?.get("root");
    const fragmentModel = this.fragmentModels.get(id);
    if (fragmentEntry && fragmentModel) void fragmentModel.setOpacity(fragmentEntry.localIds, opacity);
    model.object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      const materials = this.materialsForMesh(mesh);
      for (const material of materials) {
        applySourceMaterialOpacity(material, opacity);
      }
    });
    this.onModelChange?.(model);
  }
  rename(id: string, name: string): void {
    const model = this.models.get(id);
    if (!model) return;
    model.name = name;
    model.object.name = name;
    this.rebuildComponentIndex(id);
    this.onModelChange?.(model);
  }
  setTransformMode(mode: TransformMode): void {
    this.transform.setMode(mode);
  }
  setNavigationMode(mode: NavigationMode): void {
    if (this.sceneAnimationPlaying) this.pauseSceneAnimation();
    if (mode === this.navigationMode) {
      if (!this.isNavigationStateUsable(this.captureNavigationState(mode))) this.recoverNavigationMode(mode);
      return;
    }
    const previousMode = this.navigationMode;
    const anchor = this.navigationAnchor(previousMode);
    this.rememberNavigationState(previousMode);
    if (previousMode === "firstPerson" && this.pointer.isLocked) this.pointer.unlock();
    this.navigationMode = mode;
    this.configureNavigationControls(mode);
    const saved = this.navigationViewStates.get(mode);
    if (saved && this.isNavigationStateUsable(saved)) this.applyNavigationViewState(saved);
    else if (mode === "orbit") this.frameScene();
    else if (mode === "firstPerson") this.enterFirstPerson(anchor);
    else this.enterThirdPerson(anchor);
    this.rememberNavigationState(mode);
    if (this.avatar) this.avatar.visible = mode === "thirdPerson" && this.avatarVisible;
    this.emitCameraChange(true);
  }
  getNavigationMode(): NavigationMode {
    return this.navigationMode;
  }
  getCameraConstraints(): CameraConstraintsState {
    return structuredClone(this.cameraConstraints);
  }
  setCameraConstraints(state: CameraConstraintsState): void {
    const minDistance = Math.max(0.01, finiteCameraNumber(state.minDistance, DEFAULT_CAMERA_CONSTRAINTS.minDistance));
    const nearClip = Math.max(0.001, finiteCameraNumber(state.nearClip, DEFAULT_CAMERA_CONSTRAINTS.nearClip));
    const minPolarAngle = THREE.MathUtils.clamp(finiteCameraNumber(state.minPolarAngle, DEFAULT_CAMERA_CONSTRAINTS.minPolarAngle), 0, 179);
    this.cameraConstraints = {
      minDistance,
      maxDistance: Math.max(minDistance + 0.01, finiteCameraNumber(state.maxDistance, DEFAULT_CAMERA_CONSTRAINTS.maxDistance)),
      minPolarAngle,
      maxPolarAngle: THREE.MathUtils.clamp(Math.max(minPolarAngle + 0.1, finiteCameraNumber(state.maxPolarAngle, DEFAULT_CAMERA_CONSTRAINTS.maxPolarAngle)), 0.1, 180),
      nearClip,
      farClip: Math.max(nearClip + 0.1, finiteCameraNumber(state.farClip, DEFAULT_CAMERA_CONSTRAINTS.farClip)),
      collisionEnabled: Boolean(state.collisionEnabled),
      collisionRadius: Math.max(0.02, finiteCameraNumber(state.collisionRadius, DEFAULT_CAMERA_CONSTRAINTS.collisionRadius)),
    };
    this.configureNavigationControls(this.navigationMode);
    this.applyCameraClippingRange();
    this.resetCameraCollisionAnchor();
  }
  /**
   * 转换器生成的属性文件属于模型资源而非业务 API；网络读取收敛在 Viewer 资产边界，
   * 使通用 BIM 元数据模块保持无 I/O、可在单元测试中直接复用。
   */
  protected async loadNativeBimMetadata(url: string): Promise<NativeBimPropertiesFile> {
    return loadViewerAssetJson<NativeBimPropertiesFile>(url, "BIM 元数据");
  }
  setColor(id: string, color: string): void {
    const model = this.models.get(id);
    if (!model) return;
    this.markShadowMapDirty();
    this.setObjectColor(model.object, color);
    this.modelColorOverrides.set(id, color);
    this.onModelChange?.(model);
  }
  getNavigationSettings(): NavigationSettingsState {
    return structuredClone(this.navigationSettings);
  }
  setNavigationSettings(state: NavigationSettingsState): void {
    this.navigationSettings = normalizeNavigationSettings(state);
    this.lastNavigationDebugRefresh = 0;
  }
  getNavigationCollisionDiagnostics(): NavigationCollisionDiagnostics {
    return {
      debugVisible: this.navigationCollisionDebugVisible,
      blockingObjectCount: this.visibleModelObjects().length,
      raySamples: this.navigationRaySamples,
      lastSweepMs: this.lastNavigationSweepMs,
    };
  }
  setNavigationCollisionDebugVisible(visible: boolean): void {
    this.navigationCollisionDebugVisible = visible;
    this.navigationCollisionDebugGroup.visible = visible;
    this.lastNavigationDebugRefresh = 0;
    if (visible) this.updateNavigationCollisionDebug(performance.now(), true);
    this.onNavigationDiagnosticsChange?.(this.getNavigationCollisionDiagnostics());
  }
  setSelectionScope(scope: SelectionScope): void {
    this.selectionScope = scope;
    if (scope === "model" && this.selectedId) this.select(this.selectedId);
  }
  getSelectionScope(): SelectionScope {
    return this.selectionScope;
  }
  setAvatarVisible(visible: boolean): void {
    this.avatarVisible = visible;
    if (this.avatar) this.avatar.visible = visible && this.navigationMode === "thirdPerson";
  }
  isAvatarVisible(): boolean {
    return this.avatarVisible;
  }
  setCollisionEnabled(id: string, enabled: boolean): void {
    const model = this.models.get(id);
    if (!model) return;
    if (enabled) this.collisionEnabledIds.add(id);
    else this.collisionEnabledIds.delete(id);
    this.updateCollisions(true);
    this.onModelChange?.(model);
  }
  isCollisionEnabled(id: string): boolean {
    return this.collisionEnabledIds.has(id);
  }
  isColliding(id: string): boolean {
    return this.collidingIds.has(id);
  }
  getCollisionRecords(): CollisionRecord[] {
    return this.collisionRecords.map((record) => structuredClone(record));
  }
  focusCollision(record: CollisionRecord): void {
    const point = new THREE.Vector3(record.point.x, record.point.y, record.point.z);
    this.orbit.target.copy(point);
    this.camera.position.copy(point).add(new THREE.Vector3(1, 0.7, 1).normalize().multiplyScalar(6));
    this.orbit.update();
  }
  getClippingState(): ClippingState {
    return structuredClone(this.clippingState);
  }
  getClippingRange(axis: ClippingState["axis"]): { min: number; max: number } {
    const box = this.visibleSceneBox();
    if (box.isEmpty()) return { min: -10, max: 10 };
    return { min: box.min[axis], max: box.max[axis] };
  }
  getClippingBounds(): { min: Vector3Value; max: Vector3Value } {
    const box = this.visibleSceneBox();
    if (box.isEmpty()) box.set(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10));
    return { min: toValue(box.min), max: toValue(box.max) };
  }
  setClipping(state: ClippingState): void {
    const mode = state.mode ?? "axis";
    this.clippingState = structuredClone({ ...state, mode });
    this.disposeClippingHelper();
    if (!state.enabled) {
      this.setRendererClippingPlanes([]);
      this.updateToolCursor();
      return;
    }
    if (mode === "box") {
      const bounds = state.box ?? this.getClippingBounds();
      const min = new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z);
      const max = new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z);
      this.setRendererClippingPlanes([
        new THREE.Plane(new THREE.Vector3(1, 0, 0), -min.x),
        new THREE.Plane(new THREE.Vector3(-1, 0, 0), max.x),
        new THREE.Plane(new THREE.Vector3(0, 1, 0), -min.y),
        new THREE.Plane(new THREE.Vector3(0, -1, 0), max.y),
        new THREE.Plane(new THREE.Vector3(0, 0, 1), -min.z),
        new THREE.Plane(new THREE.Vector3(0, 0, -1), max.z),
      ]);
      if (state.showHelper !== false) {
        this.clippingHelper = new THREE.Box3Helper(new THREE.Box3(min, max), 0xf6c453);
        this.clippingHelper.name = "helper:clipping-box";
        this.clippingHelper.renderOrder = 30;
        this.scene.add(this.clippingHelper);
      }
      this.updateToolCursor();
      return;
    }
    if (mode === "face") {
      if (!state.face) {
        this.setRendererClippingPlanes([]);
        this.updateToolCursor();
        return;
      }
      const direction = state.inverted ? -1 : 1;
      const normal = new THREE.Vector3(state.face.normal.x, state.face.normal.y, state.face.normal.z).normalize().multiplyScalar(direction);
      const point = new THREE.Vector3(state.face.point.x, state.face.point.y, state.face.point.z);
      this.setRendererClippingPlanes([new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point)]);
      this.updateToolCursor();
      return;
    }
    const direction = state.inverted ? -1 : 1;
    const normal = new THREE.Vector3(state.axis === "x" ? direction : 0, state.axis === "y" ? direction : 0, state.axis === "z" ? direction : 0);
    this.setRendererClippingPlanes([new THREE.Plane(normal, -state.offset * direction)]);
    this.updateToolCursor();
  }
  protected setRendererClippingPlanes(planes: THREE.Plane[]): void {
    if (this.rendererBackend === "webgpu") {
      const clippingRoot = this.modelRoot as ClippingGroup;
      clippingRoot.clippingPlanes = planes;
      clippingRoot.enabled = planes.length > 0;
      return;
    }
    (this.renderer as THREE.WebGLRenderer).clippingPlanes = planes;
  }
  protected visibleSceneBox(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const model of this.models.values()) if (model.visible) box.union(visibleObjectBox(model.object));
    return box;
  }
  protected disposeClippingHelper(): void {
    if (!this.clippingHelper) return;
    this.disposeObject(this.clippingHelper);
    this.clippingHelper = undefined;
  }
  protected updateToolCursor(): void {
    const pickingFace = this.clippingState.enabled && this.clippingState.mode === "face" && !this.clippingState.face;
    this.renderer.domElement.style.cursor = this.measureEnabled || this.annotationPlacementEnabled || this.primitivePlacementKind || pickingFace ? "crosshair" : "default";
  }
  getExplosionFactor(modelId: string): number {
    return this.explosionFactors.get(modelId) ?? 0;
  }
  getExplosionMode(modelId: string): ExplosionMode {
    return this.explosionModes.get(modelId) ?? "radial";
  }
  setExplosion(modelId: string, factor: number, mode: ExplosionMode = this.getExplosionMode(modelId)): void {
    const model = this.models.get(modelId);
    if (!model || model.kind !== "model") return;
    const normalized = THREE.MathUtils.clamp(factor, 0, 2);
    this.explosionModes.set(modelId, mode);
    let originals = this.explosionPositions.get(modelId);
    if (!originals) {
      originals = new Map();
      for (const object of explosionTargets(model.object)) originals.set(object, object.position.clone());
      this.explosionPositions.set(modelId, originals);
    }
    for (const [object, position] of originals) object.position.copy(position);
    model.object.updateWorldMatrix(true, true);
    if (normalized <= 0.0001) {
      this.explosionFactors.delete(modelId);
      this.explosionPositions.delete(modelId);
      this.updateCollisions(true);
      this.markShadowMapDirty();
      this.onModelChange?.(model);
      return;
    }
    const modelBox = visibleObjectBox(model.object);
    const center = modelBox.getCenter(new THREE.Vector3());
    const distance = Math.max(modelBox.getSize(new THREE.Vector3()).length() * 0.12, 1) * normalized;
    for (const [object, position] of originals) {
      const objectCenter = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
      const worldDirection = objectCenter.sub(center);
      if (mode === "vertical") worldDirection.set(0, Math.sign(worldDirection.y) || 1, 0);
      else if (mode === "x") worldDirection.set(Math.sign(worldDirection.x) || 1, 0, 0);
      else if (mode === "y") worldDirection.set(0, Math.sign(worldDirection.y) || 1, 0);
      else if (mode === "z") worldDirection.set(0, 0, Math.sign(worldDirection.z) || 1);
      else if (worldDirection.lengthSq() < 0.000001) worldDirection.set(0, 1, 0);
      worldDirection.normalize();
      const parentInverse = new THREE.Matrix4().copy(object.parent?.matrixWorld ?? new THREE.Matrix4()).invert();
      const localDirection = worldDirection.transformDirection(parentInverse);
      object.position.copy(position).addScaledVector(localDirection, distance);
    }
    model.object.updateWorldMatrix(true, true);
    this.markShadowMapDirty();
    this.explosionFactors.set(modelId, normalized);
    this.updateCollisions(true);
    this.onModelChange?.(model);
  }
  setMeasureEnabled(enabled: boolean, mode: MeasureMode = this.measureMode): void {
    this.measureEnabled = enabled;
    this.measureMode = mode;
    this.measurementPoints.length = 0;
    this.measurementTargets.length = 0;
    this.removeMeasurementPreview();
    this.onMeasurementDraftChange?.(false);
    this.updateToolCursor();
  }
  setMeasureMode(mode: MeasureMode): void {
    this.measureMode = mode;
    this.measurementPoints.length = 0;
    this.measurementTargets.length = 0;
    this.removeMeasurementPreview();
    this.onMeasurementDraftChange?.(false);
  }
  fitAll(): void {
    if (this.navigationMode !== "orbit") this.setNavigationMode("orbit");
    this.frameScene();
    this.rememberNavigationState("orbit");
    this.emitCameraChange(true);
  }
  protected frameScene(): void {
    this.focusBox(this.sceneContentBox(), new THREE.Vector3(0.8, 0.55, 0.8));
  }
  getCameraState(): CameraState {
    const view = this.captureNavigationState(this.navigationMode);
    return {
      position: toValue(view.position),
      target: toValue(view.target),
      mode: this.navigationMode,
      avatarVisible: this.avatarVisible,
    };
  }
  applyCamera(state: CameraState): void {
    if (this.pointer.isLocked) this.pointer.unlock();
    this.navigationViewStates.clear();
    this.camera.up.set(0, 1, 0);
    this.camera.position.set(state.position.x, state.position.y, state.position.z);
    this.orbit.target.set(state.target.x, state.target.y, state.target.z);
    this.navigationMode = state.mode;
    this.configureNavigationControls(state.mode);
    this.setAvatarVisible(state.avatarVisible ?? false);
    if (state.mode === "thirdPerson") {
      this.ensureAvatar();
      this.avatar?.position.copy(this.orbit.target).add(new THREE.Vector3(0, -1.25, 0));
    }
    if (!this.isNavigationStateUsable(this.captureNavigationState(state.mode))) this.recoverNavigationMode(state.mode);
    this.orbit.update();
    this.rememberNavigationState(state.mode);
    this.resetCameraCollisionAnchor();
    this.emitCameraChange(true);
  }
  setStandardView(view: StandardView): void {
    if (this.navigationMode !== "orbit") this.setNavigationMode("orbit");
    const selected = this.getSelected();
    const targetObject = this.inspectedObject && this.inspectedObject !== selected?.object ? this.inspectedObject : undefined;
    const box = targetObject ? new THREE.Box3().setFromObject(targetObject) : this.sceneContentBox();
    if (box.isEmpty()) return;
    const directions: Record<StandardView, THREE.Vector3> = {
      top: new THREE.Vector3(0, 1, 0),
      bottom: new THREE.Vector3(0, -1, 0),
      left: new THREE.Vector3(-1, 0, 0),
      right: new THREE.Vector3(1, 0, 0),
      front: new THREE.Vector3(0, 0, 1),
      back: new THREE.Vector3(0, 0, -1),
    };
    const up = new THREE.Vector3(0, 1, 0);
    if (view === "top") up.set(0, 0, -1);
    if (view === "bottom") up.set(0, 0, 1);
    if (!this.focusBox(box, directions[view], up)) return;
    this.rememberNavigationState("orbit");
    this.emitCameraChange(true);
  }
  getModelTransform(id: string): ModelTransform | undefined {
    const object = this.models.get(id)?.object;
    if (!object) return undefined;
    const authored = this.authorModelTransforms?.get(id);
    if (authored) return structuredClone(authored);
    const initial = objectTransform(object);
    this.authorModelTransforms?.set(id, structuredClone(initial));
    return structuredClone(initial);
  }
  applyModelState(
    id: string,
    state: {
      visible: boolean;
      locked?: boolean;
      opacity: number;
      color?: string;
      colorOverride?: string;
      material?: SceneMaterialState;
      effects?: SceneModelEffectsState;
      prefab?: IndustrialPrefabInstanceState;
      rig?: SceneRigState;
      robotPose?: Record<string, number>;
      spatialAudio?: SceneSpatialAudioState;
      physics?: ScenePhysicsBodyState;
      transform: ModelTransform;
      collisionEnabled?: boolean;
      explosionFactor?: number;
      explosionMode?: ExplosionMode;
      animationEnabled?: boolean;
      animationPlayback?: SceneModelAnimationPlaybackState;
      layers?: SceneLayerState[];
    },
  ): void {
    const model = this.models.get(id);
    if (!model) return;
    model.object.position.set(state.transform.position.x, state.transform.position.y, state.transform.position.z);
    model.object.rotation.set(state.transform.rotation.x, state.transform.rotation.y, state.transform.rotation.z);
    model.object.scale.set(state.transform.scale.x, state.transform.scale.y, state.transform.scale.z);
    this.setVisible(id, state.visible);
    this.setOpacity(id, state.opacity);
    // `color` in schema v1 was inferred from the first material and corrupted
    // multi-material BIM models on restore. Only an explicit override is valid.
    if (state.colorOverride) {
      this.setObjectColor(model.object, state.colorOverride);
      this.modelColorOverrides.set(id, state.colorOverride);
    }
    if (state.material) {
      this.applyMaterialState(model.object, state.material);
      this.modelMaterialOverrides.set(id, structuredClone(state.material));
    }
    this.applyLayerStates(id, state.layers);
    this.setModelLocked(id, state.locked ?? false);
    this.setCollisionEnabled(id, state.collisionEnabled ?? false);
    this.setExplosion(id, state.explosionFactor ?? 0, state.explosionMode ?? "radial");
    if (this.hasAnimation(id)) {
      const playback = state.animationPlayback ?? { autoplay: state.animationEnabled ?? true, loopMode: "loop" };
      this.setModelAnimationPlaybackState(id, playback);
      this.setAnimationEnabled(id, state.animationEnabled ?? playback.autoplay);
    }
    if (state.rig) this.setModelRigState(id, state.rig);
    writeRobotPose(model.object, state.robotPose ?? {}, true, true);
    this.setSpatialAudioState(id, state.spatialAudio);
    model.object.updateWorldMatrix(true, true);
    this.syncFragmentsTransformState(id);
    if (state.physics) void this.setPhysicsBodyState(id, state.physics);
    if (state.effects) this.setModelEffects(id, state.effects);
    const prefab = state.prefab?.motionRoute?.autoplay && state.prefab.operatingState === "idle"
      ? { ...state.prefab, operatingState: "running" as const }
      : state.prefab;
    this.setIndustrialPrefabState(id, prefab);
  }
  primitiveState(id: string, color: string): PrimitiveState | undefined {
    const model = this.models.get(id);
    const transform = this.getModelTransform(id);
    if (!model || model.kind !== "primitive" || !transform) return undefined;
    const prefab = this.getIndustrialPrefabState(id);
    const spatialAudio = this.getSpatialAudioState(id);
    return {
      modelId: id,
      name: model.name,
      kind: (model.object.userData.primitiveKind as PrimitiveKind | undefined) ?? "box",
      color: this.getModelColor(id) || color,
      visible: model.visible,
      locked: this.isModelLocked(id),
      opacity: model.opacity,
      transform,
      collisionEnabled: this.isCollisionEnabled(id),
      explosionFactor: this.getExplosionFactor(id),
      material: this.getMaterialState(model.object),
      ...(spatialAudio ? { spatialAudio } : {}),
      effects: this.getModelEffects(id),
      physics: this.getPhysicsBodyState(id),
      ...(prefab ? { prefab } : {}),
    };
  }
}
