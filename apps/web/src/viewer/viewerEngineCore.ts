import type * as FRAGS from "@thatopen/fragments";
import * as THREE from "three";
import type { ClippingGroup } from "three/webgpu";
import type { World as RapierWorld } from "@dimforge/rapier3d-compat";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type {
  CameraConstraintsState,
  CameraState,
  ClippingState,
  ExplosionMode,
  GlobalLightingState,
  IndustrialPrefabInstanceState,
  MeasurementState,
  NavigationSettingsState,
  PrimitiveKind,
  SceneAnnotationState,
  SceneAnimationState,
  SceneEnvironmentState,
  SceneFloorState,
  SceneInteractionScriptState,
  SceneInteractionTarget,
  SceneInteractionTrigger,
  SceneLayerState,
  SceneMaterialState,
  SceneModelEffectsState,
  SceneModelAnimationPlaybackState,
  ScenePhysicsBodyState,
  ScenePhysicsState,
  ScenePostProcessingState,
  SceneRigState,
  SceneSpatialAudioState,
  SkyboxPreset,
  WeatherMode,
} from "@bim-studio/contracts";
import { DEFAULT_NAVIGATION_SETTINGS } from "../navigationSettings";
import { DEFAULT_ENVIRONMENT, DEFAULT_LIGHTING, DEFAULT_POST_PROCESSING } from "../appDefaults";
import { type CollisionRecord, type ComponentRecord } from "./analysis";
import { ModelLoadCoordinator } from "./modelLoadCoordinator";
import { objectTransform, toValue } from "./sceneObjectUtils";
import type { ViewerPostProcessingRuntime } from "./viewerPostProcessingRuntime";
import { FramePerformanceMonitor } from "./framePerformanceMonitor";
import { AdaptiveRenderScaleController } from "./adaptiveRenderScale";
import { createBrowserPipelineWarmupScheduler } from "./rendererPipelineWarmup";
import { rendererPipelineSignature } from "./rendererPipelineSignature";
import type { SpaceVisualRuntime } from "./spaceVisualSync";
import { PrimitiveGeometryCache } from "./primitiveGeometry";
import { PrimitiveMaterialCache } from "./primitiveMaterial";
import { ShadowUpdateGovernor } from "./shadowUpdateGovernor";
import { createBrowserLongTaskMonitor } from "./mainThreadLongTaskMonitor";
import { GpuFrameTimeMonitor } from "./gpuFrameTimeMonitor";
import { GpuResourceRetirementQueue } from "./gpuResourceRetirementQueue";
import {
  type InteractionScriptResult,
  type LayerTreeNode,
  type LoadedSceneModel,
  type MeasureMode,
  type NavigationCollisionDiagnostics,
  type NavigationMode,
  type PointerInfo,
  type RendererBackend,
  type RendererDeviceLossInfo,
  type SelectionScope,
} from "./viewerTypes";
import {
  DEFAULT_CAMERA_CONSTRAINTS,
  DEFAULT_SCENE_LIGHTS,
  type FragmentLayerEntry,
  type MaterialTextureSlot,
  type ModelEffectRuntime,
  type NavigationViewState,
  type PhysicsBodyRuntime,
} from "./viewerEngineTypes";
import { runtimeGpuDevice, type RendererInstance } from "./viewerRendererTypes";
import { ViewerEngineContract } from "./viewerEngineContract";
import type { MotionRoutePlan } from "../prefabs/motionRoutePlayer";

