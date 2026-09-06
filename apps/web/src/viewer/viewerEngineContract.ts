import type * as FRAGS from "@thatopen/fragments";
import DxfParser from "dxf-parser";
import * as THREE from "three";
import type { ClippingGroup } from "three/webgpu";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import { exportFbxAscii } from "./fbxExporter";
import type {
  CameraConstraintsState,
  CameraState,
  ClippingState,
  DataMessage,
  ExplosionMode,
  GlobalLightingState,
  IndustrialPrefabInstanceState,
  IndustrialPrefabRuntimeAction,
  MeasurementState,
  ModelManifest,
  ModelTransform,
  NavigationSettingsState,
  PrimitiveKind,
  PrimitiveState,
  RobotAssetDefinition,
  SceneAnnotationState,
  SceneAnimationState,
  SceneEnvironmentState,
  SceneFloorState,
  SceneInteractionScriptState,
  SceneInteractionActionState,
  SceneInteractionTarget,
  SceneInteractionTrigger,
  SceneIKConstraintState,
  SceneLayerState,
  SceneLightState,
  SceneMaterialState,
  SceneModelEffectsState,
  SceneModelAnimationPlaybackState,
  ScenePhysicsBodyState,
  ScenePhysicsState,
  ScenePostProcessingState,
  SceneRigState,
  SceneSpatialAudioState,
  SkyboxPreset,
  Vector3Value,
  WeatherMode,
} from "@bim-studio/contracts";
import { normalizeNavigationSettings } from "../navigationSettings";
import { readXRThumbstick } from "./xrInput";
import { isWalkableSurface, slideAgainstSurface } from "./characterMotion";
import {
  buildComponentRecords,
  closestPointsBetweenObjects,
  componentFacets,
  filterComponents,
  preciseIntersection,
  type CollisionRecord,
  type ComponentFacets,
  type ComponentFilter,
  type ComponentRecord,
} from "./analysis";
import { normalizeAnimationFrameRate, sampleCameraKeyframes, sampleModelAnimationKeyframes, sampleModelKeyframes, snapAnimationTime } from "./timeline";
import { solveBoneChainIK } from "./ik";
import { constrainMeasurementEnd, elevationSegment, measurementAngle, projectRayToVerticalAxis } from "./measurement";
import {
  firstProperty,
  flattenProperties,
  hydrateNativeBimMetadata,
  isVectorValue,
  nearestBimElement,
  scalarText,
  uniqueComponentRecords,
  vectorValue,
  type NativeBimPropertiesFile,
  type NativeBimSpaceMetadata,
} from "./bimMetadata";
import { dxfDrawingExtents, dxfPoints, dxfUnitName, dxfUnitScale, pointsIntersectExtents, type DxfDocument } from "./dxfGeometry";
import { primitiveGeometry, primitiveGroundOffset, primitiveKindName } from "./primitiveGeometry";
import { collectSpatialLocalIds, fragmentItemProperties, fragmentPropertyValue, humanizeIfcCategory, setTreeLock, setTreeVisibility } from "./fragmentTree";
import {
  applyTransform,
  explosionTargets,
  isAncestorOf,
  isFiniteBox,
  normalizedSpaceBox,
  objectTransform,
  objectVisibleMeshCount,
  sanitizeExportObject,
  spaceVisualKey,
  toValue,
  visibleObjectBox,
} from "./sceneObjectUtils";
import { countObjects, heatMapColor, normalizeAnnotation, sameRuntimeInteractionTarget } from "./viewerStateUtils";
import { createAnnotationVisual, createMeasurementVisual, disposeViewerObject } from "./sceneOverlayVisuals";
import type { ViewerPostProcessingRuntime } from "./viewerPostProcessingRuntime";
import { type FramePerformanceSnapshot, type RendererLoadSnapshot } from "./framePerformanceMonitor";
import { createStudioViewerAPI } from "../studio/studioApi";
import {
  associateSpace,
  evaluatePlacement,
  planBimQuestion,
  relevantProperties,
  type BimAssistantComponentEvidence,
  type BimAssistantPreparedContext,
  type BimBoundsValue,
} from "../bimAssistant";
import {
  ModelLoadSupersededError,
  shouldRenderSceneLightProxy,
  type AnnotationPointerHit,
  type BimSpaceRecord,
  type InteractionEventDetail,
  type LayerTreeNode,
  type LoadedSceneModel,
  type MeasureMode,
  type NavigationCollisionDiagnostics,
  type NavigationMode,
  type RendererBackend,
  type SceneStatistics,
  type SelectionScope,
  type StandardView,
  type TransformMode,
} from "./viewerTypes";
import {
  DEFAULT_CAMERA_CONSTRAINTS,
  DEFAULT_MODEL_EFFECTS,
  DEFAULT_SCENE_LIGHTS,
  finiteCameraNumber,
  type FragmentLayerEntry,
  type MaterialTextureMetadataKey,
  type MaterialTextureSlot,
  type NavigationViewState,
  type PointerSceneHit,
  type RendererInfoLike,
} from "./viewerEngineTypes";
import type { RendererInstance } from "./viewerRendererTypes";

/** 跨职责层使用的完整方法契约；受保护成员不会暴露到最终公共 API。 */
export abstract class ViewerEngineContract {
  abstract getRendererBackend(): RendererBackend;
  /** 发布运行时的自动质量守卫；保留完整模型和作者效果，仅处理持续填充率压力。 */
  abstract setFastRuntime(enabled: boolean): void;
  abstract listModels(): LoadedSceneModel[];
  /** Trusted script escape hatches. Prefer the stable studio API for ordinary work. */
  abstract getRawObject(modelId: string): THREE.Object3D | undefined;
  abstract getRawScene(): THREE.Scene;
  abstract getRawCamera(): THREE.PerspectiveCamera;
  abstract getRawRenderer(): RendererInstance;
  abstract setInteractionScripts(scripts: SceneInteractionScriptState[]): void;
  abstract getInteractionScripts(): SceneInteractionScriptState[];
  abstract dispatchInteraction(trigger: SceneInteractionTrigger, target: SceneInteractionTarget, detail?: InteractionEventDetail): void;
  protected abstract dispatchExactInteraction(trigger: SceneInteractionTrigger, target: SceneInteractionTarget, detail?: InteractionEventDetail): void;
  protected abstract dispatchObjectLifecycle(trigger: "load" | "animationStart" | "animationEnd", modelId: string): void;
  abstract getIndustrialPrefabState(modelId: string): IndustrialPrefabInstanceState | undefined;
  abstract setIndustrialPrefabState(modelId: string, state: IndustrialPrefabInstanceState | undefined): void;
  abstract executeIndustrialPrefabAction(modelId: string, action: IndustrialPrefabRuntimeAction): void;
  abstract runInteractionScript(script: SceneInteractionScriptState, detail?: InteractionEventDetail): Promise<void>;
  abstract executeInteractionAction(target: SceneInteractionTarget, action: SceneInteractionActionState): Promise<void>;
  protected abstract runInteractionAction(target: SceneInteractionTarget, action: SceneInteractionActionState): Promise<void>;
  protected abstract interactionTargetContext(target: SceneInteractionTarget, detail: InteractionEventDetail): Record<string, unknown>;
  abstract listAnnotations(): SceneAnnotationState[];
  abstract getSelectedAnnotationId(): string | undefined;
  abstract setAnnotationPlacementEnabled(enabled: boolean): void;
  abstract isAnnotationPlacementEnabled(): boolean;
  abstract addAnnotation(annotation: SceneAnnotationState): void;
  abstract updateAnnotation(id: string, patch: Partial<Omit<SceneAnnotationState, "id">>): SceneAnnotationState | undefined;
  abstract removeAnnotation(id: string, notify?: boolean): void;
  abstract clearAnnotations(notify?: boolean): void;
  abstract selectAnnotation(id: string | undefined): void;
  abstract focusAnnotation(id: string): void;
  abstract getSceneStatistics(): SceneStatistics;
  abstract getFrameRate(): number;
  abstract getPerformanceSnapshot(): FramePerformanceSnapshot;
  abstract setGpuTimingEnabled(enabled: boolean): void;
  abstract applySceneDataMessage(message: DataMessage): boolean;
  abstract hasAnimation(id: string): boolean;
  abstract listAnimationClips(id: string): Array<{
    id: string;
    name: string;
    duration: number;
  }>;
  abstract getAnimationPlayback(id: string):
    | {
        clipId?: string;
        time: number;
        duration: number;
        playing: boolean;
        autoplay: boolean;
        loopMode: SceneModelAnimationPlaybackState["loopMode"];
      }
    | undefined;
  abstract getModelAnimationPlaybackState(id: string): SceneModelAnimationPlaybackState;
  abstract setModelAnimationPlaybackState(id: string, state: SceneModelAnimationPlaybackState): void;
  abstract controlAnimation(
    id: string,
    control: {
      action: "play" | "pause" | "stop" | "seek";
      clipId?: string;
      time?: number;
    },
  ): boolean;
  abstract isAnimationEnabled(id: string): boolean;
  abstract setAnimationEnabled(id: string, enabled: boolean): void;
  abstract hasSkeleton(modelId: string): boolean;
  abstract getRobotDefinition(modelId: string): RobotAssetDefinition | undefined;
  abstract getRobotPose(modelId: string): Record<string, number> | undefined;
  abstract setRobotPose(modelId: string, values: Record<string, number>): boolean;
  abstract applyRobotTelemetry(modelId: string, values: Record<string, number>): boolean;
  abstract restoreRobotPose(modelId: string): void;
  abstract listModelBones(modelId: string): Array<{
    path: string;
    name: string;
    depth: number;
    parentPath?: string;
    linkLength: number;
  }>;
  abstract getBoneRotation(modelId: string, bonePath: string): Vector3Value | undefined;
  abstract setBoneRotation(modelId: string, bonePath: string, rotation: Vector3Value): boolean;
  abstract resetBonePose(modelId: string, bonePath?: string): void;
  abstract getModelRigState(modelId: string): SceneRigState | undefined;
  abstract setModelRigState(modelId: string, rig: SceneRigState): void;
  abstract createIKConstraint(modelId: string, effectorBonePath: string): SceneIKConstraintState | undefined;
  abstract updateIKConstraint(modelId: string, constraintId: string, patch: Partial<Omit<SceneIKConstraintState, "id">>): SceneIKConstraintState | undefined;
  abstract removeIKConstraint(modelId: string, constraintId: string): void;
  abstract getWeather(): WeatherMode;
  abstract setWeather(mode: WeatherMode): void;
  abstract getSceneEnvironment(): SceneEnvironmentState;
  abstract setSceneEnvironment(state: SceneEnvironmentState): void;
  abstract getGlobalLighting(): GlobalLightingState;
  abstract setGlobalLighting(state: GlobalLightingState): void;
  abstract getSelectionMaterial(): SceneMaterialState;
  abstract setSelectionMaterial(patch: SceneMaterialState): void;
  abstract getModelMaterialState(id: string): SceneMaterialState | undefined;
  abstract getModelMaterialOverride(id: string): SceneMaterialState | undefined;
  abstract setModelMaterial(id: string, patch: SceneMaterialState): void;
  abstract getSpatialAudioState(id: string): SceneSpatialAudioState | undefined;
  abstract setSpatialAudioState(id: string, state: SceneSpatialAudioState | undefined): void;
  abstract controlSpatialAudio(id: string, action: "play" | "pause" | "stop" | "replay"): void;
  protected abstract unlockSpatialAudio(): Promise<void>;
  abstract getModelEffects(id: string): SceneModelEffectsState;
  abstract setModelEffects(id: string, state: SceneModelEffectsState): void;
  abstract getPostProcessing(): ScenePostProcessingState;
  abstract setPostProcessing(state: ScenePostProcessingState): void;
  abstract getFloorStates(modelId?: string): SceneFloorState[];
  abstract applyFloorStates(states: SceneFloorState[] | undefined): void;
  abstract setFloorState(modelId: string, level: string, visible: boolean, expansion?: number): void;
  abstract selectSceneLight(id: string, handle?: "position" | "target"): boolean;
  abstract clearSceneLightSelection(): void;
  abstract isXRSupported(mode: "immersive-vr" | "immersive-ar"): Promise<boolean>;
  abstract startXR(mode: "immersive-vr" | "immersive-ar"): Promise<boolean>;
  abstract endXR(): Promise<void>;
  protected abstract setupXRControllers(): void;
  protected abstract updateXRLocomotion(delta: number): void;
  protected abstract handleXRSessionEnd(event: Event): void;
  protected abstract finishXRSession(session?: XRSession): void;
  abstract getPhysicsState(): ScenePhysicsState;
  abstract setPhysicsState(state: ScenePhysicsState): void;
  abstract getPhysicsBodyState(id: string): ScenePhysicsBodyState;
  abstract setPhysicsBodyState(id: string, state: ScenePhysicsBodyState): Promise<void>;
  abstract resetPhysics(): void;
  protected abstract ensurePhysicsWorld(): Promise<void>;
  protected abstract createPhysicsBody(id: string, state: ScenePhysicsBodyState): void;
  protected abstract removePhysicsBody(id: string): void;
  protected abstract rebuildPhysicsBody(id: string): void;
  protected abstract updatePhysics(delta: number): void;
  abstract getSceneAnimation(): SceneAnimationState;
  abstract setSceneAnimation(animation: SceneAnimationState): void;
  abstract seekSceneAnimation(time: number): void;
  abstract playSceneAnimation(): void;
  abstract pauseSceneAnimation(): void;
  abstract isSceneAnimationPlaying(): boolean;
  abstract searchComponents(filter: ComponentFilter, limit?: number): ComponentRecord[];
  abstract getComponentFacets(): ComponentFacets;
  abstract getComponentCount(): number;
  abstract prepareBimAssistantContext(question: string): Promise<BimAssistantPreparedContext>;
  abstract applyBimAssistantAction(
    action: "focus" | "isolate" | "show-placement" | "clear-isolation" | "clear-placement",
    context: BimAssistantPreparedContext,
    componentId?: string,
  ): boolean;
  protected abstract clearBimPlacementPreview(): void;
  protected abstract componentBounds(record: ComponentRecord): Promise<BimBoundsValue | undefined>;
  abstract getSpaces(): BimSpaceRecord[];
  abstract focusSpace(space: BimSpaceRecord): boolean;
  abstract isSpaceVisible(space: BimSpaceRecord): boolean;
  abstract setSpaceVisible(space: BimSpaceRecord, visible: boolean): boolean;
  abstract setSpacesVisible(spaces: BimSpaceRecord[], visible: boolean): number;
  abstract getSelectedComponentRecord(): ComponentRecord | undefined;
  abstract focusComponent(record: ComponentRecord): void;
  abstract isolateComponents(records: ComponentRecord[]): void;
  abstract isolateModels(modelIds: string[]): void;
  protected abstract isolateObjects(targets: THREE.Object3D[]): void;
  abstract clearIsolation(): void;
  abstract isIsolationActive(): boolean;
  abstract getSelected(): LoadedSceneModel | undefined;
  abstract exportSceneGlb(options?: { scope?: "all" | "visible" }): Promise<ArrayBuffer>;
  abstract exportSceneFbx(): Promise<string>;
  protected abstract buildFragmentsExportObject(model: LoadedSceneModel, fragmentsModel: FRAGS.FragmentsModel, includeHidden?: boolean): Promise<THREE.Group>;
  abstract getSelectedLayerId(): string | undefined;
  abstract isModelLocked(modelId: string): boolean;
  abstract setModelLocked(modelId: string, locked: boolean): void;
  abstract isLayerLocked(modelId: string, nodeId: string): boolean;
  abstract setLayerLocked(modelId: string, nodeId: string, locked: boolean): void;
  abstract isSelectionLocked(): boolean;
  abstract getSelectionName(): string;
  abstract getSelectionVisible(): boolean;
  abstract getSelectionOpacity(): number;
  abstract getSelectionColor(): string;
  abstract getModelColor(id: string): string;
  abstract getModelColorOverride(id: string): string | undefined;
  abstract setSelectionColor(color: string): void;
  abstract getSelectionProperties(): Record<string, string>;
  abstract getLayerTree(modelId: string): LayerTreeNode | undefined;
  abstract selectLayer(modelId: string, nodeId: string): void;
  abstract setLayerVisible(modelId: string, nodeId: string, visible: boolean): void;
  abstract getLayerStates(modelId: string): SceneLayerState[];
  abstract applyLayerStates(modelId: string, states: SceneLayerState[] | undefined): void;
  abstract renameSelection(name: string): void;
  abstract setSelectionVisible(visible: boolean): void;
  abstract setSelectionOpacity(opacity: number): void;
  abstract getSelectionTransform(): ModelTransform | undefined;
  abstract applySelectionTransform(transform: ModelTransform): void;
  abstract deleteSelectedLayer(): boolean;
  abstract loadManifest(manifest: ModelManifest, instanceId?: string): Promise<LoadedSceneModel>;
  abstract replaceModelManifest(instanceId: string, manifest: ModelManifest): Promise<LoadedSceneModel>;
  /**
   * IFC/Fragments 仅在实际加载对应模型时初始化。常规 glTF、FBX 与 DXF 浏览不再承担
   * web-ifc、Fragments worker 和空间树运行时的下载与内存成本。
   */
  protected abstract ensureFragmentRuntime(): Promise<void>;
  protected abstract requireFragmentRuntime(): {
    fragments: FRAGS.FragmentsModels;
    importer: FRAGS.IfcImporter;
    api: typeof import("@thatopen/fragments");
  };
  protected abstract loadManifestOnce(manifest: ModelManifest, epoch: number, assetModelId?: string, replacing?: LoadedSceneModel): Promise<LoadedSceneModel>;
  protected abstract streamGltfLevels(
    modelId: string,
    container: THREE.Object3D,
    stream: {
      levels: Array<{
        url: string;
        name: string;
      }>;
      metadata?: NativeBimPropertiesFile;
    },
    epoch: number,
  ): Promise<void>;
  abstract createPrimitive(id: string, name: string, kind?: PrimitiveKind, color?: string, position?: THREE.Vector3): LoadedSceneModel;
  abstract createBox(id: string, name: string, color?: string): LoadedSceneModel;
  abstract startPrimitivePlacement(kind: PrimitiveKind): void;
  abstract cancelPrimitivePlacement(): void;
  abstract removeModel(id: string): void;
  abstract setReadOnly(readOnly: boolean): void;
  abstract clearSceneModels(): void;
  abstract select(id: string | undefined): void;
  abstract setVisible(id: string, visible: boolean): void;
  abstract setOpacity(id: string, opacity: number): void;
  abstract rename(id: string, name: string): void;
  abstract setTransformMode(mode: TransformMode): void;
  abstract setNavigationMode(mode: NavigationMode): void;
  abstract getNavigationMode(): NavigationMode;
  abstract getCameraConstraints(): CameraConstraintsState;
  abstract setCameraConstraints(state: CameraConstraintsState): void;
  /**
   * 转换器生成的属性文件属于模型资源而非业务 API；网络读取收敛在 Viewer 资产边界，
   * 使通用 BIM 元数据模块保持无 I/O、可在单元测试中直接复用。
   */
  protected abstract loadNativeBimMetadata(url: string): Promise<NativeBimPropertiesFile>;
  abstract setColor(id: string, color: string): void;
  abstract getNavigationSettings(): NavigationSettingsState;
  abstract setNavigationSettings(state: NavigationSettingsState): void;
  abstract getNavigationCollisionDiagnostics(): NavigationCollisionDiagnostics;
  abstract setNavigationCollisionDebugVisible(visible: boolean): void;
  abstract setSelectionScope(scope: SelectionScope): void;
  abstract getSelectionScope(): SelectionScope;
  abstract setAvatarVisible(visible: boolean): void;
  abstract isAvatarVisible(): boolean;
  abstract setCollisionEnabled(id: string, enabled: boolean): void;
  abstract isCollisionEnabled(id: string): boolean;
  abstract isColliding(id: string): boolean;
  abstract getCollisionRecords(): CollisionRecord[];
  abstract focusCollision(record: CollisionRecord): void;
  abstract getClippingState(): ClippingState;
  abstract getClippingRange(axis: ClippingState["axis"]): {
    min: number;
    max: number;
  };
  abstract getClippingBounds(): {
    min: Vector3Value;
    max: Vector3Value;
  };
  abstract setClipping(state: ClippingState): void;
  protected abstract setRendererClippingPlanes(planes: THREE.Plane[]): void;
  protected abstract visibleSceneBox(): THREE.Box3;
  protected abstract disposeClippingHelper(): void;
  protected abstract updateToolCursor(): void;
  abstract getExplosionFactor(modelId: string): number;
  abstract getExplosionMode(modelId: string): ExplosionMode;
  abstract setExplosion(modelId: string, factor: number, mode?: ExplosionMode): void;
  abstract setMeasureEnabled(enabled: boolean, mode?: MeasureMode): void;
  abstract setMeasureMode(mode: MeasureMode): void;
  abstract fitAll(): void;
  protected abstract frameScene(): void;
  abstract getCameraState(): CameraState;
  abstract applyCamera(state: CameraState): void;
  abstract setStandardView(view: StandardView): void;
  abstract getModelTransform(id: string): ModelTransform | undefined;
  abstract applyModelState(
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
      physics?: ScenePhysicsBodyState;
      transform: ModelTransform;
      collisionEnabled?: boolean;
      explosionFactor?: number;
      explosionMode?: ExplosionMode;
      animationEnabled?: boolean;
      animationPlayback?: SceneModelAnimationPlaybackState;
      layers?: SceneLayerState[];
    },
  ): void;
  abstract primitiveState(id: string, color: string): PrimitiveState | undefined;
  abstract addMeasurementVisual(measurement: MeasurementState): void;
  abstract clearMeasurements(): void;
  abstract deleteMeasurement(id: string): void;
  abstract focusMeasurement(measurement: MeasurementState): void;
  abstract dispose(): void;
  protected abstract sceneContentBox(): THREE.Box3;
  protected abstract updateTransformAccess(): void;
  protected abstract syncFragmentsTransformState(modelId: string, activelyTransforming?: boolean): void;
  protected abstract updateSelectionHelper(): void;
  protected abstract updatePostProcessingSelection(): void;
  /** 只有作者实际启用屏幕后效或对象轮廓时，才下载并创建 Composer。 */
  protected abstract syncPostProcessing(): Promise<void>;
  protected abstract needsPostProcessing(): boolean;
  protected abstract createPostProcessingRuntime(): Promise<ViewerPostProcessingRuntime | undefined>;
  protected abstract restoreModelEffectMaterials(id: string): void;
  protected abstract rebuildModelEffects(id: string): void;
  protected abstract updateModelEffects(delta: number): void;
  protected abstract removeSelectionHelper(): void;
  protected abstract emitCameraChange(force?: boolean): void;
  protected abstract registerObject(id: string, name: string, object: THREE.Object3D, kind: LoadedSceneModel["kind"]): LoadedSceneModel;
  protected abstract indexModelObject(id: string, object: THREE.Object3D): Map<string, THREE.Object3D>;
  protected abstract registerFragmentsModel(modelId: string, fragmentsModel: FRAGS.FragmentsModel, sourceName: string): Promise<void>;
  protected abstract hydrateFragmentProperties(modelId: string, fragmentsModel: FRAGS.FragmentsModel, localIds: number[]): Promise<void>;
  protected abstract ensureFragmentEntry(modelId: string, localId: number): string | undefined;
  protected abstract highlightFragmentSelection(fragmentModel: FRAGS.FragmentsModel, entry: FragmentLayerEntry): Promise<void>;
  protected abstract focusBox(box: THREE.Box3, direction?: THREE.Vector3, up?: THREE.Vector3): boolean;
  protected abstract prepareForFocusedView(): void;
  protected abstract syncSpaceVisuals(): void;
  protected abstract showSelectionBox(box: THREE.Box3): void;
  protected abstract loadDxf(url: string): Promise<THREE.Group>;
  protected abstract setupEnvironment(): void;
  protected abstract applyEnvironment(): Promise<void>;
  protected abstract loadEnvironmentTexture(url: string): Promise<THREE.Texture>;
  protected abstract getSkyboxTexture(preset: Exclude<SkyboxPreset, "none">): THREE.CanvasTexture;
  protected abstract applyLighting(): void;
  protected abstract syncSceneLights(): void;
  protected abstract createSceneLightProxy(state: SceneLightState): void;
  protected abstract disposeSceneLightProxies(): void;
  protected abstract updateSceneLightProxies(): void;
  protected abstract lightProxyPointerHit(event: PointerEvent):
    | {
        id: string;
        handle: "position" | "target";
      }
    | undefined;
  protected abstract floorStateKey(modelId: string, level: string): string;
  protected abstract createRainEffect(): THREE.LineSegments;
  protected abstract createSnowEffect(): THREE.Points;
  protected abstract updateWeather(delta: number): void;
  protected abstract disposeWeatherEffect(): void;
  protected abstract applySceneAnimationFrame(time: number): void;
  protected abstract applyTimelineModelAnimation(modelId: string, clipId: string | undefined, time: number): void;
  protected abstract modelBone(modelId: string, bonePath: string): THREE.Bone | undefined;
  protected abstract captureModelBoneRestPose(modelId: string): void;
  protected abstract normalizeIKConstraint(constraint: SceneIKConstraintState): SceneIKConstraintState;
  protected abstract updateModelRig(): void;
  protected abstract updateCameraPathHelper(): void;
  protected abstract resize(): void;
  protected abstract applyRendererPixelRatio(pixelRatio: number): void;
  protected abstract animate(): void;
  protected abstract readRendererLoad(): RendererLoadSnapshot;
  protected abstract updateNavigation(delta: number): void;
  protected abstract configureNavigationControls(mode: NavigationMode): void;
  protected abstract captureNavigationState(mode: NavigationMode): NavigationViewState;
  protected abstract rememberNavigationState(mode: NavigationMode): void;
  protected abstract applyNavigationViewState(state: NavigationViewState): void;
  protected abstract isNavigationStateUsable(state: NavigationViewState): boolean;
  protected abstract navigationAnchor(previousMode: NavigationMode): THREE.Vector3;
  protected abstract recoverNavigationMode(mode: NavigationMode): void;
  protected abstract enterFirstPerson(anchor: THREE.Vector3): void;
  protected abstract enterThirdPerson(anchor: THREE.Vector3): void;
  protected abstract ensureAvatar(): void;
  protected abstract visibleModelObjects(): THREE.Object3D[];
  protected abstract findFloorHeight(position: THREE.Vector3): number | undefined;
  protected abstract applyCameraClippingRange(): void;
  protected abstract resetCameraCollisionAnchor(): void;
  protected abstract enforceCameraCollision(now: number): void;
  protected abstract resolveCharacterMovement(movement: THREE.Vector3, topOrigin: THREE.Vector3, height: number): THREE.Vector3;
  abstract setModelTransform(
    id: string,
    transform: {
      position?: [number, number, number];
      rotation?: [number, number, number];
      scale?: [number, number, number];
    },
  ): boolean;
  abstract setCameraPose(state: { position: [number, number, number]; target: [number, number, number]; near?: number; far?: number; fov?: number }): void;
  abstract focusModel(id: string, layerId?: string): boolean;
  protected abstract recoverCharacterSpawn(start: THREE.Vector3, height: number): THREE.Vector3;
  protected abstract characterOverlapsScene(top: THREE.Vector3, height: number): boolean;
  protected abstract firstCharacterCollision(topOrigin: THREE.Vector3, movement: THREE.Vector3, height: number): THREE.Intersection<THREE.Object3D> | undefined;
  protected abstract updateNavigationCollisionDebug(now: number, force?: boolean): void;
  protected abstract clearNavigationCollisionDebug(): void;
  protected abstract rebuildComponentIndex(modelId: string): void;
  protected abstract componentRecord(modelId: string, nodeId: string): ComponentRecord | undefined;
  protected abstract focusObject(object: THREE.Object3D): void;
  protected abstract updateLayerState(modelId: string, nodeId: string, patch: Omit<SceneLayerState, "nodeId">): void;
  protected abstract materialsForMesh(mesh: THREE.Mesh): THREE.Material[];
  protected abstract setObjectOpacity(object: THREE.Object3D, opacity: number): void;
  protected abstract setObjectColor(object: THREE.Object3D, color: string): void;
  protected abstract getMaterialState(object: THREE.Object3D): SceneMaterialState;
  protected abstract applyMaterialState(object: THREE.Object3D, state: SceneMaterialState): void;
  protected abstract updateMaterialUvAnimations(delta: number): void;
  protected abstract applyMaterialTexture(
    material: THREE.MeshStandardMaterial,
    slot: MaterialTextureSlot,
    metadataKey: MaterialTextureMetadataKey,
    url: string | undefined,
    state: SceneMaterialState,
    srgb: boolean,
  ): void;
  protected abstract loadMaterialTextureSource(url: string, srgb: boolean): Promise<THREE.Texture>;
  protected abstract disposeManagedMaterialTexture(texture: THREE.Texture | null): void;
  protected abstract objectColor(object: THREE.Object3D | undefined): string;
  protected abstract updateCollisions(force: boolean, now?: unknown): void;
  protected abstract setCollisionHighlight(model: LoadedSceneModel, active: boolean): void;
  protected abstract refreshAnnotationVisual(id: string): void;
  protected abstract updateMeasurementPreview(end: THREE.Vector3): void;
  protected abstract measurementEnd(start: THREE.Vector3, hitPoint: THREE.Vector3): THREE.Vector3;
  protected abstract finishMeasurement(measurement: MeasurementState): void;
  protected abstract removeMeasurementPreview(): void;
  protected abstract disposeObject(object: THREE.Object3D): void;
  protected abstract pointerHit(event: PointerEvent): THREE.Intersection | undefined;
  protected abstract annotationPointerHit(event: PointerEvent): AnnotationPointerHit | undefined;
  protected abstract scenePointerHit(event: PointerEvent): Promise<PointerSceneHit | undefined>;
  protected abstract interactionTargetFromHit(hit: PointerSceneHit | undefined): SceneInteractionTarget | undefined;
  protected abstract interactionTargetHierarchy(target: SceneInteractionTarget | undefined): SceneInteractionTarget[];
  protected abstract updateHoverInteraction(hit: PointerSceneHit | undefined, event: PointerEvent): void;
  protected abstract handlePointerMove(event: PointerEvent): Promise<void>;
  protected abstract handlePointerLeave(): void;
  protected abstract handleContextMenu(event: MouseEvent): void;
  protected abstract handleDoubleClick(event: MouseEvent): void;
  protected abstract dispatchPointerInteraction(trigger: "doubleClick" | "contextMenu", event: MouseEvent): Promise<void>;
  protected abstract handlePointerDown(event: PointerEvent): Promise<void>;
  protected abstract handleKeyDown(event: KeyboardEvent): void;
  protected abstract handleKeyUp(event: KeyboardEvent): void;
}