/** ViewerEngine 的共享状态与跨模块契约，具体能力由职责层逐级实现。 */
export abstract class ViewerEngineCore extends ViewerEngineContract {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.05, 100_000);
  readonly renderer: RendererInstance;
  readonly orbit: OrbitControls;
  readonly pointer: PointerLockControls;
  readonly transform: TransformControls;
  onSelectionChange?: (model: LoadedSceneModel | undefined) => void;
  onModelChange?: (model: LoadedSceneModel) => void;
  onMeasurement?: (measurement: MeasurementState) => void;
  onMeasurementDraftChange?: (hasStart: boolean, pointCount?: number, requiredPoints?: number) => void;
  onAnnotationPlaced?: (annotation: SceneAnnotationState) => void;
  onAnnotationChange?: (annotation: SceneAnnotationState) => void;
  onAnnotationSelectionChange?: (annotationId: string | undefined) => void;
  onClippingFacePicked?: (state: ClippingState) => void;
  onCollisionChange?: () => void;
  onNavigationRecovery?: () => void;
  onNavigationDiagnosticsChange?: (diagnostics: NavigationCollisionDiagnostics) => void;
  onCameraChange?: (state: CameraState) => void;
  onPointerInfoChange?: (info: PointerInfo | undefined) => void;
  onAnimationChange?: (time: number, playing: boolean) => void;
  onLightingChange?: (lighting: GlobalLightingState) => void;
  onXRSessionChange?: (mode: "immersive-vr" | "immersive-ar" | undefined) => void;
  onPrimitivePlaced?: (model: LoadedSceneModel, kind: PrimitiveKind, color: string) => void;
  onRendererDeviceLost?: (info: RendererDeviceLossInfo) => void;
  onInteractionScriptResult?: (result: InteractionScriptResult) => void;
  onInteractionTrigger?: (trigger: SceneInteractionTrigger, target: SceneInteractionTarget) => void;
  protected readonly raycaster = new THREE.Raycaster();
  protected readonly modelRoot: THREE.Group | ClippingGroup;
  protected readonly pointerPosition = new THREE.Vector2();
  protected readonly models = new Map<string, LoadedSceneModel>();
  protected readonly modelLoads = new ModelLoadCoordinator<LoadedSceneModel>();
  protected rapier: (typeof import("@dimforge/rapier3d-compat"))["default"] | undefined;
  protected physicsWorld: RapierWorld | undefined;
  protected physicsInit: Promise<void> | undefined;
  protected physicsAccumulator = 0;
  protected lastPhysicsUiUpdate = 0;
  protected physicsState: ScenePhysicsState = { enabled: false, playing: false, gravity: { x: 0, y: -9.81, z: 0 } };
  protected readonly physicsBodyStates = new Map<string, ScenePhysicsBodyState>();
  protected readonly physicsBodies = new Map<string, PhysicsBodyRuntime>();
  protected fragments: FRAGS.FragmentsModels | undefined;
  protected importer: FRAGS.IfcImporter | undefined;
  protected fragmentApi: typeof import("@thatopen/fragments") | undefined;
  protected fragmentRuntimeInit: Promise<void> | undefined;
  protected readonly dracoLoader = new DRACOLoader();
  protected readonly gltfLoader = new GLTFLoader();
  protected readonly fbxLoader = new FBXLoader();
  protected readonly keys = new Set<string>();
  protected readonly mixers = new Map<string, THREE.AnimationMixer>();
  protected readonly animationClips = new Map<string, THREE.AnimationClip[]>();
  protected readonly animationClipSelection = new Map<string, string>();
  protected readonly animationEnabledIds = new Set<string>();
  protected readonly modelAnimationPlaybackStates = new Map<string, SceneModelAnimationPlaybackState>();
  protected readonly modelRigStates = new Map<string, SceneRigState>();
  protected readonly modelBoneRestRotations = new Map<string, Map<string, THREE.Quaternion>>();
  protected readonly measurementPoints: THREE.Vector3[] = [];
  protected readonly measurementTargets: Array<{ point: THREE.Vector3; object?: THREE.Object3D; label?: string }> = [];
  protected readonly annotations = new Map<string, {
    state: SceneAnnotationState;
    object: THREE.Group;
    /** 绑定对象局部坐标；设备移动、旋转或缩放时用于保持标签跟随。 */
    localAnchor?: THREE.Vector3;
  }>();
  protected readonly spaceVisuals = new Map<string, SpaceVisualRuntime>();
  protected readonly modelColorOverrides = new Map<string, string>();
  protected readonly modelMaterialOverrides = new Map<string, SceneMaterialState>();
  protected readonly originalMaterialTextures = new WeakMap<THREE.Material, Partial<Record<MaterialTextureSlot, THREE.Texture | null>>>();
  protected readonly modelScreenOriginals = new WeakMap<THREE.Material, {
    map: THREE.Texture | null;
    emissiveMap: THREE.Texture | null;
    emissive: THREE.Color;
    emissiveIntensity: number;
  }>();
  protected readonly materialTextureSources = new Map<string, Promise<THREE.Texture>>();
  protected audioListener: THREE.AudioListener | undefined;
  protected audioUnlocked = false;
  protected readonly spatialAudioStates = new Map<string, SceneSpatialAudioState>();
  protected readonly spatialAudioRuntimes = new Map<string, { audio: THREE.PositionalAudio; sourceUrl?: string; requestKey?: string }>();
  protected readonly spatialAudioBuffers = new Map<string, Promise<AudioBuffer>>();
  protected readonly modelEffects = new Map<string, SceneModelEffectsState>();
  protected readonly modelPrefabStates = new Map<string, IndustrialPrefabInstanceState>();
  protected readonly motionRouteRuntimes = new Map<
    string,
    { plan: MotionRoutePlan; elapsedSeconds: number; lastArrivalToken?: string }
  >();
  protected readonly modelEffectRuntimes = new Map<string, ModelEffectRuntime>();
  protected readonly layerObjects = new Map<string, Map<string, THREE.Object3D>>();
  protected readonly layerStates = new Map<string, Map<string, SceneLayerState>>();
  protected readonly fragmentModels = new Map<string, FRAGS.FragmentsModel>();
  protected readonly fragmentLayers = new Map<string, Map<string, FragmentLayerEntry>>();
  protected readonly fragmentTrees = new Map<string, LayerTreeNode>();
  protected readonly fragmentNodeIdsByLocalId = new Map<string, Map<number, string>>();
  protected readonly componentRecords = new Map<string, ComponentRecord[]>();
  protected bimPlacementPreview: THREE.Object3D | undefined;
  protected readonly isolationVisibility = new Map<THREE.Object3D, boolean>();
  protected readonly explosionPositions = new Map<string, Map<THREE.Object3D, THREE.Vector3>>();
  protected readonly explosionFactors = new Map<string, number>();
  protected readonly explosionModes = new Map<string, ExplosionMode>();
  protected readonly collisionEnabledIds = new Set<string>();
  protected readonly collidingIds = new Set<string>();
  protected collisionRecords: CollisionRecord[] = [];
  protected readonly collisionOriginalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  protected readonly collisionMaterial = new THREE.MeshBasicMaterial({
    color: 0xff334f,
    transparent: true,
    opacity: 0.72,
    depthTest: true,
    depthWrite: false,
  });
  protected resizeObserver!: ResizeObserver;
  protected animationFrame = 0;
  protected resizeAnimationFrame = 0;
  protected readOnlyFrameCadenceAnchor: number | undefined;
  /** 同一对象只允许一个显隐过渡；新动作会取消旧动作并恢复稳定状态。 */
  protected readonly visibilityTransitionCancels = new Map<string, () => void>();
  protected lastViewportWidth = 0;
  protected lastViewportHeight = 0;
  protected drawingBufferInitialized = false;
  protected rendererDisposalStarted = false;
  private rendererLossNotified = false;
  protected lastFrameTime = performance.now();
  protected readonly framePerformanceMonitor = new FramePerformanceMonitor();
  protected readonly adaptiveRenderScaleController = new AdaptiveRenderScaleController(Math.min(devicePixelRatio, 2));
  protected readonly pipelineWarmupScheduler = createBrowserPipelineWarmupScheduler();
  protected readonly warmedPipelineSignatures = new Set<string>();
  protected readonly primitiveGeometryCache = new PrimitiveGeometryCache();
  protected readonly primitiveMaterialCache = new PrimitiveMaterialCache();
  protected readonly gpuResourceRetirementQueue = new GpuResourceRetirementQueue(() => runtimeGpuDevice(this.renderer)?.queue);
  protected readonly shadowUpdateGovernor = new ShadowUpdateGovernor();
  protected readonly longTaskMonitor = createBrowserLongTaskMonitor();
  protected readonly gpuFrameTimeMonitor: GpuFrameTimeMonitor;
  protected lastAdaptiveRenderSampleAt = 0;
  protected selectedId: string | undefined;
  protected inspectedObject: THREE.Object3D | undefined;
  protected navigationMode: NavigationMode = "orbit";
  protected selectionScope: SelectionScope = "model";
  protected measureEnabled = false;
  protected annotationPlacementEnabled = false;
  protected selectedAnnotationId: string | undefined;
  protected measureMode: MeasureMode = "distance";
  protected measurementPreview: THREE.Group | undefined;
  protected avatar?: THREE.Group;
  protected avatarVisible = false;
  protected readonly avatarHeading = new THREE.Vector3(0, 0, 1);
  protected readonly navigationViewStates = new Map<NavigationMode, NavigationViewState>();
  protected cameraConstraints: CameraConstraintsState = structuredClone(DEFAULT_CAMERA_CONSTRAINTS);
  protected navigationSettings: NavigationSettingsState = structuredClone(DEFAULT_NAVIGATION_SETTINGS);
  protected readonly cameraCollisionAnchor = new THREE.Vector3();
  protected cameraCollisionDirty = false;
  protected lastCameraCollisionCheck = 0;
  protected readonly navigationCollisionDebugGroup = new THREE.Group();
  protected navigationCollisionDebugVisible = false;
  protected navigationDebugCapsule: THREE.Mesh | undefined;
  protected lastNavigationDebugRefresh = 0;
  protected navigationRaySamples = 0;
  protected lastNavigationSweepMs = 0;
  protected lastNavigationDiagnosticsNotify = 0;
  protected readOnlyMode = false;
  protected adaptiveQualityEnabled = false;
  protected readonly firstPersonVelocity = new THREE.Vector3();
  protected firstPersonGrounded = false;
  protected firstPersonJumpRequested = false;
  protected primitivePlacementKind: PrimitiveKind | undefined;
  protected lastCollisionCheck = 0;
  protected clippingState: ClippingState = { enabled: false, mode: "axis", axis: "x", offset: 0, inverted: false };
  protected clippingHelper: THREE.Box3Helper | undefined;
  protected selectionHelper: THREE.Box3Helper | undefined;
  protected focusedSpaceKey: string | undefined;
  protected selectedFragmentNodeId: string | undefined;
  protected fragmentSelectionVersion = 0;
  protected readonly sceneLights = new Map<string, THREE.Light>();
  protected readonly sceneLightTargets = new Map<string, THREE.Object3D>();
  protected readonly sceneLightProxies = new Map<string, { position: THREE.Group; target?: THREE.Group; line?: THREE.Line }>();
  protected selectedSceneLight: { id: string; handle: "position" | "target" } | undefined;
  protected weatherMode: WeatherMode = "sunny";
  protected lightingState: GlobalLightingState = structuredClone(DEFAULT_LIGHTING);
  protected readonly globalIlluminationLight = new THREE.HemisphereLight(0xbddcff, 0x75634d, 0);
  protected environmentState: SceneEnvironmentState = structuredClone(DEFAULT_ENVIRONMENT);
  protected gridHelper: THREE.Mesh | undefined;
  protected groundHelper: THREE.Mesh | undefined;
  protected readonly skyboxTextures = new Map<Exclude<SkyboxPreset, "none">, THREE.CanvasTexture>();
  protected externalEnvironmentTexture?: THREE.Texture;
  protected postProcessing: ViewerPostProcessingRuntime | undefined;
  protected postProcessingInit: Promise<ViewerPostProcessingRuntime | undefined> | undefined;
  protected postProcessingRevision = 0;
  protected postProcessingDisposeTimer: number | undefined;
  protected postProcessingState: ScenePostProcessingState = structuredClone(DEFAULT_POST_PROCESSING);
  protected xrActive = false;
  protected xrSession: XRSession | undefined;
  protected xrMode: "immersive-vr" | "immersive-ar" | undefined;
  protected xrBackground?: THREE.Color | THREE.Texture | null;
  protected readonly xrRig = new THREE.Group();
  protected readonly xrControllers: THREE.Group[] = [];
  protected xrSavedCamera:
    | {
        position: THREE.Vector3;
        quaternion: THREE.Quaternion;
        scale: THREE.Vector3;
        up: THREE.Vector3;
        target: THREE.Vector3;
        fov: number;
        zoom: number;
        near: number;
        far: number;
      }
    | undefined;
  protected xrSnapTurnReady = true;
  protected xrExitPressed = false;
  protected floorStates = new Map<string, SceneFloorState>();
  protected weatherEffect: THREE.Points | THREE.LineSegments | undefined;
  protected sceneAnimation: SceneAnimationState = {
    duration: 10,
    autoplay: true,
    loop: false,
    pingPong: false,
    playbackSpeed: 1,
    frameRate: 30,
    snapToFrames: false,
    cameraInterpolation: "smooth",
    showCameraPath: true,
    camera: [],
    models: [],
  };
  protected sceneAnimationTime = 0;
  protected sceneAnimationPlaying = false;
  protected sceneAnimationDirection = 1;
  protected cameraPathHelper: THREE.Group | undefined;
  protected lastAnimationNotify = 0;
  protected lastCameraSignature = "";
  protected interactionScripts: SceneInteractionScriptState[] = [];
  protected hoverInteractionTargets: SceneInteractionTarget[] = [];
  protected pointerMoveSequence = 0;
  protected lastInteractionHoverCheck = 0;
  protected constructor(
    protected readonly container: HTMLElement,
    renderer: RendererInstance,
    protected readonly rendererBackend: RendererBackend,
    modelRoot: THREE.Group | ClippingGroup,
  ) {
    super();
    this.scene.background = new THREE.Color(0x171a1d);
    this.camera.position.set(12, 8, 12);
    this.renderer = renderer;
    // Viewer 自己管理动画循环；每帧只重置一次，才能汇总 Composer 的全部 pass，
    // 同时避免 WebGPU 统计从应用启动后一直累计。
    this.renderer.info.autoReset = false;
    this.gpuFrameTimeMonitor = new GpuFrameTimeMonitor(renderer);
    this.modelRoot = modelRoot;
    this.renderer.setPixelRatio(this.adaptiveRenderScaleController.state().basePixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    if (this.renderer instanceof THREE.WebGLRenderer) {
      this.renderer.localClippingEnabled = true;
      this.renderer.shadowMap.type = THREE.PCFShadowMap;
    }
    this.container.append(this.renderer.domElement);
    this.scene.add(this.modelRoot);
    this.navigationCollisionDebugGroup.name = "navigation-collision-debug";
    this.navigationCollisionDebugGroup.visible = false;
    this.scene.add(this.navigationCollisionDebugGroup);
    this.scene.add(this.xrRig);
    this.xrRig.add(this.camera);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.target.set(0, 1, 0);
    this.cameraCollisionAnchor.copy(this.camera.position);
    this.orbit.addEventListener("change", () => {
      this.cameraCollisionDirty = true;
    });
    this.pointer = new PointerLockControls(this.camera, this.renderer.domElement);
    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.scene.add(this.transform.getHelper());
    this.transform.addEventListener("dragging-changed", (event) => {
      this.orbit.enabled = !event.value && this.navigationMode !== "firstPerson";
      const selected = this.getSelected();
      if (selected && this.fragmentModels.has(selected.id)) this.syncFragmentsTransformState(selected.id, Boolean(event.value));
      if (selected && !event.value && this.inspectedObject === selected.object) {
        this.rebuildPhysicsBody(selected.id);
        this.rebuildModelEffects(selected.id);
      }
    });
    this.transform.addEventListener("objectChange", () => {
      this.markShadowMapDirty();
      if (this.selectedSceneLight) {
        const selected = this.selectedSceneLight;
        const state = this.lightingState.lights?.find((item) => item.id === selected.id);
        const light = this.sceneLights.get(selected.id);
        const target = this.sceneLightTargets.get(selected.id);
        if (state && light) {
          if (selected.handle === "position") state.position = toValue(light.position);
          else if (target) state.target = toValue(target.position);
          if (state.type === "rectArea") light.lookAt(state.target?.x ?? 0, state.target?.y ?? 0, state.target?.z ?? 0);
          this.onLightingChange?.(this.getGlobalLighting());
        }
        return;
      }
      const selected = this.getSelected();
      if (selected) {
        const object = this.inspectedObject;
        if (object && object !== selected.object) {
          this.updateLayerState(selected.id, String(object.userData.layerNodeId), { transform: objectTransform(object) });
        }
        selected.object.updateWorldMatrix(true, true);
        this.updateSelectionHelper();
        this.updateCollisions(true);
        this.syncFragmentsTransformState(selected.id, true);
        this.onModelChange?.(selected);
      }
    });

    this.setupEnvironment();
    this.dracoLoader.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    this.gltfLoader.setDRACOLoader(this.dracoLoader);
    this.orbit.addEventListener("change", () => {
      void this.fragments?.update();
      this.emitCameraChange();
    });
  }

  /** 在空闲窗口预编译当前场景管线，减少首次显示材质、灯光或效果时的卡顿。 */
  protected scheduleRendererPipelineWarmup(): void {
    this.pipelineWarmupScheduler.request(async () => {
      const signature = rendererPipelineSignature(this.scene, this.rendererBackend, this.postProcessingState);
      if (this.warmedPipelineSignatures.has(signature)) return false;
      const renderer = this.renderer as RendererInstance & {
        compile?: (scene: THREE.Scene, camera: THREE.Camera) => unknown;
        compileAsync?: (scene: THREE.Scene, camera: THREE.Camera) => Promise<unknown>;
      };
      if (this.rendererBackend === "webgl" && typeof renderer.compile === "function") {
        // Three.js WebGL compileAsync 会持续轮询材质程序；切换工作区释放材质时存在竞态。
        // 同步提交仍可提前触发驱动编译，并且不会留下跨 Viewer 生命周期的定时任务。
        renderer.compile(this.scene, this.camera);
        this.warmedPipelineSignatures.add(signature);
      } else if (typeof renderer.compileAsync === "function") {
        await renderer.compileAsync(this.scene, this.camera);
        this.warmedPipelineSignatures.add(signature);
      }
      return true;
    });
  }

  protected markShadowMapDirty(): void {
    this.shadowUpdateGovernor.markDirty();
  }

  protected scheduleResize(): void {
    if (this.resizeAnimationFrame !== 0 || this.rendererDisposalStarted) return;
    this.resizeAnimationFrame = requestAnimationFrame(() => {
      this.resizeAnimationFrame = 0;
      this.resize();
    });
  }

  /** 派生职责层字段初始化完成后，再统一绑定输入事件并启动渲染循环。 */
  protected startRuntime(): void {
    this.renderer.domElement.addEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.addEventListener("pointermove", this.handlePointerMove);
    this.renderer.domElement.addEventListener("pointerleave", this.handlePointerLeave);
    this.renderer.domElement.addEventListener("contextmenu", this.handleContextMenu);
    this.renderer.domElement.addEventListener("dblclick", this.handleDoubleClick);
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    // ResizeObserver 可能在 WebGPU 正在提交命令时连续触发。合并到下一帧，避免画布目标被同步反复销毁。
    this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
    this.resizeObserver.observe(this.container);
    this.resize();
    this.animate();
  }

  /**
   * 将不同浏览器和 Three.js 后端的设备丢失事件收敛为一次产品级通知。
   * 正常销毁查看器也会让 GPUDevice 进入 lost 状态，必须与运行时故障区分。
   */
  protected notifyRendererDeviceLost(info: RendererDeviceLossInfo): void {
    if (this.rendererDisposalStarted || this.rendererLossNotified) return;
    this.rendererLossNotified = true;
    this.onRendererDeviceLost?.(info);
  }
}
