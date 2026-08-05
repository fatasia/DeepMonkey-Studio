import * as OBC from "@thatopen/components";
import * as FRAGS from "@thatopen/fragments";
import workerUrl from "@thatopen/fragments/worker?url";
import DxfParser from "dxf-parser";
import * as THREE from "three";
import type { ClippingGroup, WebGPURenderer } from "three/webgpu";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type {
  CameraState,
  ClippingState,
  ExplosionMode,
  GlobalLightingState,
  MeasurementState,
  ModelManifest,
  ModelTransform,
  PrimitiveState,
  SceneAnnotationState,
  SceneAnimationState,
  SceneEnvironmentState,
  SceneFloorState,
  SceneLayerState,
  SceneLightState,
  SceneMaterialState,
  SkyboxPreset,
  Vector3Value,
  WeatherMode
} from "@bim-studio/contracts";
import {
  buildComponentRecords,
  closestPointsBetweenObjects,
  componentFacets,
  filterComponents,
  preciseIntersection,
  type CollisionRecord,
  type ComponentFacets,
  type ComponentFilter,
  type ComponentRecord
} from "./analysis";
import { sampleCameraKeyframes, sampleModelKeyframes } from "./timeline";
import { constrainMeasurementEnd, elevationSegment, measurementAngle, projectRayToVerticalAxis } from "./measurement";

export type { CollisionRecord, ComponentFacets, ComponentFilter, ComponentRecord } from "./analysis";

export type TransformMode = "translate" | "rotate" | "scale";
export type NavigationMode = CameraState["mode"];
export type MeasureMode = NonNullable<MeasurementState["kind"]>;
export type StandardView = "top" | "bottom" | "left" | "right" | "front" | "back";
export type SelectionScope = "model" | "component";
export type RendererBackend = "webgl" | "webgpu";
type RendererInstance = THREE.WebGLRenderer | WebGPURenderer;

const DEFAULT_SCENE_LIGHTS: SceneLightState[] = [
  { id: "ambient-default", name: "环境光", type: "ambient", enabled: true, color: "#dce8ff", intensity: 0.35 },
  { id: "hemisphere-default", name: "半球光", type: "hemisphere", enabled: true, color: "#e8f0ff", groundColor: "#3b4249", intensity: 1.4 },
  { id: "sun-default", name: "主方向光", type: "directional", enabled: true, color: "#ffffff", intensity: 2.2, position: { x: 18, y: 28, z: 12 }, target: { x: 0, y: 0, z: 0 }, castShadow: true }
];

export interface SceneStatistics {
  modelCount: number;
  primitiveCount: number;
  componentCount: number;
  triangleCount: number;
  vertexCount: number;
}

export interface PointerInfo {
  screenX: number;
  screenY: number;
  world?: Vector3Value;
  objectName?: string;
}

export interface SceneDataMessage {
  source: string;
  key: string;
  value: unknown;
  timestamp: string;
  target?: { modelId?: string; layerId?: string; annotationId?: string };
  action?: "color" | "visibility" | "position" | "label";
}

export interface BimSpaceRecord {
  id: string;
  modelId: string;
  modelName: string;
  name: string;
  number?: string;
  level: string;
  kind: string;
  department?: string;
  areaSquareMetres?: number;
  volumeCubicMetres?: number;
  bounds?: { min: Vector3Value; max: Vector3Value };
  parameters?: BimPropertyEntry[];
  componentId?: string;
}

export interface BimPropertyEntry {
  name: string;
  value: string;
  group?: string;
}

export interface LayerTreeNode {
  id: string;
  modelId: string;
  name: string;
  type: string;
  visible: boolean;
  locked: boolean;
  deleted: boolean;
  children: LayerTreeNode[];
}

export interface LoadedSceneModel {
  id: string;
  name: string;
  object: THREE.Object3D;
  kind: "model" | "primitive";
  visible: boolean;
  opacity: number;
}

interface DxfVertex {
  x: number;
  y: number;
  z?: number;
}

interface DxfEntity {
  type?: string;
  layer?: string;
  vertices?: DxfVertex[];
  center?: DxfVertex;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  colorNumber?: number;
}

interface DxfDocument {
  entities?: DxfEntity[];
  header?: Record<string, unknown>;
}

interface FragmentLayerEntry {
  node: LayerTreeNode;
  localIds: number[];
  localId?: number;
  properties: Record<string, string>;
}

interface NativeBimElementMetadata {
  elementId?: string;
  uniqueId?: string;
  displayProperties?: Record<string, string>;
  [key: string]: unknown;
}

interface NativeBimSpaceMetadata {
  spaceId?: string;
  name?: string;
  number?: string;
  kind?: string;
  level?: string;
  department?: string;
  areaSquareMetres?: number;
  volumeCubicMetres?: number;
  bounds?: { min: Vector3Value; max: Vector3Value };
  parameters?: Array<{ name?: string; value?: string; groupTypeId?: string }>;
  [key: string]: unknown;
}

interface NativeBimPropertiesFile {
  schemaVersion?: number;
  model?: Record<string, unknown>;
  elements?: Record<string, NativeBimElementMetadata>;
  types?: Record<string, NativeBimElementMetadata>;
  materials?: Record<string, Record<string, unknown>>;
  spaces?: Record<string, NativeBimSpaceMetadata>;
  [elementId: string]: unknown;
}

interface PointerSceneHit {
  point: THREE.Vector3;
  distance: number;
  objectName: string;
  object?: THREE.Object3D;
  normal?: THREE.Vector3;
  modelId?: string;
  fragmentNodeId?: string;
}

interface NavigationViewState {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

const toValue = (vector: THREE.Vector3 | THREE.Euler): Vector3Value => ({
  x: vector.x,
  y: vector.y,
  z: vector.z
});

export class ViewerEngine {
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
  onAnnotationSelectionChange?: (annotationId: string | undefined) => void;
  onClippingFacePicked?: (state: ClippingState) => void;
  onCollisionChange?: () => void;
  onCameraChange?: (state: CameraState) => void;
  onPointerInfoChange?: (info: PointerInfo | undefined) => void;
  onAnimationChange?: (time: number, playing: boolean) => void;

  private readonly raycaster = new THREE.Raycaster();
  private readonly modelRoot: THREE.Group | ClippingGroup;
  private readonly pointerPosition = new THREE.Vector2();
  private readonly models = new Map<string, LoadedSceneModel>();
  private readonly components = new OBC.Components();
  private readonly fragments = this.components.get(OBC.FragmentsManager);
  private readonly importer = new FRAGS.IfcImporter();
  private readonly dracoLoader = new DRACOLoader();
  private readonly gltfLoader = new GLTFLoader();
  private readonly fbxLoader = new FBXLoader();
  private readonly keys = new Set<string>();
  private readonly mixers = new Map<string, THREE.AnimationMixer>();
  private readonly animationEnabledIds = new Set<string>();
  private readonly measurementPoints: THREE.Vector3[] = [];
  private readonly measurementTargets: Array<{ point: THREE.Vector3; object?: THREE.Object3D; label?: string }> = [];
  private readonly annotations = new Map<string, { state: SceneAnnotationState; object: THREE.Group }>();
  private readonly spaceVisuals = new Map<string, { modelId: string; object: THREE.Group }>();
  private readonly modelColorOverrides = new Map<string, string>();
  private readonly modelMaterialOverrides = new Map<string, SceneMaterialState>();
  private readonly layerObjects = new Map<string, Map<string, THREE.Object3D>>();
  private readonly layerStates = new Map<string, Map<string, SceneLayerState>>();
  private readonly fragmentModels = new Map<string, FRAGS.FragmentsModel>();
  private readonly fragmentLayers = new Map<string, Map<string, FragmentLayerEntry>>();
  private readonly fragmentTrees = new Map<string, LayerTreeNode>();
  private readonly fragmentNodeIdsByLocalId = new Map<string, Map<number, string>>();
  private readonly componentRecords = new Map<string, ComponentRecord[]>();
  private readonly isolationVisibility = new Map<THREE.Object3D, boolean>();
  private readonly explosionPositions = new Map<string, Map<THREE.Object3D, THREE.Vector3>>();
  private readonly explosionFactors = new Map<string, number>();
  private readonly explosionModes = new Map<string, ExplosionMode>();
  private readonly collisionEnabledIds = new Set<string>();
  private readonly collidingIds = new Set<string>();
  private collisionRecords: CollisionRecord[] = [];
  private readonly collisionOriginalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private readonly collisionMaterial = new THREE.MeshBasicMaterial({
    color: 0xff334f,
    transparent: true,
    opacity: 0.72,
    depthTest: true,
    depthWrite: false
  });
  private resizeObserver: ResizeObserver;
  private animationFrame = 0;
  private lastFrameTime = performance.now();
  private frameSampleStartedAt = performance.now();
  private frameSampleCount = 0;
  private frameRate = 0;
  private selectedId: string | undefined;
  private inspectedObject: THREE.Object3D | undefined;
  private navigationMode: NavigationMode = "orbit";
  private selectionScope: SelectionScope = "model";
  private measureEnabled = false;
  private annotationPlacementEnabled = false;
  private selectedAnnotationId: string | undefined;
  private measureMode: MeasureMode = "distance";
  private measurementPreview: THREE.Group | undefined;
  private avatar?: THREE.Group;
  private avatarVisible = false;
  private readonly avatarHeading = new THREE.Vector3(0, 0, 1);
  private readonly navigationViewStates = new Map<NavigationMode, NavigationViewState>();
  private readOnlyMode = false;
  private readonly firstPersonVelocity = new THREE.Vector3();
  private readonly eyeHeight = 1.68;
  private lastCollisionCheck = 0;
  private clippingState: ClippingState = { enabled: false, mode: "axis", axis: "x", offset: 0, inverted: false };
  private clippingHelper: THREE.Box3Helper | undefined;
  private selectionHelper: THREE.Box3Helper | undefined;
  private focusedSpaceKey: string | undefined;
  private selectedFragmentNodeId: string | undefined;
  private fragmentSelectionVersion = 0;
  private readonly sceneLights = new Map<string, THREE.Light>();
  private weatherMode: WeatherMode = "sunny";
  private lightingState: GlobalLightingState = { enabled: true, intensity: 1, shadowsEnabled: true, reflectionsEnabled: true, lights: structuredClone(DEFAULT_SCENE_LIGHTS) };
  private environmentState: SceneEnvironmentState = { gridVisible: true, backgroundColor: "#202a31", skybox: "none" };
  private gridHelper?: THREE.GridHelper;
  private readonly skyboxTextures = new Map<Exclude<SkyboxPreset, "none">, THREE.CanvasTexture>();
  private externalEnvironmentTexture?: THREE.Texture;
  private xrActive = false;
  private xrBackground?: THREE.Color | THREE.Texture | null;
  private floorStates = new Map<string, SceneFloorState>();
  private weatherEffect: THREE.Points | THREE.LineSegments | undefined;
  private sceneAnimation: SceneAnimationState = {
    duration: 10,
    loop: false,
    pingPong: false,
    playbackSpeed: 1,
    cameraInterpolation: "smooth",
    showCameraPath: true,
    camera: [],
    models: []
  };
  private sceneAnimationTime = 0;
  private sceneAnimationPlaying = false;
  private sceneAnimationDirection = 1;
  private cameraPathHelper: THREE.Group | undefined;
  private lastAnimationNotify = 0;
  private lastCameraSignature = "";

  static async create(container: HTMLElement, requestedBackend: RendererBackend = "webgl"): Promise<ViewerEngine> {
    if (requestedBackend === "webgpu") {
      if (!("gpu" in navigator)) throw new Error("当前浏览器或显卡不支持 WebGPU");
      const { ClippingGroup, WebGPURenderer } = await import("three/webgpu");
      const renderer = new WebGPURenderer({ antialias: true, powerPreference: "high-performance" });
      try {
        await renderer.init();
        if (!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) {
          throw new Error("WebGPU 初始化失败，已回退 WebGL");
        }
        return new ViewerEngine(container, renderer, "webgpu", new ClippingGroup());
      } catch (error) {
        renderer.dispose();
        throw error;
      }
    }
    return new ViewerEngine(
      container,
      new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" }),
      "webgl",
      new THREE.Group()
    );
  }

  private constructor(
    private readonly container: HTMLElement,
    renderer: RendererInstance,
    private readonly rendererBackend: RendererBackend,
    modelRoot: THREE.Group | ClippingGroup
  ) {
    this.scene.background = new THREE.Color(0x171a1d);
    this.camera.position.set(12, 8, 12);
    this.renderer = renderer;
    this.modelRoot = modelRoot;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    if (this.renderer instanceof THREE.WebGLRenderer) this.renderer.localClippingEnabled = true;
    this.container.append(this.renderer.domElement);
    this.scene.add(this.modelRoot);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.target.set(0, 1, 0);
    this.pointer = new PointerLockControls(this.camera, this.renderer.domElement);
    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.scene.add(this.transform.getHelper());
    this.transform.addEventListener("dragging-changed", (event) => {
      this.orbit.enabled = !event.value && this.navigationMode !== "firstPerson";
      const selected = this.getSelected();
      if (selected && this.fragmentModels.has(selected.id)) this.syncFragmentsTransformState(selected.id, Boolean(event.value));
    });
    this.transform.addEventListener("objectChange", () => {
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
    this.dracoLoader.setDecoderConfig({ type: "wasm" });
    this.gltfLoader.setDRACOLoader(this.dracoLoader);
    this.importer.wasm = { absolute: true, path: `${import.meta.env.BASE_URL}wasm/` };
    this.fragments.init(workerUrl);
    this.fragments.list.onItemSet.add(({ value: model }) => {
      model.useCamera(this.camera);
      void this.fragments.core.update(true);
    });
    this.orbit.addEventListener("change", () => {
      void this.fragments.core.update();
      this.emitCameraChange();
    });

    this.renderer.domElement.addEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.addEventListener("pointermove", this.handlePointerMove);
    this.renderer.domElement.addEventListener("pointerleave", this.handlePointerLeave);
    this.renderer.domElement.addEventListener("contextmenu", this.preventContextMenu);
    this.renderer.domElement.addEventListener("dblclick", () => {
      if (this.navigationMode === "firstPerson" && !this.pointer.isLocked) this.pointer.lock();
    });
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.animate();
  }

  getRendererBackend(): RendererBackend {
    return this.rendererBackend;
  }

  listModels(): LoadedSceneModel[] {
    return [...this.models.values()];
  }

  listAnnotations(): SceneAnnotationState[] {
    return [...this.annotations.values()].map(({ state }) => structuredClone(state));
  }

  getSelectedAnnotationId(): string | undefined {
    return this.selectedAnnotationId;
  }

  setAnnotationPlacementEnabled(enabled: boolean): void {
    this.annotationPlacementEnabled = enabled;
    if (enabled) this.setMeasureEnabled(false);
    this.updateToolCursor();
  }

  isAnnotationPlacementEnabled(): boolean {
    return this.annotationPlacementEnabled;
  }

  addAnnotation(annotation: SceneAnnotationState): void {
    this.removeAnnotation(annotation.id, false);
    const state = normalizeAnnotation(annotation);
    const object = this.createAnnotationObject(state);
    this.annotations.set(state.id, { state, object });
    this.scene.add(object);
  }

  updateAnnotation(id: string, patch: Partial<Omit<SceneAnnotationState, "id">>): SceneAnnotationState | undefined {
    const current = this.annotations.get(id);
    if (!current) return undefined;
    const next = normalizeAnnotation({ ...current.state, ...patch, id });
    this.disposeObject(current.object);
    const object = this.createAnnotationObject(next);
    this.annotations.set(id, { state: next, object });
    this.scene.add(object);
    return structuredClone(next);
  }

  removeAnnotation(id: string, notify = true): void {
    const current = this.annotations.get(id);
    if (!current) return;
    this.disposeObject(current.object);
    this.annotations.delete(id);
    if (this.selectedAnnotationId === id) {
      this.selectedAnnotationId = undefined;
      if (notify) this.onAnnotationSelectionChange?.(undefined);
    }
  }

  clearAnnotations(notify = true): void {
    for (const id of [...this.annotations.keys()]) this.removeAnnotation(id, false);
    this.selectedAnnotationId = undefined;
    if (notify) this.onAnnotationSelectionChange?.(undefined);
  }

  selectAnnotation(id: string | undefined): void {
    if (id && !this.annotations.has(id)) return;
    if (this.selectedId) this.select(undefined);
    const previous = this.selectedAnnotationId;
    this.selectedAnnotationId = id;
    if (previous && previous !== id) this.refreshAnnotationVisual(previous);
    if (id) this.refreshAnnotationVisual(id);
    this.onAnnotationSelectionChange?.(id);
  }

  focusAnnotation(id: string): void {
    const annotation = this.annotations.get(id)?.state;
    if (!annotation) return;
    this.prepareForFocusedView();
    const target = new THREE.Vector3(annotation.position.x, annotation.position.y, annotation.position.z);
    const distance = Math.max(3.5, (annotation.size ?? 1) * 4);
    this.orbit.target.copy(target);
    this.camera.position.copy(target).add(new THREE.Vector3(1, 0.7, 1).normalize().multiplyScalar(distance));
    this.orbit.update();
    this.rememberNavigationState("orbit");
    this.selectAnnotation(id);
  }

  getSceneStatistics(): SceneStatistics {
    let triangleCount = 0;
    let vertexCount = 0;
    for (const model of this.models.values()) {
      model.object.traverse((object) => {
        const renderable = object as THREE.Object3D & { geometry?: THREE.BufferGeometry; isMesh?: boolean };
        if (!renderable.geometry?.attributes.position || object.userData.layerDeleted) return;
        const positions = renderable.geometry.attributes.position.count;
        vertexCount += positions;
        if (renderable.isMesh) triangleCount += renderable.geometry.index ? renderable.geometry.index.count / 3 : positions / 3;
      });
    }
    return {
      modelCount: [...this.models.values()].filter((item) => item.kind === "model").length,
      primitiveCount: [...this.models.values()].filter((item) => item.kind === "primitive").length,
      componentCount: this.getComponentCount(),
      triangleCount: Math.round(triangleCount),
      vertexCount
    };
  }

  getFrameRate(): number {
    return this.frameRate;
  }

  applySceneDataMessage(message: SceneDataMessage): boolean {
    const target = message.target;
    if (!target || !message.action) return false;
    if (message.action === "visibility" && target.modelId) {
      const visible = Boolean(message.value);
      if (target.layerId) this.setLayerVisible(target.modelId, target.layerId, visible);
      else this.setVisible(target.modelId, visible);
      return true;
    }
    if (message.action === "color" && target.modelId && typeof message.value === "string" && /^#[0-9a-f]{6}$/i.test(message.value)) {
      if (target.layerId) {
        const entry = this.fragmentLayers.get(target.modelId)?.get(target.layerId);
        const fragmentModel = this.fragmentModels.get(target.modelId);
        if (entry && fragmentModel) void fragmentModel.setColor(entry.localIds, new THREE.Color(message.value));
        else {
          const object = this.layerObjects.get(target.modelId)?.get(target.layerId);
          if (object) this.setObjectColor(object, message.value);
        }
      } else {
        const model = this.models.get(target.modelId);
        if (model) this.setObjectColor(model.object, message.value);
      }
      return true;
    }
    if (message.action === "position" && target.modelId && isVectorValue(message.value)) {
      const model = this.models.get(target.modelId);
      if (!model) return false;
      model.object.position.set(message.value.x, message.value.y, message.value.z);
      model.object.updateWorldMatrix(true, true);
      return true;
    }
    if (message.action === "label" && target.annotationId) {
      const value = typeof message.value === "string" ? message.value : JSON.stringify(message.value);
      return Boolean(this.updateAnnotation(target.annotationId, { description: value }));
    }
    return false;
  }

  hasAnimation(id: string): boolean {
    return this.mixers.has(id);
  }

  isAnimationEnabled(id: string): boolean {
    return this.animationEnabledIds.has(id);
  }

  setAnimationEnabled(id: string, enabled: boolean): void {
    const mixer = this.mixers.get(id);
    const model = this.models.get(id);
    if (!mixer || !model) return;
    mixer.timeScale = enabled ? 1 : 0;
    if (enabled) this.animationEnabledIds.add(id);
    else this.animationEnabledIds.delete(id);
    this.onModelChange?.(model);
  }

  getWeather(): WeatherMode {
    return this.weatherMode;
  }

  setWeather(mode: WeatherMode): void {
    this.weatherMode = mode;
    this.disposeWeatherEffect();
    if (mode === "sunny") {
      this.scene.fog = new THREE.FogExp2(0x9fc2d4, 0.0018);
    } else if (mode === "rain") {
      this.scene.fog = new THREE.FogExp2(0x64717a, 0.008);
      this.weatherEffect = this.createRainEffect();
      this.scene.add(this.weatherEffect);
    } else {
      this.scene.fog = new THREE.FogExp2(0xc5cdd1, 0.006);
      this.weatherEffect = this.createSnowEffect();
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
      skybox: ["none", "clear", "sunset", "night"].includes(state.skybox) ? state.skybox : "none",
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
      shadowsEnabled: state.shadowsEnabled ?? true,
      reflectionsEnabled: state.reflectionsEnabled ?? true,
      lights: structuredClone(state.lights?.length ? state.lights : DEFAULT_SCENE_LIGHTS)
    };
    this.syncSceneLights();
    this.applyLighting();
    void this.applyEnvironment();
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
        ...(typeof standard.roughness === "number" ? { roughness: standard.roughness } : {}),
        ...(typeof standard.metalness === "number" ? { metalness: standard.metalness } : {}),
        ...(standard.emissive ? { emissive: `#${standard.emissive.getHexString()}`, emissiveIntensity: standard.emissiveIntensity } : {}),
        ...(typeof standard.wireframe === "boolean" ? { wireframe: standard.wireframe } : {}),
        doubleSided: standard.side === THREE.DoubleSide
      };
    });
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
    this.applyMaterialState(object, patch);
    if (object !== selected.object) this.updateLayerState(selected.id, String(object.userData.layerNodeId), { material: patch });
    else this.modelMaterialOverrides.set(selected.id, { ...this.modelMaterialOverrides.get(selected.id), ...structuredClone(patch) });
    selected.object.updateWorldMatrix(true, true);
    this.onModelChange?.(selected);
  }

  getModelMaterialOverride(id: string): SceneMaterialState | undefined {
    const state = this.modelMaterialOverrides.get(id);
    return state ? structuredClone(state) : undefined;
  }

  getFloorStates(): SceneFloorState[] {
    return this.getComponentFacets().levels.map((level) => structuredClone(this.floorStates.get(level) ?? { level, visible: true, expansion: 0 }));
  }

  applyFloorStates(states: SceneFloorState[] | undefined): void {
    this.floorStates.clear();
    for (const state of states ?? []) this.setFloorState(state.level, state.visible, state.expansion);
  }

  setFloorState(level: string, visible: boolean, expansion = 0): void {
    this.floorStates.set(level, { level, visible, expansion });
    const records = [...this.componentRecords.values()].flat().filter((record) => record.level === level);
    for (const record of records) {
      const fragment = this.fragmentLayers.get(record.modelId)?.get(record.id);
      const fragmentModel = this.fragmentModels.get(record.modelId);
      if (fragment && fragmentModel) {
        void fragmentModel.setVisible(fragment.localIds, visible).then(() => this.fragments.core.update(true));
        continue;
      }
      const object = this.layerObjects.get(record.modelId)?.get(record.id);
      if (!object) continue;
      object.visible = visible;
      if (object.userData.floorBaseY === undefined) object.userData.floorBaseY = object.position.y;
      object.position.y = Number(object.userData.floorBaseY) + expansion;
    }
  }

  async isXRSupported(mode: "immersive-vr" | "immersive-ar"): Promise<boolean> {
    return this.renderer instanceof THREE.WebGLRenderer && Boolean(navigator.xr && await navigator.xr.isSessionSupported(mode));
  }

  async startXR(mode: "immersive-vr" | "immersive-ar"): Promise<void> {
    if (!(this.renderer instanceof THREE.WebGLRenderer) || !navigator.xr) throw new Error("XR 仅支持 WebGL 和具备 WebXR 的浏览器");
    if (!await navigator.xr.isSessionSupported(mode)) throw new Error(mode === "immersive-vr" ? "当前设备不支持 VR" : "当前设备不支持 AR");
    const session = await navigator.xr.requestSession(mode, mode === "immersive-ar" ? { requiredFeatures: ["local"], optionalFeatures: ["hit-test", "dom-overlay"], domOverlay: { root: document.body } } : { optionalFeatures: ["local-floor", "bounded-floor"] });
    this.xrActive = true;
    this.xrBackground = this.scene.background;
    if (mode === "immersive-ar") this.scene.background = null;
    cancelAnimationFrame(this.animationFrame);
    this.renderer.xr.enabled = true;
    this.renderer.setAnimationLoop(this.animate);
    await this.renderer.xr.setSession(session);
    session.addEventListener("end", () => {
      this.renderer.setAnimationLoop(null);
      this.renderer.xr.enabled = false;
      this.xrActive = false;
      this.scene.background = this.xrBackground ?? null;
      this.animate();
    }, { once: true });
  }

  getSceneAnimation(): SceneAnimationState {
    return structuredClone(this.sceneAnimation);
  }

  setSceneAnimation(animation: SceneAnimationState): void {
    this.sceneAnimation = {
      duration: Math.max(animation.duration, 0.1),
      loop: animation.loop,
      pingPong: animation.pingPong ?? false,
      playbackSpeed: THREE.MathUtils.clamp(animation.playbackSpeed ?? 1, 0.1, 4),
      cameraInterpolation: animation.cameraInterpolation ?? "smooth",
      showCameraPath: animation.showCameraPath ?? true,
      camera: [...animation.camera].sort((a, b) => a.time - b.time),
      models: [...animation.models].sort((a, b) => a.time - b.time)
    };
    this.sceneAnimationTime = Math.min(this.sceneAnimationTime, this.sceneAnimation.duration);
    this.updateCameraPathHelper();
    this.onAnimationChange?.(this.sceneAnimationTime, this.sceneAnimationPlaying);
  }

  seekSceneAnimation(time: number): void {
    this.sceneAnimationTime = THREE.MathUtils.clamp(time, 0, this.sceneAnimation.duration);
    this.applySceneAnimationFrame(this.sceneAnimationTime);
    this.onAnimationChange?.(this.sceneAnimationTime, this.sceneAnimationPlaying);
  }

  playSceneAnimation(): void {
    if (this.sceneAnimation.camera.length === 0 && this.sceneAnimation.models.length === 0) return;
    if (this.sceneAnimationTime >= this.sceneAnimation.duration) {
      this.sceneAnimationTime = 0;
      this.sceneAnimationDirection = 1;
    }
    this.sceneAnimationPlaying = true;
    this.orbit.enabled = false;
    this.updateTransformAccess();
    this.onAnimationChange?.(this.sceneAnimationTime, true);
  }

  pauseSceneAnimation(): void {
    this.sceneAnimationPlaying = false;
    this.orbit.enabled = this.navigationMode !== "firstPerson";
    this.updateTransformAccess();
    this.onAnimationChange?.(this.sceneAnimationTime, false);
  }

  isSceneAnimationPlaying(): boolean {
    return this.sceneAnimationPlaying;
  }

  searchComponents(filter: ComponentFilter, limit = 100): ComponentRecord[] {
    const records = [...this.componentRecords.values()].flat().filter((record) => {
      const object = this.layerObjects.get(record.modelId)?.get(record.id);
      return object && !object.userData.layerDeleted;
    });
    return filterComponents(records, filter, limit);
  }

  getComponentFacets(): ComponentFacets {
    return componentFacets([...this.componentRecords.values()].flat());
  }

  getComponentCount(): number {
    return [...this.componentRecords.values()].reduce((total, records) => total + records.length, 0);
  }

  getSpaces(): BimSpaceRecord[] {
    const output: BimSpaceRecord[] = [];
    for (const model of this.models.values()) {
      const nativeSpaces = model.object.userData.BimSpaces as Record<string, NativeBimSpaceMetadata> | undefined;
      if (nativeSpaces && Object.keys(nativeSpaces).length > 0) {
        for (const [id, space] of Object.entries(nativeSpaces)) {
          output.push({
            id: space.spaceId ?? id,
            modelId: model.id,
            modelName: model.name,
            name: space.name || `空间 ${id}`,
            ...(space.number ? { number: space.number } : {}),
            level: space.level || "未指定楼层",
            kind: space.kind || "Room",
            ...(space.department ? { department: space.department } : {}),
            ...(space.areaSquareMetres === undefined ? {} : { areaSquareMetres: space.areaSquareMetres }),
            ...(space.volumeCubicMetres === undefined ? {} : { volumeCubicMetres: space.volumeCubicMetres }),
            ...(space.bounds ? { bounds: structuredClone(space.bounds) } : {}),
            ...(space.parameters ? {
              parameters: space.parameters.flatMap((parameter) => parameter.name && parameter.value !== undefined ? [{
                name: parameter.name,
                value: parameter.value,
                ...(parameter.groupTypeId ? { group: parameter.groupTypeId } : {})
              }] : [])
            } : {})
          });
        }
        continue;
      }
      for (const component of this.componentRecords.get(model.id) ?? []) {
        const descriptor = [component.type, component.category, component.name, ...Object.values(component.properties)].join(" ").toLocaleLowerCase("zh-CN");
        if (!/(ifcspace|\bspace\b|\broom\b|空间|房间)/i.test(descriptor)) continue;
        const number = firstProperty(component.properties, ["Number", "LongName", "编号", "房间编号"]);
        output.push({
          id: component.stableId,
          modelId: model.id,
          modelName: model.name,
          name: component.name,
          ...(number ? { number } : {}),
          level: component.level || "未指定楼层",
          kind: component.type,
          componentId: component.id
        });
      }
    }
    return output.sort((a, b) => a.modelName.localeCompare(b.modelName, "zh-CN") || a.level.localeCompare(b.level, "zh-CN") || (a.number ?? a.name).localeCompare(b.number ?? b.name, "zh-CN"));
  }

  focusSpace(space: BimSpaceRecord): boolean {
    if (space.componentId) {
      const component = this.componentRecord(space.modelId, space.componentId);
      if (component) {
        this.prepareForFocusedView();
        this.focusComponent(component);
        return true;
      }
    }
    const model = this.models.get(space.modelId);
    if (!model || !space.bounds) return false;
    const localBox = normalizedSpaceBox(space.bounds);
    if (!localBox) return false;
    this.prepareForFocusedView();
    this.select(undefined);
    model.object.updateWorldMatrix(true, true);
    const box = localBox.clone().applyMatrix4(model.object.matrixWorld);
    if (!this.focusBox(box)) return false;
    this.setSpaceVisible(space, true);
    this.focusedSpaceKey = spaceVisualKey(space);
    this.showSelectionBox(box);
    return true;
  }

  isSpaceVisible(space: BimSpaceRecord): boolean {
    return this.spaceVisuals.has(spaceVisualKey(space));
  }

  setSpaceVisible(space: BimSpaceRecord, visible: boolean): boolean {
    const key = spaceVisualKey(space);
    const current = this.spaceVisuals.get(key);
    if (!visible) {
      if (current) {
        this.disposeObject(current.object);
        this.spaceVisuals.delete(key);
      }
      if (this.focusedSpaceKey === key) {
        this.removeSelectionHelper();
        this.focusedSpaceKey = undefined;
      }
      return true;
    }
    if (current) return true;
    const model = this.models.get(space.modelId);
    const box = space.bounds ? normalizedSpaceBox(space.bounds) : undefined;
    if (!model || !box) return false;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const group = new THREE.Group();
    group.name = `helper:space:${key}`;
    group.userData.spaceId = space.id;
    group.userData.modelId = space.modelId;
    group.matrixAutoUpdate = false;
    const fill = new THREE.Mesh(
      new THREE.BoxGeometry(size.x, size.y, size.z),
      new THREE.MeshBasicMaterial({
        color: 0x31c8de,
        transparent: true,
        opacity: 0.18,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    fill.position.copy(center);
    fill.name = "helper:space-fill";
    fill.renderOrder = 850;
    fill.raycast = () => undefined;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(fill.geometry),
      new THREE.LineBasicMaterial({ color: 0x55dced, transparent: true, opacity: 0.9, depthTest: false })
    );
    edges.position.copy(center);
    edges.name = "helper:space-edges";
    edges.renderOrder = 851;
    edges.raycast = () => undefined;
    group.add(fill, edges);
    this.scene.add(group);
    this.spaceVisuals.set(key, { modelId: space.modelId, object: group });
    this.syncSpaceVisuals();
    return true;
  }

  setSpacesVisible(spaces: BimSpaceRecord[], visible: boolean): number {
    let changed = 0;
    for (const space of spaces) if (this.setSpaceVisible(space, visible)) changed += 1;
    return changed;
  }

  getSelectedComponentRecord(): ComponentRecord | undefined {
    if (!this.selectedId) return undefined;
    return this.componentRecord(this.selectedId, this.getSelectedLayerId() ?? "root");
  }

  focusComponent(record: ComponentRecord): void {
    this.selectLayer(record.modelId, record.id);
    const fragmentEntry = this.fragmentLayers.get(record.modelId)?.get(record.id);
    const fragmentModel = this.fragmentModels.get(record.modelId);
    if (fragmentEntry && fragmentModel) {
      void fragmentModel.getMergedBox(fragmentEntry.localIds).then((box) => this.focusBox(box));
      return;
    }
    const object = this.layerObjects.get(record.modelId)?.get(record.id);
    if (object) this.focusObject(object);
  }

  isolateComponents(records: ComponentRecord[]): void {
    this.clearIsolation();
    const targets = records.flatMap((record) => {
      const object = this.layerObjects.get(record.modelId)?.get(record.id);
      return object ? [object] : [];
    });
    if (targets.length === 0) return;
    for (const model of this.models.values()) {
      model.object.traverse((object) => {
        this.isolationVisibility.set(object, object.visible);
        const related = targets.some((target) => object === target || isAncestorOf(object, target) || isAncestorOf(target, object));
        object.visible = related && !object.userData.layerDeleted;
      });
    }
    this.updateCollisions(true);
    this.onCollisionChange?.();
  }

  clearIsolation(): void {
    if (this.isolationVisibility.size === 0) return;
    for (const [object, visible] of this.isolationVisibility) object.visible = visible;
    this.isolationVisibility.clear();
    this.updateCollisions(true);
    this.onCollisionChange?.();
  }

  isIsolationActive(): boolean {
    return this.isolationVisibility.size > 0;
  }

  getSelected(): LoadedSceneModel | undefined {
    return this.selectedId ? this.models.get(this.selectedId) : undefined;
  }

  async exportSceneGlb(): Promise<ArrayBuffer> {
    for (const model of this.models.values()) this.setCollisionHighlight(model, false);
    const exportRoot = new THREE.Group();
    exportRoot.name = "BIM Studio Scene";
    let meshCount = 0;
    const generatedFragmentRoots: THREE.Group[] = [];
    try {
      for (const model of this.models.values()) {
      if (!model.visible || !model.object.visible) continue;
      const fragmentsModel = this.fragmentModels.get(model.id);
      if (fragmentsModel) {
        const fragmentRoot = await this.buildFragmentsExportObject(model, fragmentsModel);
        const fragmentMeshCount = objectVisibleMeshCount(fragmentRoot);
        if (fragmentMeshCount > 0) {
          meshCount += fragmentMeshCount;
          generatedFragmentRoots.push(fragmentRoot);
          exportRoot.add(fragmentRoot);
        }
        continue;
      }
      const clone = model.object.clone(true);
      sanitizeExportObject(clone);
      const currentMeshCount = objectVisibleMeshCount(clone);
      meshCount += currentMeshCount;
      exportRoot.add(clone);
      }
      if (meshCount === 0) {
        throw new Error("当前场景没有可导出的可见网格");
      }
      const result = await new GLTFExporter().parseAsync(exportRoot, {
        binary: true,
        onlyVisible: true,
        includeCustomExtensions: false,
        trs: true
      });
      if (!(result instanceof ArrayBuffer)) throw new Error("GLB 导出器返回了非二进制结果");
      if (result.byteLength <= 1024) throw new Error("GLB 导出结果为空，请确认场景中存在可见模型网格");
      return result;
    } finally {
      for (const root of generatedFragmentRoots) this.disposeObject(root);
      this.updateCollisions(true);
    }
  }

  private async buildFragmentsExportObject(model: LoadedSceneModel, fragmentsModel: FRAGS.FragmentsModel): Promise<THREE.Group> {
    const root = new THREE.Group();
    root.name = model.name;
    root.position.copy(model.object.position);
    root.quaternion.copy(model.object.quaternion);
    root.scale.copy(model.object.scale);
    const material = new THREE.MeshStandardMaterial({ color: 0xbcc3c7, roughness: 0.78, metalness: 0.02 });
    const items = await fragmentsModel.getItemsWithGeometry();
    for (let index = 0; index < items.length; index += 1) {
      const geometryAccess = await items[index]!.getGeometry();
      if (!geometryAccess || !await geometryAccess.getVisibility()) continue;
      const meshData = await geometryAccess.get();
      for (const [partIndex, data] of meshData.entries()) {
        if (!data.positions || data.positions.length < 3) continue;
        const geometry = new THREE.BufferGeometry();
        const positions = data.positions instanceof Float32Array ? data.positions : new Float32Array(data.positions);
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        if (data.indices?.length) geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
        if (data.normals?.length === positions.length) {
          const normals = new Float32Array(data.normals.length);
          for (let normalIndex = 0; normalIndex < data.normals.length; normalIndex += 1) {
            normals[normalIndex] = Math.max(-1, data.normals[normalIndex]! / 32767);
          }
          geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
        } else {
          geometry.computeVertexNormals();
        }
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = `IFC ${data.localId ?? index}-${partIndex + 1}`;
        mesh.applyMatrix4(data.transform);
        root.add(mesh);
      }
      if (index > 0 && index % 100 === 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    if (root.children.length === 0) material.dispose();
    return root;
  }

  getSelectedLayerId(): string | undefined {
    return this.selectedFragmentNodeId ?? this.inspectedObject?.userData.layerNodeId as string | undefined;
  }

  isModelLocked(modelId: string): boolean {
    return Boolean(this.models.get(modelId)?.object.userData.modelLocked);
  }

  setModelLocked(modelId: string, locked: boolean): void {
    const model = this.models.get(modelId);
    if (!model) return;
    model.object.userData.modelLocked = locked;
    if (this.selectedId === modelId) this.updateTransformAccess();
    this.onModelChange?.(model);
  }

  isLayerLocked(modelId: string, nodeId: string): boolean {
    if (this.isModelLocked(modelId)) return true;
    if (nodeId === "root") return false;
    const fragmentEntry = this.fragmentLayers.get(modelId)?.get(nodeId);
    if (fragmentEntry) return fragmentEntry.node.locked;
    const object = this.layerObjects.get(modelId)?.get(nodeId);
    if (!object) return false;
    let current: THREE.Object3D | null = object;
    while (current) {
      if (current.userData.layerLocked) return true;
      if (current === this.models.get(modelId)?.object) break;
      current = current.parent;
    }
    return false;
  }

  setLayerLocked(modelId: string, nodeId: string, locked: boolean): void {
    if (nodeId === "root") {
      this.setModelLocked(modelId, locked);
      return;
    }
    const model = this.models.get(modelId);
    if (!model) return;
    const fragmentEntry = this.fragmentLayers.get(modelId)?.get(nodeId);
    if (fragmentEntry) setTreeLock(fragmentEntry.node, locked);
    const object = this.layerObjects.get(modelId)?.get(nodeId);
    if (object) object.userData.layerLocked = locked;
    this.updateLayerState(modelId, nodeId, { locked });
    if (this.selectedId === modelId) this.updateTransformAccess();
    this.onModelChange?.(model);
  }

  isSelectionLocked(): boolean {
    const selected = this.getSelected();
    if (!selected) return false;
    return this.isLayerLocked(selected.id, this.getSelectedLayerId() ?? "root");
  }

  getSelectionName(): string {
    const selected = this.getSelected();
    const fragmentEntry = selected && this.selectedFragmentNodeId
      ? this.fragmentLayers.get(selected.id)?.get(this.selectedFragmentNodeId)
      : undefined;
    if (fragmentEntry) return fragmentEntry.node.name;
    return this.inspectedObject?.name || selected?.name || "";
  }

  getSelectionVisible(): boolean {
    const selected = this.getSelected();
    const fragmentEntry = selected && this.selectedFragmentNodeId
      ? this.fragmentLayers.get(selected.id)?.get(this.selectedFragmentNodeId)
      : undefined;
    if (fragmentEntry) return fragmentEntry.node.visible;
    return this.inspectedObject?.visible ?? this.getSelected()?.visible ?? false;
  }

  getSelectionOpacity(): number {
    const selected = this.getSelected();
    if (!selected) return 1;
    if (this.selectedFragmentNodeId) {
      return this.layerStates.get(selected.id)?.get(this.selectedFragmentNodeId)?.opacity ?? 1;
    }
    if (!this.inspectedObject || this.inspectedObject === selected.object) return selected.opacity;
    let opacity: number | undefined;
    this.inspectedObject.traverse((child) => {
      if (opacity !== undefined) return;
      const mesh = child as THREE.Mesh;
      const material = this.materialsForMesh(mesh)[0];
      if (material) opacity = material.opacity;
    });
    return opacity ?? 1;
  }

  getSelectionColor(): string {
    const selected = this.getSelected();
    if (selected && this.selectedFragmentNodeId) {
      return this.layerStates.get(selected.id)?.get(this.selectedFragmentNodeId)?.color ?? "#2684ff";
    }
    return this.objectColor(this.inspectedObject);
  }

  getModelColor(id: string): string {
    return this.objectColor(this.models.get(id)?.object);
  }

  getModelColorOverride(id: string): string | undefined {
    return this.modelColorOverrides.get(id);
  }

  setSelectionColor(color: string): void {
    const model = this.getSelected();
    const object = this.inspectedObject;
    if (!model) return;
    if (this.selectedFragmentNodeId) {
      const entry = this.fragmentLayers.get(model.id)?.get(this.selectedFragmentNodeId);
      const fragmentModel = this.fragmentModels.get(model.id);
      if (!entry || !fragmentModel) return;
      void fragmentModel.setColor(entry.localIds, new THREE.Color(color));
      this.updateLayerState(model.id, this.selectedFragmentNodeId, { color });
      this.onModelChange?.(model);
      return;
    }
    if (!object) return;
    const wholeFragmentModel = this.fragmentModels.get(model.id);
    const wholeFragmentEntry = this.fragmentLayers.get(model.id)?.get("root");
    if (object === model.object && wholeFragmentModel && wholeFragmentEntry) {
      void wholeFragmentModel.setColor(wholeFragmentEntry.localIds, new THREE.Color(color));
      this.modelColorOverrides.set(model.id, color);
      this.onModelChange?.(model);
      return;
    }
    this.setObjectColor(object, color);
    if (object === model.object) this.modelColorOverrides.set(model.id, color);
    else this.updateLayerState(model.id, String(object.userData.layerNodeId), { color });
    this.onModelChange?.(model);
  }

  getSelectionProperties(): Record<string, string> {
    const selected = this.getSelected();
    if (!selected) return {};
    if (this.selectedFragmentNodeId) {
      const entry = this.fragmentLayers.get(selected.id)?.get(this.selectedFragmentNodeId);
      if (entry) return { ...entry.properties, 名称: entry.node.name, 类型: entry.node.type, 构件数量: String(entry.localIds.length) };
    }
    const properties: Record<string, string> = {
      名称: this.inspectedObject?.name || selected.name,
      类型: this.inspectedObject?.type || selected.object.type,
      对象数量: String(countObjects(selected.object))
    };
    let current: THREE.Object3D | null = this.inspectedObject ?? selected.object;
    while (current) {
      flattenProperties(current.userData, properties);
      if (current === selected.object) break;
      current = current.parent;
    }
    return properties;
  }

  getLayerTree(modelId: string): LayerTreeNode | undefined {
    const fragmentTree = this.fragmentTrees.get(modelId);
    if (fragmentTree) {
      const snapshot = structuredClone(fragmentTree);
      if (this.isModelLocked(modelId)) setTreeLock(snapshot, true);
      return snapshot;
    }
    const model = this.models.get(modelId);
    const objects = this.layerObjects.get(modelId);
    if (!model || !objects) return undefined;
    const build = (object: THREE.Object3D, ancestorLocked = false): LayerTreeNode => ({
      id: String(object.userData.layerNodeId),
      modelId,
      name: object.name || object.userData.layer || object.type,
      type: object.type,
      visible: object.visible,
      locked: ancestorLocked || Boolean(object.userData.layerLocked) || this.isModelLocked(modelId),
      deleted: Boolean(object.userData.layerDeleted),
      children: object.userData.NodeType === "Element" ? [] : object.children
        .filter((child) => !child.name.startsWith("helper:") && !child.userData.layerDeleted)
        .map((child) => build(child, ancestorLocked || Boolean(object.userData.layerLocked)))
    });
    return build(model.object);
  }

  selectLayer(modelId: string, nodeId: string): void {
    this.focusedSpaceKey = undefined;
    if (nodeId === "root") {
      this.select(modelId);
      return;
    }
    const model = this.models.get(modelId);
    const fragmentEntry = this.fragmentLayers.get(modelId)?.get(nodeId);
    const fragmentModel = this.fragmentModels.get(modelId);
    if (model && fragmentEntry && fragmentModel) {
      this.selectedId = modelId;
      this.selectedFragmentNodeId = nodeId;
      this.inspectedObject = model.object;
      this.transform.detach();
      void this.highlightFragmentSelection(fragmentModel, fragmentEntry);
      this.onSelectionChange?.(model);
      return;
    }
    const object = this.layerObjects.get(modelId)?.get(nodeId);
    if (!model || !object) return;
    this.selectedId = modelId;
    this.selectedFragmentNodeId = undefined;
    this.inspectedObject = object;
    this.updateTransformAccess();
    this.updateSelectionHelper();
    this.onSelectionChange?.(model);
  }

  setLayerVisible(modelId: string, nodeId: string, visible: boolean): void {
    const model = this.models.get(modelId);
    const fragmentEntry = this.fragmentLayers.get(modelId)?.get(nodeId);
    const fragmentModel = this.fragmentModels.get(modelId);
    if (model && fragmentEntry && fragmentModel) {
      setTreeVisibility(fragmentEntry.node, visible);
      void fragmentModel.setVisible(fragmentEntry.localIds, visible).then(() => this.fragments.core.update(true));
      this.updateLayerState(modelId, nodeId, { visible });
      this.updateSelectionHelper();
      this.onModelChange?.(model);
      return;
    }
    const object = this.layerObjects.get(modelId)?.get(nodeId);
    if (!model || !object) return;
    object.visible = visible;
    this.updateSelectionHelper();
    this.updateLayerState(modelId, nodeId, { visible });
    this.updateCollisions(true);
    this.onModelChange?.(model);
  }

  getLayerStates(modelId: string): SceneLayerState[] {
    return [...(this.layerStates.get(modelId)?.values() ?? [])]
      .filter((state) => state.nodeId !== "root")
      .map((state) => structuredClone(state));
  }

  applyLayerStates(modelId: string, states: SceneLayerState[] | undefined): void {
    this.layerStates.get(modelId)?.clear();
    for (const state of states ?? []) {
      const fragmentEntry = this.fragmentLayers.get(modelId)?.get(state.nodeId);
      const fragmentModel = this.fragmentModels.get(modelId);
      if (fragmentEntry && fragmentModel) {
        if (state.name !== undefined) fragmentEntry.node.name = state.name;
        if (state.locked !== undefined) setTreeLock(fragmentEntry.node, state.locked);
        const fragmentColor = state.material?.color ?? state.color;
        if (fragmentColor !== undefined) void fragmentModel.setColor(fragmentEntry.localIds, new THREE.Color(fragmentColor));
        if (state.opacity !== undefined) void fragmentModel.setOpacity(fragmentEntry.localIds, state.opacity);
        const visible = state.deleted ? false : state.visible;
        if (visible !== undefined) {
          setTreeVisibility(fragmentEntry.node, visible);
          void fragmentModel.setVisible(fragmentEntry.localIds, visible);
        }
        this.layerStates.get(modelId)?.set(state.nodeId, structuredClone(state));
        continue;
      }
      const object = this.layerObjects.get(modelId)?.get(state.nodeId);
      if (!object) continue;
      if (state.name !== undefined) object.name = state.name;
      if (state.locked !== undefined) object.userData.layerLocked = state.locked;
      if (state.transform) applyTransform(object, state.transform);
      if (state.opacity !== undefined) this.setObjectOpacity(object, state.opacity);
      if (state.color !== undefined) this.setObjectColor(object, state.color);
      if (state.material !== undefined) this.applyMaterialState(object, state.material);
      if (state.deleted) {
        object.userData.layerDeleted = true;
        object.visible = false;
      } else if (state.visible !== undefined) {
        object.visible = state.visible;
      }
      this.layerStates.get(modelId)?.set(state.nodeId, structuredClone(state));
    }
    this.rebuildComponentIndex(modelId);
  }

  renameSelection(name: string): void {
    const model = this.getSelected();
    const object = this.inspectedObject;
    if (!model) return;
    if (this.selectedFragmentNodeId) {
      const entry = this.fragmentLayers.get(model.id)?.get(this.selectedFragmentNodeId);
      if (!entry) return;
      entry.node.name = name;
      entry.properties.名称 = name;
      this.updateLayerState(model.id, this.selectedFragmentNodeId, { name });
      this.onModelChange?.(model);
      return;
    }
    if (!object) return;
    object.name = name;
    if (object === model.object) model.name = name;
    else this.updateLayerState(model.id, String(object.userData.layerNodeId), { name });
    this.rebuildComponentIndex(model.id);
    this.onModelChange?.(model);
  }

  setSelectionVisible(visible: boolean): void {
    const model = this.getSelected();
    const object = this.inspectedObject;
    if (!model || !object) return;
    if (this.selectedFragmentNodeId) {
      this.setLayerVisible(model.id, this.selectedFragmentNodeId, visible);
      return;
    }
    if (object === model.object) this.setVisible(model.id, visible);
    else this.setLayerVisible(model.id, String(object.userData.layerNodeId), visible);
  }

  setSelectionOpacity(opacity: number): void {
    const model = this.getSelected();
    const object = this.inspectedObject;
    if (!model) return;
    if (this.selectedFragmentNodeId) {
      const entry = this.fragmentLayers.get(model.id)?.get(this.selectedFragmentNodeId);
      const fragmentModel = this.fragmentModels.get(model.id);
      if (!entry || !fragmentModel) return;
      void fragmentModel.setOpacity(entry.localIds, opacity);
      this.updateLayerState(model.id, this.selectedFragmentNodeId, { opacity });
      this.onModelChange?.(model);
      return;
    }
    if (!object) return;
    if (object === model.object) this.setOpacity(model.id, opacity);
    else {
      this.setObjectOpacity(object, opacity);
      this.updateLayerState(model.id, String(object.userData.layerNodeId), { opacity });
      this.onModelChange?.(model);
    }
  }

  getSelectionTransform(): ModelTransform | undefined {
    const object = this.inspectedObject;
    if (!object) return undefined;
    return objectTransform(object);
  }

  applySelectionTransform(transform: ModelTransform): void {
    const model = this.getSelected();
    const object = this.inspectedObject;
    if (!model || !object || this.isSelectionLocked()) return;
    if (this.selectedFragmentNodeId && this.selectedFragmentNodeId !== "root") return;
    applyTransform(object, transform);
    object.updateWorldMatrix(true, true);
    if (object !== model.object) {
      this.updateLayerState(model.id, String(object.userData.layerNodeId), { transform });
    }
    this.updateCollisions(true);
    this.syncFragmentsTransformState(model.id);
    this.onModelChange?.(model);
  }

  deleteSelectedLayer(): boolean {
    const model = this.getSelected();
    const object = this.inspectedObject;
    if (model && this.isSelectionLocked()) return false;
    if (model && this.selectedFragmentNodeId && this.selectedFragmentNodeId !== "root") {
      const nodeId = this.selectedFragmentNodeId;
      const entry = this.fragmentLayers.get(model.id)?.get(nodeId);
      const fragmentModel = this.fragmentModels.get(model.id);
      if (!entry || !fragmentModel) return false;
      entry.node.deleted = true;
      setTreeVisibility(entry.node, false);
      void fragmentModel.setVisible(entry.localIds, false);
      this.updateLayerState(model.id, nodeId, { deleted: true, visible: false });
      this.select(model.id);
      this.onModelChange?.(model);
      return true;
    }
    if (!model || !object || object === model.object) return false;
    const nodeId = String(object.userData.layerNodeId);
    object.userData.layerDeleted = true;
    object.visible = false;
    this.updateLayerState(model.id, nodeId, { deleted: true, visible: false });
    this.rebuildComponentIndex(model.id);
    this.select(model.id);
    this.updateCollisions(true);
    this.onModelChange?.(model);
    return true;
  }

  async loadManifest(manifest: ModelManifest): Promise<LoadedSceneModel> {
    const existing = this.models.get(manifest.modelId);
    if (existing) return existing;
    if (!manifest.geometryUrl || !manifest.viewerKind) throw new Error("模型清单缺少几何数据");
    let object: THREE.Object3D;
    let animations: THREE.AnimationClip[] = [];
    let fragmentsModel: FRAGS.FragmentsModel | undefined;
    if (manifest.viewerKind === "gltf") {
      const [gltf, bimMetadata] = await Promise.all([
        this.gltfLoader.loadAsync(manifest.geometryUrl),
        manifest.propertiesUrl ? loadNativeBimMetadata(manifest.propertiesUrl) : Promise.resolve(undefined)
      ]);
      object = gltf.scene;
      animations = gltf.animations;
      if (bimMetadata) hydrateNativeBimMetadata(object, bimMetadata);
    } else if (manifest.viewerKind === "fbx") {
      object = await this.fbxLoader.loadAsync(manifest.geometryUrl);
      animations = object.animations;
    } else if (manifest.viewerKind === "ifc") {
      const response = await fetch(manifest.geometryUrl);
      if (!response.ok) throw new Error(`IFC 下载失败：${response.status}`);
      const fragmentsBytes = await this.importer.process({ bytes: new Uint8Array(await response.arrayBuffer()) });
      const model = await this.fragments.core.load(fragmentsBytes, { modelId: manifest.modelId });
      model.useCamera(this.camera);
      if (this.rendererBackend === "webgpu") await model.setLodMode(FRAGS.LodMode.ALL_GEOMETRY);
      fragmentsModel = model;
      object = model.object;
    } else if (manifest.viewerKind === "fragments") {
      const response = await fetch(manifest.geometryUrl);
      const model = await this.fragments.core.load(await response.arrayBuffer(), { modelId: manifest.modelId });
      model.useCamera(this.camera);
      if (this.rendererBackend === "webgpu") await model.setLodMode(FRAGS.LodMode.ALL_GEOMETRY);
      fragmentsModel = model;
      object = model.object;
    } else {
      object = await this.loadDxf(manifest.geometryUrl);
    }
    const loaded = this.registerObject(manifest.modelId, manifest.sourceName, object, "model");
    if (fragmentsModel) await this.registerFragmentsModel(manifest.modelId, fragmentsModel, manifest.sourceName);
    if (animations.length > 0) {
      const mixer = new THREE.AnimationMixer(object);
      animations.forEach((clip) => mixer.clipAction(clip).play());
      this.mixers.set(manifest.modelId, mixer);
      this.animationEnabledIds.add(manifest.modelId);
    }
    this.fitAll();
    return loaded;
  }

  createBox(id: string, name: string, color = "#d9a441"): LoadedSceneModel {
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.05 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = 1;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const loaded = this.registerObject(id, name, mesh, "primitive");
    this.select(id);
    return loaded;
  }

  removeModel(id: string): void {
    const model = this.models.get(id);
    if (!model) return;
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
      this.animationEnabledIds.delete(id);
    }
    model.object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      materials.forEach((material) => material.dispose());
    });
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
    this.onModelChange?.(model);
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnlyMode = readOnly;
    if (readOnly) {
      this.setMeasureEnabled(false);
      this.setAnnotationPlacementEnabled(false);
    }
    this.updateTransformAccess();
  }

  clearSceneModels(): void {
    for (const id of [...this.models.keys()]) this.removeModel(id);
    this.clearMeasurements();
    this.clearAnnotations();
    this.measurementPoints.length = 0;
    this.measurementTargets.length = 0;
    this.onMeasurementDraftChange?.(false);
  }

  select(id: string | undefined): void {
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
    const fragmentEntry = this.fragmentLayers.get(id)?.get("root");
    const fragmentModel = this.fragmentModels.get(id);
    if (fragmentEntry && fragmentModel) {
      setTreeVisibility(fragmentEntry.node, visible);
      void fragmentModel.setVisible(fragmentEntry.localIds, visible).then(() => this.fragments.core.update(true));
    }
    this.updateCollisions(true);
    this.onModelChange?.(model);
  }

  setOpacity(id: string, opacity: number): void {
    const model = this.models.get(id);
    if (!model) return;
    model.opacity = opacity;
    const fragmentEntry = this.fragmentLayers.get(id)?.get("root");
    const fragmentModel = this.fragmentModels.get(id);
    if (fragmentEntry && fragmentModel) void fragmentModel.setOpacity(fragmentEntry.localIds, opacity);
    model.object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      const materials = this.materialsForMesh(mesh);
      for (const material of materials) {
        material.transparent = opacity < 0.999;
        material.opacity = opacity;
        material.depthWrite = opacity >= 0.999;
        material.needsUpdate = true;
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
        new THREE.Plane(new THREE.Vector3(0, 0, -1), max.z)
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
    const normal = new THREE.Vector3(
      state.axis === "x" ? direction : 0,
      state.axis === "y" ? direction : 0,
      state.axis === "z" ? direction : 0
    );
    this.setRendererClippingPlanes([new THREE.Plane(normal, -state.offset * direction)]);
    this.updateToolCursor();
  }

  private setRendererClippingPlanes(planes: THREE.Plane[]): void {
    if (this.rendererBackend === "webgpu") {
      const clippingRoot = this.modelRoot as ClippingGroup;
      clippingRoot.clippingPlanes = planes;
      clippingRoot.enabled = planes.length > 0;
      return;
    }
    (this.renderer as THREE.WebGLRenderer).clippingPlanes = planes;
  }

  private visibleSceneBox(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const model of this.models.values()) if (model.visible) box.union(visibleObjectBox(model.object));
    return box;
  }

  private disposeClippingHelper(): void {
    if (!this.clippingHelper) return;
    this.disposeObject(this.clippingHelper);
    this.clippingHelper = undefined;
  }

  private updateToolCursor(): void {
    const pickingFace = this.clippingState.enabled && this.clippingState.mode === "face" && !this.clippingState.face;
    this.renderer.domElement.style.cursor = this.measureEnabled || this.annotationPlacementEnabled || pickingFace ? "crosshair" : "default";
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

  private frameScene(): void {
    const box = new THREE.Box3();
    for (const model of this.models.values()) if (model.visible) box.expandByObject(model.object);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = Math.max(box.getSize(new THREE.Vector3()).length(), 2);
    this.orbit.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(0.8, 0.55, 0.8).normalize().multiplyScalar(size));
    this.camera.near = Math.max(size / 10_000, 0.01);
    this.camera.far = Math.max(size * 100, 10_000);
    this.camera.updateProjectionMatrix();
    this.orbit.update();
  }

  getCameraState(): CameraState {
    const view = this.captureNavigationState(this.navigationMode);
    return {
      position: toValue(view.position),
      target: toValue(view.target),
      mode: this.navigationMode,
      avatarVisible: this.avatarVisible
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
    this.emitCameraChange(true);
  }

  setStandardView(view: StandardView): void {
    if (this.navigationMode !== "orbit") this.setNavigationMode("orbit");
    const selected = this.getSelected();
    const targetObject = this.inspectedObject && this.inspectedObject !== selected?.object ? this.inspectedObject : undefined;
    const box = targetObject ? new THREE.Box3().setFromObject(targetObject) : this.sceneContentBox();
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const distance = Math.max(box.getSize(new THREE.Vector3()).length() * 1.25, 3);
    const directions: Record<StandardView, THREE.Vector3> = {
      top: new THREE.Vector3(0, 1, 0),
      bottom: new THREE.Vector3(0, -1, 0),
      left: new THREE.Vector3(-1, 0, 0),
      right: new THREE.Vector3(1, 0, 0),
      front: new THREE.Vector3(0, 0, 1),
      back: new THREE.Vector3(0, 0, -1)
    };
    this.camera.up.set(0, 1, 0);
    if (view === "top") this.camera.up.set(0, 0, -1);
    if (view === "bottom") this.camera.up.set(0, 0, 1);
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(directions[view], distance);
    this.orbit.update();
    this.rememberNavigationState("orbit");
    this.emitCameraChange(true);
  }

  getModelTransform(id: string): ModelTransform | undefined {
    const object = this.models.get(id)?.object;
    if (!object) return undefined;
    return objectTransform(object);
  }

  applyModelState(id: string, state: { visible: boolean; locked?: boolean; opacity: number; color?: string; colorOverride?: string; material?: SceneMaterialState; transform: ModelTransform; collisionEnabled?: boolean; explosionFactor?: number; explosionMode?: ExplosionMode; animationEnabled?: boolean; layers?: SceneLayerState[] }): void {
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
    if (this.hasAnimation(id)) this.setAnimationEnabled(id, state.animationEnabled ?? true);
    model.object.updateWorldMatrix(true, true);
    this.syncFragmentsTransformState(id);
  }

  primitiveState(id: string, color: string): PrimitiveState | undefined {
    const model = this.models.get(id);
    const transform = this.getModelTransform(id);
    if (!model || model.kind !== "primitive" || !transform) return undefined;
    return {
      modelId: id,
      name: model.name,
      kind: "box",
      color: this.getModelColor(id) || color,
      visible: model.visible,
      locked: this.isModelLocked(id),
      opacity: model.opacity,
      transform,
      collisionEnabled: this.isCollisionEnabled(id),
      explosionFactor: this.getExplosionFactor(id)
      ,material: this.getMaterialState(model.object)
    };
  }

  addMeasurementVisual(measurement: MeasurementState): void {
    const group = this.createMeasurementGroup(measurement, false);
    group.name = `measurement:${measurement.id}`;
    group.userData.measurement = measurement;
    this.scene.add(group);
  }

  clearMeasurements(): void {
    const objects = this.scene.children.filter((child) => child.name.startsWith("measurement:"));
    for (const object of objects) this.disposeObject(object);
  }

  deleteMeasurement(id: string): void {
    const object = this.scene.getObjectByName(`measurement:${id}`);
    if (object) this.disposeObject(object);
  }

  focusMeasurement(measurement: MeasurementState): void {
    const points = measurement.points?.length ? measurement.points : [measurement.start, measurement.end];
    const box = new THREE.Box3().setFromPoints(points.map((point) => new THREE.Vector3(point.x, point.y, point.z)));
    const center = box.getCenter(new THREE.Vector3());
    const size = Math.max(box.getSize(new THREE.Vector3()).length(), 1);
    this.orbit.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(1, 0.75, 1).normalize().multiplyScalar(size * 2.3));
    this.orbit.update();
  }

  dispose(): void {
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    this.renderer.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.removeEventListener("pointermove", this.handlePointerMove);
    this.renderer.domElement.removeEventListener("pointerleave", this.handlePointerLeave);
    this.renderer.domElement.removeEventListener("contextmenu", this.preventContextMenu);
    this.orbit.dispose();
    this.pointer.disconnect();
    this.transform.dispose();
    this.dracoLoader.dispose();
    this.clearSceneModels();
    this.collisionMaterial.dispose();
    this.disposeWeatherEffect();
    this.skyboxTextures.forEach((texture) => texture.dispose());
    this.skyboxTextures.clear();
    this.externalEnvironmentTexture?.dispose();
    this.disposeClippingHelper();
    if (this.cameraPathHelper) this.disposeObject(this.cameraPathHelper);
    this.removeSelectionHelper();
    this.clearAnnotations(false);
    for (const visual of this.spaceVisuals.values()) this.disposeObject(visual.object);
    this.spaceVisuals.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private sceneContentBox(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const model of this.models.values()) if (model.visible) box.union(visibleObjectBox(model.object));
    return box;
  }

  private updateTransformAccess(): void {
    const object = this.inspectedObject;
    const editable = Boolean(
      object
      && !this.readOnlyMode
      && this.navigationMode === "orbit"
      && !this.sceneAnimationPlaying
      && !this.selectedFragmentNodeId
      && !this.isSelectionLocked()
    );
    this.transform.enabled = editable;
    if (editable && object) this.transform.attach(object);
    else this.transform.detach();
    this.transform.getHelper().visible = editable;
  }

  private syncFragmentsTransformState(modelId: string, activelyTransforming = false): void {
    const fragmentsModel = this.fragmentModels.get(modelId);
    const object = this.models.get(modelId)?.object;
    if (!fragmentsModel || !object) return;
    const transformed = activelyTransforming
      || object.position.lengthSq() > 1e-10
      || Math.abs(object.quaternion.x) > 1e-7
      || Math.abs(object.quaternion.y) > 1e-7
      || Math.abs(object.quaternion.z) > 1e-7
      || Math.abs(object.quaternion.w - 1) > 1e-7
      || Math.abs(object.scale.x - 1) > 1e-7
      || Math.abs(object.scale.y - 1) > 1e-7
      || Math.abs(object.scale.z - 1) > 1e-7;
    fragmentsModel.frozen = transformed;
    if (!transformed) void this.fragments.core.update(true);
  }

  private updateSelectionHelper(): void {
    this.removeSelectionHelper();
    const selected = this.getSelected();
    const object = this.inspectedObject;
    if (!selected || !object || object === selected.object || !object.visible) return;
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    this.selectionHelper = new THREE.Box3Helper(box, 0x2684ff);
    this.selectionHelper.name = "helper:selection";
    this.selectionHelper.renderOrder = 999;
    const material = this.selectionHelper.material as THREE.LineBasicMaterial;
    material.depthTest = false;
    material.transparent = true;
    material.opacity = 0.95;
    this.scene.add(this.selectionHelper);
  }

  private removeSelectionHelper(): void {
    if (!this.selectionHelper) return;
    this.scene.remove(this.selectionHelper);
    this.selectionHelper.geometry.dispose();
    (this.selectionHelper.material as THREE.Material).dispose();
    this.selectionHelper = undefined;
  }

  private emitCameraChange(force = false): void {
    if (!this.onCameraChange) return;
    const state = this.getCameraState();
    const signature = `${state.position.x.toFixed(4)}:${state.position.y.toFixed(4)}:${state.position.z.toFixed(4)}:${state.target.x.toFixed(4)}:${state.target.y.toFixed(4)}:${state.target.z.toFixed(4)}:${state.mode}`;
    if (!force && signature === this.lastCameraSignature) return;
    this.lastCameraSignature = signature;
    this.onCameraChange(state);
  }

  private registerObject(id: string, name: string, object: THREE.Object3D, kind: LoadedSceneModel["kind"]): LoadedSceneModel {
    object.name = name;
    object.userData.modelId = id;
    const objects = new Map<string, THREE.Object3D>();
    const indexObject = (child: THREE.Object3D, nodeId: string): void => {
      child.userData.modelId = id;
      const elementId = scalarText(child.userData.ElementId);
      const preferredId = elementId && child.userData.NodeType === "Element" ? `element:${elementId}` : nodeId;
      const stableNodeId = objects.has(preferredId) ? nodeId : preferredId;
      child.userData.layerNodeId = stableNodeId;
      objects.set(stableNodeId, child);
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
      child.children.forEach((nested, index) => indexObject(nested, `${nodeId}/${index}`));
    };
    indexObject(object, "root");
    this.modelRoot.add(object);
    const loaded = { id, name, object, kind, visible: true, opacity: 1 } satisfies LoadedSceneModel;
    this.models.set(id, loaded);
    this.layerObjects.set(id, objects);
    this.layerStates.set(id, new Map());
    this.rebuildComponentIndex(id);
    return loaded;
  }

  private async registerFragmentsModel(modelId: string, fragmentsModel: FRAGS.FragmentsModel, sourceName: string): Promise<void> {
    this.fragmentModels.set(modelId, fragmentsModel);
    const spatial = await fragmentsModel.getSpatialStructure();
    const localIds = [...collectSpatialLocalIds(spatial)];
    const itemData = new Map<number, FRAGS.ItemData>();

    const entries = new Map<string, FragmentLayerEntry>();
    const idsByLocalId = new Map<number, string>();
    const build = (item: FRAGS.SpatialTreeItem, path: string, isRoot = false): FragmentLayerEntry => {
      const ownId = item.localId ?? undefined;
      const properties = ownId === undefined ? {} : fragmentItemProperties(itemData.get(ownId));
      const nodeId = isRoot ? "root" : ownId === undefined ? `ifc-group:${path}` : `ifc:${ownId}`;
      const childrenEntries = (item.children ?? []).map((child, index) => build(child, `${path}/${index}`));
      const localIdsForNode = ownId === undefined
        ? [...new Set(childrenEntries.flatMap((child) => child.localIds))]
        : [...new Set([ownId, ...childrenEntries.flatMap((child) => child.localIds)])];
      const fallback = isRoot ? sourceName : humanizeIfcCategory(item.category) || `构件 ${ownId ?? path}`;
      const name = fragmentPropertyValue(properties, ["Name", "LongName", "ObjectType", "名称"]) || fallback;
      const node: LayerTreeNode = {
        id: nodeId,
        modelId,
        name,
        type: item.category || (isRoot ? "IFC 模型" : "IFC 分组"),
        visible: true,
        locked: false,
        deleted: false,
        children: childrenEntries.map((child) => child.node)
      };
      const entry = { node, localIds: localIdsForNode, ...(ownId === undefined ? {} : { localId: ownId }), properties };
      entries.set(nodeId, entry);
      if (ownId !== undefined) idsByLocalId.set(ownId, nodeId);
      return entry;
    };

    const root = build(spatial, "0", true);
    this.fragmentLayers.set(modelId, entries);
    this.fragmentTrees.set(modelId, root.node);
    this.fragmentNodeIdsByLocalId.set(modelId, idsByLocalId);
    this.rebuildComponentIndex(modelId);
    this.onModelChange?.(this.models.get(modelId)!);
    void this.hydrateFragmentProperties(modelId, fragmentsModel, localIds);
  }

  private async hydrateFragmentProperties(modelId: string, fragmentsModel: FRAGS.FragmentsModel, localIds: number[]): Promise<void> {
    for (let offset = 0; offset < localIds.length; offset += 300) {
      if (this.fragmentModels.get(modelId) !== fragmentsModel) return;
      const ids = localIds.slice(offset, offset + 300);
      const values = await fragmentsModel.getItemsData(ids);
      ids.forEach((localId, index) => {
        const nodeId = this.fragmentNodeIdsByLocalId.get(modelId)?.get(localId);
        const entry = nodeId ? this.fragmentLayers.get(modelId)?.get(nodeId) : undefined;
        const value = values[index];
        if (!entry || !value) return;
        entry.properties = fragmentItemProperties(value);
        const name = fragmentPropertyValue(entry.properties, ["Name", "LongName", "ObjectType", "名称"]);
        if (name) entry.node.name = name;
      });
      this.rebuildComponentIndex(modelId);
      const model = this.models.get(modelId);
      if (model) this.onModelChange?.(model);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }

  private ensureFragmentEntry(modelId: string, localId: number): string | undefined {
    const entries = this.fragmentLayers.get(modelId);
    const root = this.fragmentTrees.get(modelId);
    if (!entries || !root) return undefined;
    const nodeId = `ifc:${localId}`;
    const existing = entries.get(nodeId);
    if (existing) {
      this.fragmentNodeIdsByLocalId.get(modelId)?.set(localId, nodeId);
      return nodeId;
    }
    const node: LayerTreeNode = {
      id: nodeId,
      modelId,
      name: `构件 ${localId}`,
      type: "IFC 构件",
      visible: true,
      locked: false,
      deleted: false,
      children: []
    };
    root.children.push(node);
    entries.set(nodeId, { node, localIds: [localId], localId, properties: { LocalId: String(localId) } });
    this.fragmentNodeIdsByLocalId.get(modelId)?.set(localId, nodeId);
    this.rebuildComponentIndex(modelId);
    const model = this.models.get(modelId);
    if (model) this.onModelChange?.(model);
    const fragmentsModel = this.fragmentModels.get(modelId);
    if (fragmentsModel) {
      void fragmentsModel.getItemsData([localId]).then(([data]) => {
        const entry = this.fragmentLayers.get(modelId)?.get(nodeId);
        if (!entry || !data) return;
        entry.properties = fragmentItemProperties(data);
        const name = fragmentPropertyValue(entry.properties, ["Name", "LongName", "ObjectType", "名称"]);
        const category = fragmentPropertyValue(entry.properties, ["Category", "category", "类型"]);
        if (name) entry.node.name = name;
        if (category) entry.node.type = category;
        this.rebuildComponentIndex(modelId);
        if (model) this.onModelChange?.(model);
      });
    }
    return nodeId;
  }

  private async highlightFragmentSelection(fragmentModel: FRAGS.FragmentsModel, entry: FragmentLayerEntry): Promise<void> {
    const version = ++this.fragmentSelectionVersion;
    await fragmentModel.resetHighlight();
    if (version !== this.fragmentSelectionVersion || this.selectedFragmentNodeId !== entry.node.id) return;
    await fragmentModel.highlight(entry.localIds, {
      color: new THREE.Color(0x2684ff),
      renderedFaces: FRAGS.RenderedFaces.TWO,
      opacity: 0.42,
      transparent: true,
      preserveOriginalMaterial: true,
      depthTest: true,
      depthWrite: false,
      customId: "bim-studio-selection"
    });
    const box = await fragmentModel.getMergedBox(entry.localIds);
    if (version !== this.fragmentSelectionVersion || this.selectedFragmentNodeId !== entry.node.id) return;
    this.showSelectionBox(box);
    void this.fragments.core.update(true);
  }

  private focusBox(box: THREE.Box3): boolean {
    if (!isFiniteBox(box) || box.isEmpty()) return false;
    const center = box.getCenter(new THREE.Vector3());
    const dimensions = box.getSize(new THREE.Vector3());
    const radius = Math.max(dimensions.length() * 0.5, 0.5);
    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov * 0.5) * Math.max(this.camera.aspect, 0.1));
    const limitingFov = Math.max(Math.min(verticalFov, horizontalFov), THREE.MathUtils.degToRad(10));
    const distance = Math.max(radius / Math.sin(limitingFov * 0.5) * 1.18, 2);
    this.camera.up.set(0, 1, 0);
    this.orbit.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(1, 0.72, 1).normalize().multiplyScalar(distance));
    this.camera.near = Math.max(radius / 10_000, 0.01);
    this.camera.far = Math.max(distance + radius * 100, 10_000);
    this.camera.updateProjectionMatrix();
    this.orbit.update();
    this.emitCameraChange(true);
    return true;
  }

  private prepareForFocusedView(): void {
    if (this.sceneAnimationPlaying) this.pauseSceneAnimation();
    if (this.navigationMode !== "orbit") this.setNavigationMode("orbit");
    this.camera.up.set(0, 1, 0);
    this.orbit.minDistance = 0;
    this.orbit.maxDistance = Infinity;
    this.orbit.maxPolarAngle = Math.PI;
  }

  private syncSpaceVisuals(): void {
    for (const visual of this.spaceVisuals.values()) {
      const model = this.models.get(visual.modelId);
      if (!model) continue;
      model.object.updateWorldMatrix(true, false);
      visual.object.matrix.copy(model.object.matrixWorld);
      visual.object.matrixWorldNeedsUpdate = true;
      visual.object.visible = model.visible && model.object.visible;
    }
  }

  private showSelectionBox(box: THREE.Box3): void {
    this.removeSelectionHelper();
    if (box.isEmpty()) return;
    this.selectionHelper = new THREE.Box3Helper(box, 0x2684ff);
    this.selectionHelper.name = "helper:selection";
    this.selectionHelper.renderOrder = 999;
    const material = this.selectionHelper.material as THREE.LineBasicMaterial;
    material.depthTest = false;
    material.transparent = true;
    material.opacity = 0.95;
    this.scene.add(this.selectionHelper);
  }

  private async loadDxf(url: string): Promise<THREE.Group> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`DXF 下载失败：${response.status}`);
    const document = new DxfParser().parseSync(await response.text()) as DxfDocument | null;
    if (!document) throw new Error("DXF 内容无效");
    const root = new THREE.Group();
    const group = new THREE.Group();
    group.name = "CAD 图纸";
    root.add(group);
    const layerGroups = new Map<string, THREE.Group>();
    const modelExtents = dxfDrawingExtents(document.header);
    for (const entity of document.entities ?? []) {
      const points = dxfPoints(entity);
      if (points.length < 2) continue;
      if (modelExtents && !pointsIntersectExtents(points, modelExtents)) continue;
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const closed = entity.type === "LWPOLYLINE" && points.length > 2;
      const layerName = entity.layer?.trim() || "默认图层";
      let layer = layerGroups.get(layerName);
      if (!layer) {
        layer = new THREE.Group();
        layer.name = layerName;
        layer.userData.layer = layerName;
        layerGroups.set(layerName, layer);
        group.add(layer);
      }
      const material = new THREE.LineBasicMaterial({ color: 0xd9dee5 });
      const line = closed ? new THREE.LineLoop(geometry, material) : new THREE.Line(geometry, material);
      line.name = `${entity.type ?? "实体"} ${layer.children.length + 1}`;
      layer.add(line);
    }
    const unitScale = dxfUnitScale(document.header?.["$INSUNITS"]);
    group.rotation.x = -Math.PI / 2;
    group.scale.setScalar(unitScale);
    group.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3().setFromObject(group);
    if (!bounds.isEmpty()) {
      const center = bounds.getCenter(new THREE.Vector3());
      group.position.sub(center);
      root.userData.CadOriginalCenter = { x: center.x, y: center.y, z: center.z };
      root.userData.CadUnitScale = unitScale;
      root.userData.CadSourceUnits = dxfUnitName(document.header?.["$INSUNITS"]);
    }
    return root;
  }

  private setupEnvironment(): void {
    this.syncSceneLights();
    this.gridHelper = new THREE.GridHelper(200, 200, 0xa8b2b9, 0x7b858d);
    this.gridHelper.name = "helper:grid";
    const gridMaterials = Array.isArray(this.gridHelper.material) ? this.gridHelper.material : [this.gridHelper.material];
    gridMaterials.forEach((material) => {
      material.transparent = true;
      material.opacity = 0.22;
      material.depthWrite = false;
    });
    this.scene.add(this.gridHelper);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.ShadowMaterial({ opacity: 0.12 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.name = "helper:ground";
    this.scene.add(ground);
    this.setSceneEnvironment(this.environmentState);
    this.setWeather("sunny");
  }

  private async applyEnvironment(): Promise<void> {
    const preset = this.environmentState.skybox;
    let environment: THREE.Texture | undefined;
    if (this.environmentState.environmentMapUrl) {
      try {
        environment = await this.loadEnvironmentTexture(this.environmentState.environmentMapUrl);
        if (this.externalEnvironmentTexture && this.externalEnvironmentTexture !== environment) this.externalEnvironmentTexture.dispose();
        this.externalEnvironmentTexture = environment;
      } catch {
        environment = undefined;
      }
    }
    const sky = preset === "none" ? undefined : this.getSkyboxTexture(preset);
    this.scene.environment = this.lightingState.reflectionsEnabled === false ? null : environment ?? sky ?? null;
    this.scene.environmentIntensity = this.environmentState.environmentIntensity ?? 1;
    this.scene.background = this.environmentState.environmentAsBackground && environment
      ? environment
      : sky ?? new THREE.Color(this.environmentState.backgroundColor);
  }

  private async loadEnvironmentTexture(url: string): Promise<THREE.Texture> {
    const path = url.split(/[?#]/)[0]?.toLowerCase() ?? "";
    const texture = path.endsWith(".hdr")
      ? await new RGBELoader().loadAsync(url)
      : path.endsWith(".exr")
        ? await new EXRLoader().loadAsync(url)
        : await new THREE.TextureLoader().loadAsync(url);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    if (!path.endsWith(".hdr") && !path.endsWith(".exr")) texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  private getSkyboxTexture(preset: Exclude<SkyboxPreset, "none">): THREE.CanvasTexture {
    const cached = this.skyboxTextures.get(preset);
    if (cached) return cached;
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 512;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建天空盒画布");

    const palettes = {
      clear: ["#4e88b5", "#a6d2e8", "#e7eef0"],
      sunset: ["#342b55", "#d27b72", "#f3c78f"],
      night: ["#050a18", "#101d3b", "#26385b"]
    } as const;
    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, palettes[preset][0]);
    gradient.addColorStop(0.52, palettes[preset][1]);
    gradient.addColorStop(1, palettes[preset][2]);
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    if (preset === "clear") {
      context.fillStyle = "rgba(255,255,255,.17)";
      for (const [x, y, width] of [[120, 270, 240], [520, 235, 310], [830, 290, 180]] as const) {
        context.beginPath();
        context.ellipse(x, y, width, 18, 0, 0, Math.PI * 2);
        context.fill();
      }
    } else if (preset === "sunset") {
      const sun = context.createRadialGradient(730, 285, 5, 730, 285, 95);
      sun.addColorStop(0, "rgba(255,244,190,.96)");
      sun.addColorStop(0.2, "rgba(255,205,126,.72)");
      sun.addColorStop(1, "rgba(255,150,90,0)");
      context.fillStyle = sun;
      context.fillRect(620, 175, 220, 220);
    } else {
      let seed = 2463534242;
      for (let index = 0; index < 180; index += 1) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const x = seed % canvas.width;
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const y = seed % 340;
        const radius = index % 17 === 0 ? 1.4 : 0.7;
        context.fillStyle = index % 11 === 0 ? "rgba(190,215,255,.95)" : "rgba(255,255,255,.72)";
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.needsUpdate = true;
    this.skyboxTextures.set(preset, texture);
    return texture;
  }

  private applyLighting(): void {
    const weatherFactor = this.weatherMode === "sunny" ? 1 : this.weatherMode === "rain" ? 0.58 : 0.78;
    const intensity = this.lightingState.enabled ? this.lightingState.intensity : 0;
    for (const state of this.lightingState.lights ?? DEFAULT_SCENE_LIGHTS) {
      const light = this.sceneLights.get(state.id);
      if (!light) continue;
      light.visible = this.lightingState.enabled && state.enabled;
      light.intensity = state.intensity * weatherFactor * intensity;
      if ("castShadow" in light) light.castShadow = Boolean(this.lightingState.shadowsEnabled && state.castShadow);
    }
    if ("shadowMap" in this.renderer) this.renderer.shadowMap.enabled = Boolean(this.lightingState.shadowsEnabled);
    this.renderer.toneMappingExposure = this.lightingState.enabled
      ? THREE.MathUtils.clamp(0.72 + intensity * weatherFactor * 0.33, 0.55, 1.55)
      : 0.55;
  }

  private syncSceneLights(): void {
    for (const light of this.sceneLights.values()) {
      if (light.parent) light.parent.remove(light);
    }
    for (const target of this.scene.children.filter((child) => child.name.startsWith("scene-light-target:"))) this.scene.remove(target);
    this.sceneLights.clear();
    for (const state of this.lightingState.lights ?? DEFAULT_SCENE_LIGHTS) {
      const color = new THREE.Color(state.color);
      let light: THREE.Light;
      if (state.type === "ambient") light = new THREE.AmbientLight(color, state.intensity);
      else if (state.type === "hemisphere") light = new THREE.HemisphereLight(color, new THREE.Color(state.groundColor ?? "#3b4249"), state.intensity);
      else if (state.type === "point") light = new THREE.PointLight(color, state.intensity, state.distance ?? 0, state.decay ?? 2);
      else if (state.type === "spot") {
        const spot = new THREE.SpotLight(color, state.intensity, state.distance ?? 0, state.angle ?? Math.PI / 6, state.penumbra ?? 0.25, state.decay ?? 2);
        spot.target.name = `scene-light-target:${state.id}`;
        spot.target.position.set(state.target?.x ?? 0, state.target?.y ?? 0, state.target?.z ?? 0);
        this.scene.add(spot.target);
        light = spot;
      } else if (state.type === "rectArea") {
        const area = new THREE.RectAreaLight(color, state.intensity, state.width ?? 6, state.height ?? 4);
        light = area;
      } else {
        const directional = new THREE.DirectionalLight(color, state.intensity);
        directional.target.name = `scene-light-target:${state.id}`;
        directional.target.position.set(state.target?.x ?? 0, state.target?.y ?? 0, state.target?.z ?? 0);
        directional.shadow.mapSize.set(2048, 2048);
        directional.shadow.camera.near = 0.1;
        directional.shadow.camera.far = 300;
        this.scene.add(directional.target);
        light = directional;
      }
      light.name = `scene-light:${state.id}`;
      light.position.set(state.position?.x ?? 0, state.position?.y ?? 6, state.position?.z ?? 0);
      if (state.type === "rectArea") light.lookAt(state.target?.x ?? 0, state.target?.y ?? 0, state.target?.z ?? 0);
      light.visible = state.enabled;
      if ("castShadow" in light) light.castShadow = Boolean(state.castShadow);
      this.sceneLights.set(state.id, light);
      this.scene.add(light);
    }
  }

  private createRainEffect(): THREE.LineSegments {
    const count = 750;
    const positions = new Float32Array(count * 6);
    const speeds = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      const offset = index * 6;
      const x = THREE.MathUtils.randFloatSpread(42);
      const y = THREE.MathUtils.randFloat(-14, 22);
      const z = THREE.MathUtils.randFloatSpread(42);
      positions.set([x, y, z, x - 0.06, y - THREE.MathUtils.randFloat(0.7, 1.5), z + 0.04], offset);
      speeds[index] = THREE.MathUtils.randFloat(18, 30);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const effect = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: 0xa8d8f2, transparent: true, opacity: 0.55, depthWrite: false })
    );
    effect.name = "helper:weather-rain";
    effect.frustumCulled = false;
    effect.userData.speeds = speeds;
    return effect;
  }

  private createSnowEffect(): THREE.Points {
    const count = 950;
    const positions = new Float32Array(count * 3);
    const speeds = new Float32Array(count);
    const drift = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      positions.set([THREE.MathUtils.randFloatSpread(44), THREE.MathUtils.randFloat(-14, 22), THREE.MathUtils.randFloatSpread(44)], index * 3);
      speeds[index] = THREE.MathUtils.randFloat(1.2, 3.2);
      drift[index] = THREE.MathUtils.randFloat(0.2, 0.8);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const effect = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({ color: 0xffffff, size: 0.075, transparent: true, opacity: 0.82, depthWrite: false })
    );
    effect.name = "helper:weather-snow";
    effect.frustumCulled = false;
    effect.userData.speeds = speeds;
    effect.userData.drift = drift;
    return effect;
  }

  private updateWeather(delta: number): void {
    const effect = this.weatherEffect;
    if (!effect) return;
    effect.position.copy(this.camera.position);
    const attribute = effect.geometry.getAttribute("position") as THREE.BufferAttribute;
    const positions = attribute.array as Float32Array;
    const speeds = effect.userData.speeds as Float32Array;
    if (effect instanceof THREE.LineSegments) {
      for (let index = 0; index < speeds.length; index += 1) {
        const offset = index * 6;
        const fall = speeds[index]! * delta;
        positions[offset + 1]! -= fall;
        positions[offset + 4]! -= fall;
        if (positions[offset + 4]! < -16) {
          const height = THREE.MathUtils.randFloat(32, 40);
          positions[offset + 1]! += height;
          positions[offset + 4]! += height;
        }
      }
    } else {
      const drift = effect.userData.drift as Float32Array;
      const time = performance.now() * 0.001;
      for (let index = 0; index < speeds.length; index += 1) {
        const offset = index * 3;
        positions[offset]! += Math.sin(time + index) * drift[index]! * delta;
        positions[offset + 1]! -= speeds[index]! * delta;
        if (positions[offset + 1]! < -16) positions[offset + 1]! += THREE.MathUtils.randFloat(32, 40);
      }
    }
    attribute.needsUpdate = true;
  }

  private disposeWeatherEffect(): void {
    if (!this.weatherEffect) return;
    this.scene.remove(this.weatherEffect);
    this.weatherEffect.geometry.dispose();
    const material = this.weatherEffect.material;
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else material.dispose();
    this.weatherEffect = undefined;
  }

  private applySceneAnimationFrame(time: number): void {
    const camera = sampleCameraKeyframes(this.sceneAnimation.camera, time, this.sceneAnimation.cameraInterpolation ?? "smooth");
    if (camera) {
      this.camera.position.set(camera.position.x, camera.position.y, camera.position.z);
      this.orbit.target.set(camera.target.x, camera.target.y, camera.target.z);
      this.avatarVisible = camera.avatarVisible ?? this.avatarVisible;
      if (this.avatar) this.avatar.visible = this.navigationMode === "thirdPerson" && this.avatarVisible;
      this.orbit.update();
    }
    const byModel = new Map<string, typeof this.sceneAnimation.models>();
    for (const frame of this.sceneAnimation.models) {
      const frames = byModel.get(frame.modelId) ?? [];
      frames.push(frame);
      byModel.set(frame.modelId, frames);
    }
    for (const [modelId, frames] of byModel) {
      const transform = sampleModelKeyframes(frames, time);
      const model = this.models.get(modelId);
      if (transform && model) applyTransform(model.object, transform);
    }
    this.updateSelectionHelper();
    this.updateCollisions(false);
    void this.fragments.core.update();
    this.emitCameraChange();
  }

  private updateCameraPathHelper(): void {
    if (this.cameraPathHelper) {
      this.disposeObject(this.cameraPathHelper);
      this.cameraPathHelper = undefined;
    }
    if (!this.sceneAnimation.showCameraPath || this.sceneAnimation.camera.length < 2) return;
    const group = new THREE.Group();
    group.name = "helper:camera-path";
    const sampleCount = Math.min(Math.max(this.sceneAnimation.camera.length * 24, 48), 240);
    const points: THREE.Vector3[] = [];
    for (let index = 0; index <= sampleCount; index += 1) {
      const time = this.sceneAnimation.duration * index / sampleCount;
      const state = sampleCameraKeyframes(this.sceneAnimation.camera, time, this.sceneAnimation.cameraInterpolation ?? "smooth");
      if (state) points.push(new THREE.Vector3(state.position.x, state.position.y, state.position.z));
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: 0x66b7ff, transparent: true, opacity: 0.8, depthTest: false })
    );
    line.renderOrder = 18;
    group.add(line);
    for (const frame of this.sceneAnimation.camera) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xf6c453, depthTest: false })
      );
      marker.position.set(frame.camera.position.x, frame.camera.position.y, frame.camera.position.z);
      marker.renderOrder = 19;
      group.add(marker);
    }
    this.cameraPathHelper = group;
    this.scene.add(group);
  }

  private resize(): void {
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private animate = (): void => {
    if (!this.xrActive) this.animationFrame = requestAnimationFrame(this.animate);
    const now = performance.now();
    this.frameSampleCount += 1;
    const frameSampleElapsed = now - this.frameSampleStartedAt;
    if (frameSampleElapsed >= 500) {
      this.frameRate = this.frameSampleCount * 1000 / frameSampleElapsed;
      this.frameSampleCount = 0;
      this.frameSampleStartedAt = now;
    }
    const delta = Math.min((now - this.lastFrameTime) / 1000, 0.05);
    this.lastFrameTime = now;
    this.mixers.forEach((mixer) => mixer.update(delta));
    if (this.sceneAnimationPlaying) {
      const speed = this.sceneAnimation.playbackSpeed ?? 1;
      this.sceneAnimationTime += delta * speed * this.sceneAnimationDirection;
      if (this.sceneAnimationTime >= this.sceneAnimation.duration || this.sceneAnimationTime <= 0) {
        if (this.sceneAnimation.pingPong) {
          this.sceneAnimationTime = THREE.MathUtils.clamp(this.sceneAnimationTime, 0, this.sceneAnimation.duration);
          this.sceneAnimationDirection *= -1;
          if (!this.sceneAnimation.loop && this.sceneAnimationDirection > 0) this.pauseSceneAnimation();
        } else if (this.sceneAnimation.loop) {
          this.sceneAnimationTime = (this.sceneAnimationTime + this.sceneAnimation.duration) % this.sceneAnimation.duration;
        } else {
          this.sceneAnimationTime = this.sceneAnimationDirection > 0 ? this.sceneAnimation.duration : 0;
          this.pauseSceneAnimation();
        }
      }
      this.applySceneAnimationFrame(this.sceneAnimationTime);
      if (now - this.lastAnimationNotify > 80 || !this.sceneAnimationPlaying) {
        this.lastAnimationNotify = now;
        this.onAnimationChange?.(this.sceneAnimationTime, this.sceneAnimationPlaying);
      }
    } else {
      this.updateNavigation(delta);
    }
    this.updateWeather(delta);
    this.updateCollisions(false, now);
    this.syncSpaceVisuals();
    if (this.navigationMode !== "firstPerson") this.orbit.update();
    this.emitCameraChange();
    this.renderer.render(this.scene, this.camera);
  };

  private updateNavigation(delta: number): void {
    if (this.navigationMode === "firstPerson" && this.pointer.isLocked) {
      const sprint = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
      const speed = (sprint ? 8 : 4) * delta;
      const input = new THREE.Vector2(
        Number(this.keys.has("KeyD")) - Number(this.keys.has("KeyA")),
        Number(this.keys.has("KeyW")) - Number(this.keys.has("KeyS"))
      );
      if (input.lengthSq() > 0) {
        input.normalize();
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();
        const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
        const movement = forward.multiplyScalar(input.y).add(right.multiplyScalar(input.x)).multiplyScalar(speed);
        if (!this.isMovementBlocked(movement)) this.camera.position.add(movement);
      }
      const floor = this.findFloorHeight(this.camera.position);
      if (floor !== undefined) {
        const targetY = floor + this.eyeHeight;
        this.firstPersonVelocity.y += (targetY - this.camera.position.y) * Math.min(delta * 14, 1);
        this.firstPersonVelocity.y *= Math.max(0, 1 - delta * 12);
        this.camera.position.y += (targetY - this.camera.position.y) * Math.min(delta * 10, 1);
      }
      return;
    }
    if (this.navigationMode !== "thirdPerson" || !this.avatar) return;
    const input = new THREE.Vector3(
      Number(this.keys.has("KeyD")) - Number(this.keys.has("KeyA")),
      Number(this.keys.has("Space")) - Number(this.keys.has("ControlLeft") || this.keys.has("ControlRight")),
      Number(this.keys.has("KeyS")) - Number(this.keys.has("KeyW"))
    );
    const target = this.avatar.position.clone().add(new THREE.Vector3(0, 1.25, 0));
    this.orbit.target.lerp(target, Math.min(delta * 12, 1));
    if (input.lengthSq() === 0) return;
    const sprint = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    input.normalize().multiplyScalar((sprint ? 10 : 5) * delta);
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
    const movement = right.multiplyScalar(input.x)
      .add(forward.multiplyScalar(-input.z))
      .add(new THREE.Vector3(0, input.y, 0));
    if (this.isMovementBlocked(movement, this.avatar.position.clone().add(new THREE.Vector3(0, 0.9, 0)))) return;
    this.avatar.position.add(movement);
    this.camera.position.add(movement);
    this.orbit.target.add(movement);
    if (movement.lengthSq() > 0) {
      this.avatarHeading.lerp(movement.clone().normalize(), Math.min(delta * 12, 1)).normalize();
      this.avatar.rotation.y = Math.atan2(this.avatarHeading.x, this.avatarHeading.z);
    }
  }

  private configureNavigationControls(mode: NavigationMode): void {
    this.camera.up.set(0, 1, 0);
    this.orbit.enabled = mode !== "firstPerson";
    if (mode === "thirdPerson") {
      this.orbit.minDistance = 2.2;
      this.orbit.maxDistance = 12;
      this.orbit.maxPolarAngle = Math.PI * 0.48;
    } else {
      this.orbit.minDistance = 0;
      this.orbit.maxDistance = Infinity;
      this.orbit.maxPolarAngle = Math.PI;
    }
    this.updateTransformAccess();
  }

  private captureNavigationState(mode: NavigationMode): NavigationViewState {
    const position = this.camera.position.clone();
    let target = this.orbit.target.clone();
    if (mode === "firstPerson") {
      const direction = new THREE.Vector3();
      this.camera.getWorldDirection(direction);
      if (direction.lengthSq() > 1e-10) target = position.clone().add(direction.normalize().multiplyScalar(5));
    }
    return { position, target };
  }

  private rememberNavigationState(mode: NavigationMode): void {
    const state = this.captureNavigationState(mode);
    if (this.isNavigationStateUsable(state)) this.navigationViewStates.set(mode, state);
  }

  private applyNavigationViewState(state: NavigationViewState): void {
    this.camera.position.copy(state.position);
    this.orbit.target.copy(state.target);
    if (this.navigationMode === "thirdPerson") {
      this.ensureAvatar();
      this.avatar?.position.copy(state.target).add(new THREE.Vector3(0, -1.25, 0));
    }
    this.camera.lookAt(state.target);
    this.orbit.update();
  }

  private isNavigationStateUsable(state: NavigationViewState): boolean {
    const values = [...state.position.toArray(), ...state.target.toArray()];
    if (values.some((value) => !Number.isFinite(value))) return false;
    if (state.position.distanceToSquared(state.target) < 1e-8) return false;
    const bounds = this.sceneContentBox();
    if (bounds.isEmpty()) return true;
    const size = Math.max(bounds.getSize(new THREE.Vector3()).length(), 1);
    const allowed = bounds.clone().expandByScalar(Math.max(size * 24, 120));
    return allowed.containsPoint(state.position) && allowed.containsPoint(state.target);
  }

  private navigationAnchor(previousMode: NavigationMode): THREE.Vector3 {
    const bounds = this.sceneContentBox();
    const candidate = previousMode === "firstPerson"
      ? this.camera.position.clone()
      : previousMode === "thirdPerson" && this.avatar
        ? this.avatar.position.clone()
        : this.orbit.target.clone();
    if (bounds.isEmpty()) return candidate.toArray().every(Number.isFinite) ? candidate : new THREE.Vector3();
    const padded = bounds.clone().expandByScalar(Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.2, 2));
    if (!candidate.toArray().every(Number.isFinite)) return bounds.getCenter(new THREE.Vector3());
    return padded.clampPoint(candidate, new THREE.Vector3());
  }

  private recoverNavigationMode(mode: NavigationMode): void {
    const anchor = this.navigationAnchor(mode);
    if (mode === "orbit") this.frameScene();
    else if (mode === "firstPerson") this.enterFirstPerson(anchor);
    else this.enterThirdPerson(anchor);
  }

  private enterFirstPerson(anchor: THREE.Vector3): void {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() === 0) forward.set(0, 0, -1);
    forward.normalize();
    const start = anchor.clone();
    const floor = this.findFloorHeight(start.clone().add(new THREE.Vector3(0, 10, 0))) ?? 0;
    start.y = floor + this.eyeHeight;
    this.camera.position.copy(start);
    this.orbit.target.copy(start).add(forward.multiplyScalar(5));
    this.camera.lookAt(this.orbit.target);
  }

  private enterThirdPerson(anchor: THREE.Vector3): void {
    this.ensureAvatar();
    if (!this.avatar) return;
    const floor = this.findFloorHeight(anchor.clone().add(new THREE.Vector3(0, 10, 0))) ?? 0;
    this.avatar.position.set(anchor.x, Math.max(anchor.y, floor + 6), anchor.z);
    const target = this.avatar.position.clone().add(new THREE.Vector3(0, 1.25, 0));
    const direction = this.camera.position.clone().sub(anchor).setY(0).normalize();
    if (direction.lengthSq() === 0) direction.set(0, 0, 1);
    this.orbit.target.copy(target);
    this.camera.position.copy(target).add(direction.multiplyScalar(5)).add(new THREE.Vector3(0, 2.4, 0));
    this.orbit.minDistance = 2.2;
    this.orbit.maxDistance = 12;
    this.orbit.maxPolarAngle = Math.PI * 0.48;
    this.orbit.update();
  }

  private ensureAvatar(): void {
    if (this.avatar) return;
    const group = new THREE.Group();
    group.name = "helper:avatar";
    const material = new THREE.MeshStandardMaterial({ color: 0xe0a93d, roughness: 0.72 });
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.25, 0.72, 6, 10),
      material
    );
    body.position.y = 1.02;
    group.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), material);
    head.position.y = 1.62;
    group.add(head);
    const limbGeometry = new THREE.CapsuleGeometry(0.08, 0.58, 4, 8);
    for (const x of [-0.14, 0.14]) {
      const leg = new THREE.Mesh(limbGeometry, material);
      leg.position.set(x, 0.42, 0);
      group.add(leg);
    }
    const shoulder = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.12, 0.18), material);
    shoulder.position.y = 1.28;
    group.add(shoulder);
    this.scene.add(group);
    this.avatar = group;
    group.visible = this.avatarVisible && this.navigationMode === "thirdPerson";
  }

  private visibleModelObjects(): THREE.Object3D[] {
    return [...this.models.values()].filter((model) => model.visible).map((model) => model.object);
  }

  private findFloorHeight(position: THREE.Vector3): number | undefined {
    const origin = position.clone().add(new THREE.Vector3(0, 2, 0));
    this.raycaster.set(origin, new THREE.Vector3(0, -1, 0));
    this.raycaster.near = 0;
    this.raycaster.far = 20;
    const hit = this.raycaster.intersectObjects(this.visibleModelObjects(), true)
      .find((item) => item.point.y <= position.y + 2.05);
    this.raycaster.far = Infinity;
    return hit?.point.y ?? (position.y >= -2 && position.y <= 12 ? 0 : undefined);
  }

  private isMovementBlocked(movement: THREE.Vector3, origin = this.camera.position): boolean {
    if (movement.lengthSq() === 0) return false;
    this.raycaster.set(origin, movement.clone().normalize());
    this.raycaster.near = 0.05;
    this.raycaster.far = movement.length() + 0.28;
    const blocked = this.raycaster.intersectObjects(this.visibleModelObjects(), true).length > 0;
    this.raycaster.near = 0;
    this.raycaster.far = Infinity;
    return blocked;
  }

  private rebuildComponentIndex(modelId: string): void {
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
          searchText
        });
      }
      this.componentRecords.set(modelId, records);
      return;
    }
    this.componentRecords.set(modelId, buildComponentRecords(modelId, model.name, objects));
  }

  private componentRecord(modelId: string, nodeId: string): ComponentRecord | undefined {
    return this.componentRecords.get(modelId)?.find((record) => record.id === nodeId);
  }

  private focusObject(object: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(object);
    this.focusBox(box);
  }

  private updateLayerState(modelId: string, nodeId: string, patch: Omit<SceneLayerState, "nodeId">): void {
    let states = this.layerStates.get(modelId);
    if (!states) {
      states = new Map();
      this.layerStates.set(modelId, states);
    }
    const current = states.get(nodeId) ?? { nodeId };
    states.set(nodeId, { ...current, ...structuredClone(patch), nodeId });
  }

  private materialsForMesh(mesh: THREE.Mesh): THREE.Material[] {
    const source = this.collisionOriginalMaterials.get(mesh) ?? mesh.material;
    return Array.isArray(source) ? source : source ? [source] : [];
  }

  private setObjectOpacity(object: THREE.Object3D, opacity: number): void {
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      for (const material of this.materialsForMesh(mesh)) {
        material.transparent = opacity < 0.999;
        material.opacity = opacity;
        material.depthWrite = opacity >= 0.999;
        material.needsUpdate = true;
      }
    });
  }

  private setObjectColor(object: THREE.Object3D, color: string): void {
    object.traverse((child) => {
      for (const source of this.materialsForMesh(child as THREE.Mesh)) {
        const material = source as THREE.Material & { color?: THREE.Color };
        if (!material.color?.isColor) continue;
        material.color.set(color);
        material.needsUpdate = true;
      }
    });
  }

  private getMaterialState(object: THREE.Object3D): SceneMaterialState {
    let result: SceneMaterialState = {};
    object.traverse((child) => {
      if (Object.keys(result).length) return;
      const material = this.materialsForMesh(child as THREE.Mesh)[0] as THREE.MeshStandardMaterial | undefined;
      if (!material) return;
      result = {
        ...(material.color?.isColor ? { color: `#${material.color.getHexString()}` } : {}),
        ...(typeof material.roughness === "number" ? { roughness: material.roughness } : {}),
        ...(typeof material.metalness === "number" ? { metalness: material.metalness } : {}),
        ...(material.emissive?.isColor ? { emissive: `#${material.emissive.getHexString()}`, emissiveIntensity: material.emissiveIntensity } : {}),
        ...(typeof material.wireframe === "boolean" ? { wireframe: material.wireframe } : {}),
        doubleSided: material.side === THREE.DoubleSide
      };
    });
    return result;
  }

  private applyMaterialState(object: THREE.Object3D, state: SceneMaterialState): void {
    object.traverse((child) => {
      for (const source of this.materialsForMesh(child as THREE.Mesh)) {
        const material = source as THREE.MeshStandardMaterial;
        if (state.color && material.color?.isColor) material.color.set(state.color);
        if (state.emissive && material.emissive?.isColor) material.emissive.set(state.emissive);
        if (state.roughness !== undefined && typeof material.roughness === "number") material.roughness = THREE.MathUtils.clamp(state.roughness, 0, 1);
        if (state.metalness !== undefined && typeof material.metalness === "number") material.metalness = THREE.MathUtils.clamp(state.metalness, 0, 1);
        if (state.emissiveIntensity !== undefined && typeof material.emissiveIntensity === "number") material.emissiveIntensity = THREE.MathUtils.clamp(state.emissiveIntensity, 0, 10);
        if (state.wireframe !== undefined && typeof material.wireframe === "boolean") material.wireframe = state.wireframe;
        if (state.doubleSided !== undefined) material.side = state.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
        material.needsUpdate = true;
      }
    });
  }

  private objectColor(object: THREE.Object3D | undefined): string {
    if (!object) return "#d4a84f";
    let result: string | undefined;
    object.traverse((child) => {
      if (result) return;
      const material = this.materialsForMesh(child as THREE.Mesh)[0] as THREE.Material & { color?: THREE.Color };
      if (material?.color?.isColor) result = `#${material.color.getHexString()}`;
    });
    return result ?? "#d4a84f";
  }

  private updateCollisions(force: boolean, now = performance.now()): void {
    if (!force && now - this.lastCollisionCheck < 300) return;
    this.lastCollisionCheck = now;
    const next = new Set<string>();
    const records: CollisionRecord[] = [];
    const visitedPairs = new Set<string>();
    const visibleModels = [...this.models.values()].filter((model) => model.visible && model.object.visible);
    const boxes = new Map(visibleModels.map((model) => [model.id, visibleObjectBox(model.object)]));
    for (const id of this.collisionEnabledIds) {
      const source = this.models.get(id);
      const ownBox = boxes.get(id);
      if (!source || !ownBox || ownBox.isEmpty()) continue;
      for (const other of visibleModels) {
        if (other.id === id) continue;
        const pairKey = [id, other.id].sort().join("|");
        if (visitedPairs.has(pairKey)) continue;
        visitedPairs.add(pairKey);
        const otherBox = boxes.get(other.id);
        if (!otherBox || otherBox.isEmpty() || !ownBox.intersectsBox(otherBox)) continue;
        let intersection;
        try {
          intersection = preciseIntersection(source.object, other.object);
        } catch {
          intersection = undefined;
        }
        if (!intersection) continue;
        next.add(id);
        if (this.collisionEnabledIds.has(other.id)) next.add(other.id);
        const sourceComponent = this.componentRecord(id, intersection.nodeIdA);
        const targetComponent = this.componentRecord(other.id, intersection.nodeIdB);
        records.push({
          id: `${pairKey}:${intersection.nodeIdA}:${intersection.nodeIdB}`,
          sourceModelId: id,
          sourceNodeId: intersection.nodeIdA,
          sourceName: sourceComponent?.name ?? source.name,
          targetModelId: other.id,
          targetNodeId: intersection.nodeIdB,
          targetName: targetComponent?.name ?? other.name,
          point: toValue(intersection.point)
        });
      }
    }
    const changed = next.size !== this.collidingIds.size
      || [...next].some((id) => !this.collidingIds.has(id))
      || records.map((item) => item.id).join("|") !== this.collisionRecords.map((item) => item.id).join("|");
    for (const model of visibleModels) this.setCollisionHighlight(model, next.has(model.id));
    this.collidingIds.clear();
    next.forEach((id) => this.collidingIds.add(id));
    this.collisionRecords = records;
    if (changed) this.onCollisionChange?.();
  }

  private setCollisionHighlight(model: LoadedSceneModel, active: boolean): void {
    model.object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      if (active) {
        if (!this.collisionOriginalMaterials.has(mesh)) this.collisionOriginalMaterials.set(mesh, mesh.material);
        const original = this.collisionOriginalMaterials.get(mesh);
        mesh.material = Array.isArray(original) ? original.map(() => this.collisionMaterial) : this.collisionMaterial;
      } else {
        const original = this.collisionOriginalMaterials.get(mesh);
        if (!original) return;
        mesh.material = original;
        this.collisionOriginalMaterials.delete(mesh);
      }
    });
  }

  private createMeasurementGroup(
    measurement: MeasurementState,
    preview: boolean
  ): THREE.Group {
    const group = new THREE.Group();
    const kind = measurement.kind ?? "distance";
    const points = (measurement.points?.length ? measurement.points : [measurement.start, measurement.end])
      .map((point) => new THREE.Vector3(point.x, point.y, point.z));
    const start = points[0] ?? new THREE.Vector3();
    const end = points[1] ?? start;
    const distance = measurement.distance;
    const color = preview ? 0xf0d58d : 0xf6c453;
    const material = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: preview, opacity: preview ? 0.75 : 1 });
    const linePoints = kind === "angle" && points[2]
      ? [start, end, start, points[2]]
      : [start, end];
    const line = kind === "angle" && points[2]
      ? new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(linePoints), material)
      : new THREE.Line(new THREE.BufferGeometry().setFromPoints(linePoints), material);
    line.renderOrder = 20;
    group.add(line);
    const extent = Math.max(...points.map((point) => point.distanceTo(start)), distance);
    const size = Math.max(extent * 0.012, 0.035);
    for (const point of points) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(size, 12, 8),
        new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: preview, opacity: preview ? 0.75 : 1 })
      );
      marker.position.copy(point);
      marker.renderOrder = 21;
      group.add(marker);
    }
    let labelPosition = start.clone().lerp(end, 0.5);
    if (kind === "angle" && points[2]) {
      const first = end.clone().sub(start);
      const second = points[2].clone().sub(start);
      const angle = measurement.angle ?? measurementAngle(start, end, points[2]);
      const radius = Math.max(Math.min(first.length(), second.length()) * 0.28, 0.15);
      const axis = new THREE.Vector3().crossVectors(first, second).normalize();
      if (axis.lengthSq() < 1e-8) axis.set(0, 1, 0);
      const direction = first.normalize();
      const arcPoints = Array.from({ length: 33 }, (_, index) => direction.clone()
        .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, angle * index / 32))
        .multiplyScalar(radius)
        .add(start));
      const arc = new THREE.Line(new THREE.BufferGeometry().setFromPoints(arcPoints), material.clone());
      arc.renderOrder = 20;
      group.add(arc);
      labelPosition = arcPoints[16]!.clone().sub(start).multiplyScalar(1.35).add(start);
    }
    if (kind === "elevation") labelPosition.copy(end).add(new THREE.Vector3(size * 2, 0, 0));
    if (distance > 0.0001 || kind === "angle" || kind === "elevation") {
      const label = this.createMeasurementLabel(formatMeasurementState(measurement), color);
      label.position.copy(labelPosition);
      label.position.y += Math.max(size * 2.5, 0.08);
      label.renderOrder = 22;
      group.add(label);
    }
    return group;
  }

  private createAnnotationObject(annotation: SceneAnnotationState): THREE.Group {
    const selected = this.selectedAnnotationId === annotation.id;
    const color = new THREE.Color(selected ? "#4d9fff" : annotation.color);
    const group = new THREE.Group();
    group.name = `annotation:${annotation.id}`;
    group.position.set(annotation.position.x, annotation.position.y, annotation.position.z);
    group.visible = annotation.visible;
    group.userData.annotationId = annotation.id;

    const size = annotation.size ?? 1;
    const pinHeight = 0.48 * size;
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, pinHeight, 0)]),
      new THREE.LineBasicMaterial({ color, depthTest: false })
    );
    line.renderOrder = 31;
    line.userData.annotationId = annotation.id;
    group.add(line);

    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.075 * size, 16, 10),
      new THREE.MeshBasicMaterial({ color, depthTest: false })
    );
    marker.position.y = pinHeight;
    marker.renderOrder = 32;
    marker.userData.annotationId = annotation.id;
    group.add(marker);

    const sprite = this.createAnnotationLabel(annotation, selected);
    sprite.position.y = pinHeight + 0.28 * size;
    sprite.userData.annotationId = annotation.id;
    sprite.renderOrder = 33;
    group.add(sprite);
    return group;
  }

  private createAnnotationLabel(annotation: SceneAnnotationState, selected: boolean): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 160;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "rgba(20, 25, 29, .96)";
      context.beginPath();
      context.roundRect(8, 8, 624, 144, 24);
      context.fill();
      context.strokeStyle = selected ? "#4d9fff" : annotation.color;
      context.lineWidth = selected ? 8 : 5;
      context.stroke();
      context.fillStyle = "#f5f7f8";
      context.font = '700 46px "Microsoft YaHei", "Segoe UI", sans-serif';
      context.textAlign = "left";
      context.textBaseline = "middle";
      context.fillText(ellipsize(annotation.name, 16), 34, annotation.description ? 61 : 81);
      if (annotation.description) {
        context.fillStyle = "#9ea9b0";
        context.font = '400 28px "Microsoft YaHei", "Segoe UI", sans-serif';
        context.fillText(ellipsize(annotation.description, 26), 34, 113);
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
    const size = annotation.size ?? 1;
    sprite.scale.set(2.4 * size, 0.6 * size, 1);
    return sprite;
  }

  private refreshAnnotationVisual(id: string): void {
    const current = this.annotations.get(id);
    if (!current) return;
    const state = structuredClone(current.state);
    this.disposeObject(current.object);
    const object = this.createAnnotationObject(state);
    this.annotations.set(id, { state, object });
    this.scene.add(object);
  }

  private createMeasurementLabel(text: string, color: number): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 360;
    canvas.height = 96;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "rgba(22, 25, 27, .92)";
      context.beginPath();
      context.roundRect(4, 4, 352, 88, 18);
      context.fill();
      context.strokeStyle = `#${color.toString(16).padStart(6, "0")}`;
      context.lineWidth = 4;
      context.stroke();
      context.fillStyle = "#f8f2e6";
      context.font = '600 36px "Segoe UI", sans-serif';
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(text, 180, 49);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
    sprite.scale.set(1.8, 0.48, 1);
    return sprite;
  }

  private updateMeasurementPreview(end: THREE.Vector3): void {
    const start = this.measurementPoints[0];
    if (!start) return;
    this.removeMeasurementPreview();
    const constrained = constrainMeasurementEnd(start, end, this.measureMode);
    const points = this.measureMode === "angle" && this.measurementPoints[1]
      ? [start, this.measurementPoints[1]!, constrained]
      : [start, constrained];
    const angle = this.measureMode === "angle" && points[2] ? measurementAngle(points[0]!, points[1]!, points[2]) : undefined;
    this.measurementPreview = this.createMeasurementGroup({
      id: "preview",
      start: toValue(points[0]!),
      end: toValue(points[1]!),
      distance: points[0]!.distanceTo(points[1]!),
      kind: this.measureMode,
      points: points.map(toValue),
      ...(angle === undefined ? {} : { angle })
    }, true);
    this.measurementPreview.name = "helper:measurement-preview";
    this.scene.add(this.measurementPreview);
  }

  private measurementEnd(start: THREE.Vector3, hitPoint: THREE.Vector3): THREE.Vector3 {
    if (this.measureMode !== "vertical") return constrainMeasurementEnd(start, hitPoint, this.measureMode);
    return projectRayToVerticalAxis(this.raycaster.ray, start);
  }

  private finishMeasurement(measurement: MeasurementState): void {
    this.removeMeasurementPreview();
    this.addMeasurementVisual(measurement);
    this.onMeasurement?.(measurement);
    this.measurementPoints.length = 0;
    this.measurementTargets.length = 0;
    this.onMeasurementDraftChange?.(false, 0, 0);
  }

  private removeMeasurementPreview(): void {
    if (!this.measurementPreview) return;
    this.disposeObject(this.measurementPreview);
    this.measurementPreview = undefined;
  }

  private disposeObject(object: THREE.Object3D): void {
    object.parent?.remove(object);
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      materials.forEach((material) => {
        const withMap = material as THREE.Material & { map?: THREE.Texture };
        withMap.map?.dispose();
        material.dispose();
      });
    });
  }

  private pointerHit(event: PointerEvent): THREE.Intersection | undefined {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerPosition.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this.pointerPosition, this.camera);
    return this.raycaster.intersectObjects(this.visibleModelObjects(), true)[0];
  }

  private annotationPointerHit(event: PointerEvent): string | undefined {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerPosition.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this.pointerPosition, this.camera);
    const roots = [...this.annotations.values()].filter(({ state }) => state.visible).map(({ object }) => object);
    const hit = this.raycaster.intersectObjects(roots, true)[0];
    return hit?.object.userData.annotationId as string | undefined;
  }

  private async scenePointerHit(event: PointerEvent): Promise<PointerSceneHit | undefined> {
    const ordinary = this.pointerHit(event);
    const ordinaryModelId = ordinary?.object.userData.modelId as string | undefined;
    let best: PointerSceneHit | undefined = ordinary ? {
      point: ordinary.point.clone(),
      distance: ordinary.distance,
      objectName: ordinary.object.name || ordinary.object.type,
      object: ordinary.object,
      ...(ordinary.face ? { normal: ordinary.face.normal.clone().transformDirection(ordinary.object.matrixWorld) } : {}),
      ...(ordinaryModelId ? { modelId: ordinaryModelId } : {})
    } : undefined;
    const mouse = new THREE.Vector2(event.clientX, event.clientY);
    for (const [modelId, fragmentsModel] of this.fragmentModels) {
      if (!this.models.get(modelId)?.visible) continue;
      const hit = await fragmentsModel.raycast({ camera: this.camera, mouse, dom: this.renderer.domElement });
      if (!hit || (best && best.distance <= hit.distance && ordinaryModelId !== modelId)) continue;
      const fragmentNodeId = this.fragmentNodeIdsByLocalId.get(modelId)?.get(hit.localId)
        ?? this.ensureFragmentEntry(modelId, hit.localId);
      const entry = fragmentNodeId ? this.fragmentLayers.get(modelId)?.get(fragmentNodeId) : undefined;
      best = {
        point: hit.point.clone(),
        distance: hit.distance,
        objectName: entry?.node.name || `IFC 构件 ${hit.localId}`,
        object: hit.object,
        ...(hit.normal ? { normal: hit.normal.clone() } : {}),
        modelId,
        ...(fragmentNodeId ? { fragmentNodeId } : {})
      };
    }
    if (!best && (this.measureEnabled || this.annotationPlacementEnabled)) {
      const point = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
      if (point) best = { point, distance: this.camera.position.distanceTo(point), objectName: "地面" };
    }
    return best;
  }

  private handlePointerMove = async (event: PointerEvent): Promise<void> => {
    if (!this.onPointerInfoChange && !(this.measureEnabled && this.measurementPoints.length > 0)) return;
    const hit = await this.scenePointerHit(event);
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.onPointerInfoChange?.({
      screenX: Math.round(event.clientX - rect.left),
      screenY: Math.round(event.clientY - rect.top),
      ...(hit ? { world: toValue(hit.point), objectName: hit.objectName } : {})
    });
    if (this.measureEnabled && this.measurementPoints.length > 0 && hit) {
      this.updateMeasurementPreview(this.measurementEnd(this.measurementPoints[0]!, hit.point));
    }
  };

  private handlePointerLeave = (): void => {
    if (this.measurementPoints.length > 0) this.removeMeasurementPreview();
    this.onPointerInfoChange?.(undefined);
  };

  private preventContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private handlePointerDown = async (event: PointerEvent): Promise<void> => {
    if (this.navigationMode === "firstPerson") return;
    if (event.button !== 0) return;
    const hit = await this.scenePointerHit(event);
    if (this.annotationPlacementEnabled) {
      if (!hit) return;
      const annotation: SceneAnnotationState = {
        id: crypto.randomUUID(),
        name: `标签 ${this.annotations.size + 1}`,
        description: hit.objectName,
        position: toValue(hit.point),
        color: "#2f8fff",
        visible: true,
        locked: false,
        size: 1,
        ...(hit.modelId ? { modelId: hit.modelId } : {}),
        ...(hit.fragmentNodeId ? { layerId: hit.fragmentNodeId } : hit.object?.userData.layerNodeId ? { layerId: String(hit.object.userData.layerNodeId) } : {}),
        anchorName: hit.objectName
      };
      this.addAnnotation(annotation);
      this.selectAnnotation(annotation.id);
      this.onAnnotationPlaced?.(structuredClone(annotation));
      return;
    }
    if (this.clippingState.enabled && this.clippingState.mode === "face" && !this.clippingState.face) {
      if (!hit?.normal) return;
      const next: ClippingState = {
        ...this.clippingState,
        face: { normal: toValue(hit.normal.clone().normalize()), point: toValue(hit.point) }
      };
      this.setClipping(next);
      this.onClippingFacePicked?.(next);
      return;
    }
    if (this.measureEnabled) {
      if (!hit) return;
      if (this.measureMode === "elevation") {
        const [start, end] = elevationSegment(hit.point);
        this.finishMeasurement({
          id: crypto.randomUUID(),
          start: toValue(start),
          end: toValue(end),
          distance: start.distanceTo(end),
          elevation: hit.point.y,
          kind: "elevation",
          points: [toValue(start), toValue(end)],
          labels: [hit.objectName]
        });
        return;
      }
      if (this.measureMode === "minimum") {
        const model = hit.modelId ? this.models.get(hit.modelId) : undefined;
        const object = hit.object ? nearestBimElement(hit.object, model?.object) ?? hit.object : undefined;
        this.measurementTargets.push({ point: hit.point.clone(), ...(object ? { object } : {}), label: hit.objectName });
        this.measurementPoints.push(hit.point.clone());
        if (this.measurementTargets.length === 1) {
          this.onMeasurementDraftChange?.(true, 1, 2);
          return;
        }
        const [first, second] = this.measurementTargets;
        const closest = first?.object && second?.object && first.object !== second.object
          ? closestPointsBetweenObjects(first.object, second.object)
          : undefined;
        const start = closest?.pointA ?? first!.point;
        const end = closest?.pointB ?? second!.point;
        this.finishMeasurement({
          id: crypto.randomUUID(),
          start: toValue(start),
          end: toValue(end),
          distance: start.distanceTo(end),
          kind: "minimum",
          points: [toValue(start), toValue(end)],
          labels: [first?.label ?? "对象 A", second?.label ?? "对象 B"]
        });
        return;
      }
      const point = this.measurementPoints.length === 1
        ? this.measurementEnd(this.measurementPoints[0]!, hit.point)
        : hit.point.clone();
      this.measurementPoints.push(point);
      const requiredPoints = this.measureMode === "angle" ? 3 : 2;
      this.onMeasurementDraftChange?.(this.measurementPoints.length < requiredPoints, this.measurementPoints.length, requiredPoints);
      if (this.measurementPoints.length === requiredPoints) {
        const start = this.measurementPoints[0]!;
        const end = this.measurementPoints[1]!;
        const measurement: MeasurementState = {
          id: crypto.randomUUID(),
          start: toValue(start),
          end: toValue(end),
          distance: start.distanceTo(end),
          kind: this.measureMode,
          points: this.measurementPoints.map(toValue),
          ...(this.measureMode === "angle" ? { angle: measurementAngle(start, end, this.measurementPoints[2]!) } : {})
        };
        this.finishMeasurement(measurement);
      }
      return;
    }
    const annotationId = this.annotationPointerHit(event);
    if (annotationId) {
      this.selectAnnotation(annotationId);
      return;
    }
    if (hit?.modelId && this.selectionScope === "model") {
      this.select(hit.modelId);
      return;
    }
    if (hit?.modelId && hit.fragmentNodeId) {
      this.selectLayer(hit.modelId, hit.fragmentNodeId);
      return;
    }
    const id = hit?.modelId;
    if (!hit?.object) {
      this.select(id);
      return;
    }
    this.selectedId = id;
    this.selectedFragmentNodeId = undefined;
    const model = id ? this.models.get(id) : undefined;
    this.inspectedObject = nearestBimElement(hit.object, model?.object) ?? hit.object;
    if (!model || !this.inspectedObject) this.transform.detach();
    this.updateTransformAccess();
    this.updateSelectionHelper();
    this.onSelectionChange?.(model);
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    this.keys.add(event.code);
    if (event.code === "Escape") {
      if (this.measurementPoints.length > 0) {
        this.measurementPoints.length = 0;
        this.measurementTargets.length = 0;
        this.removeMeasurementPreview();
        this.onMeasurementDraftChange?.(false);
      } else {
        this.select(undefined);
      }
    }
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };
}

function collectSpatialLocalIds(item: FRAGS.SpatialTreeItem, output = new Set<number>()): Set<number> {
  if (item.localId !== null) output.add(item.localId);
  for (const child of item.children ?? []) collectSpatialLocalIds(child, output);
  return output;
}

function setTreeVisibility(node: LayerTreeNode, visible: boolean): void {
  node.visible = visible;
  for (const child of node.children) setTreeVisibility(child, visible);
}

function setTreeLock(node: LayerTreeNode, locked: boolean): void {
  node.locked = locked;
  for (const child of node.children) setTreeLock(child, locked);
}

function humanizeIfcCategory(category: string | null): string {
  if (!category) return "";
  return category
    .replace(/^IFC/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim();
}

function fragmentItemProperties(data: FRAGS.ItemData | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  if (!data) return output;
  for (const [key, raw] of Object.entries(data)) {
    if (Array.isArray(raw)) {
      if (raw.length > 0) output[key] = `${raw.length} 项`;
      continue;
    }
    const value = raw?.value;
    if (value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") output[key] = String(value);
    else {
      try { output[key] = JSON.stringify(value); } catch { output[key] = String(value); }
    }
  }
  return output;
}

function fragmentPropertyValue(properties: Record<string, string>, candidates: string[]): string | undefined {
  const entries = Object.entries(properties);
  for (const candidate of candidates) {
    const match = entries.find(([key]) => key.toLocaleLowerCase("zh-CN") === candidate.toLocaleLowerCase("zh-CN"));
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function objectTransform(object: THREE.Object3D): ModelTransform {
  return {
    position: toValue(object.position),
    rotation: toValue(object.rotation),
    scale: toValue(object.scale)
  };
}

function applyTransform(object: THREE.Object3D, transform: ModelTransform): void {
  object.position.set(transform.position.x, transform.position.y, transform.position.z);
  object.rotation.set(transform.rotation.x, transform.rotation.y, transform.rotation.z);
  object.scale.set(transform.scale.x, transform.scale.y, transform.scale.z);
  object.updateMatrixWorld(true);
}

function visibleObjectBox(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  root.updateWorldMatrix(true, true);
  root.traverse((child) => {
    const renderable = child as THREE.Object3D & { geometry?: THREE.BufferGeometry };
    if (!renderable.geometry || !isEffectivelyVisible(child, root)) return;
    if (!renderable.geometry.boundingBox) renderable.geometry.computeBoundingBox();
    const childBox = renderable.geometry.boundingBox?.clone();
    if (childBox) box.union(childBox.applyMatrix4(child.matrixWorld));
  });
  return box;
}

function spaceVisualKey(space: Pick<BimSpaceRecord, "modelId" | "id">): string {
  return `${space.modelId}:${space.id}`;
}

export function normalizedSpaceBox(bounds: { min: Vector3Value; max: Vector3Value }): THREE.Box3 | undefined {
  const values = [bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z];
  if (!values.every(Number.isFinite)) return undefined;
  const box = new THREE.Box3(
    new THREE.Vector3(
      Math.min(bounds.min.x, bounds.max.x),
      Math.min(bounds.min.y, bounds.max.y),
      Math.min(bounds.min.z, bounds.max.z)
    ),
    new THREE.Vector3(
      Math.max(bounds.min.x, bounds.max.x),
      Math.max(bounds.min.y, bounds.max.y),
      Math.max(bounds.min.z, bounds.max.z)
    )
  );
  const size = box.getSize(new THREE.Vector3());
  if (size.lengthSq() < 1e-10) return undefined;
  const padding = new THREE.Vector3(
    size.x < 0.02 ? 0.25 : 0,
    size.y < 0.02 ? 0.25 : 0,
    size.z < 0.02 ? 0.25 : 0
  );
  box.min.sub(padding);
  box.max.add(padding);
  return box;
}

function isFiniteBox(box: THREE.Box3): boolean {
  return [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z].every(Number.isFinite);
}

function isEffectivelyVisible(object: THREE.Object3D, root: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible || current.userData.layerDeleted) return false;
    if (current === root) return true;
    current = current.parent;
  }
  return false;
}

function isAncestorOf(ancestor: THREE.Object3D, object: THREE.Object3D): boolean {
  let current = object.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function explosionTargets(root: THREE.Object3D): THREE.Object3D[] {
  const semantic: THREE.Object3D[] = [];
  root.traverse((object) => {
    if (object !== root && object.userData.NodeType === "Element" && objectVisibleMeshCount(object) > 0) semantic.push(object);
  });
  if (semantic.length > 1) return semantic;
  const meshes: THREE.Object3D[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry?.attributes.position && isEffectivelyVisible(mesh, root)) meshes.push(mesh);
  });
  return meshes;
}

function objectVisibleMeshCount(root: THREE.Object3D): number {
  let count = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry?.attributes.position && isEffectivelyVisible(mesh, root)) count += 1;
  });
  return count;
}

function sanitizeExportObject(object: THREE.Object3D): void {
  object.userData = {};
  for (const child of [...object.children]) {
    if (child.userData.layerDeleted || child.name.startsWith("helper:") || child.name.startsWith("measurement:")) {
      object.remove(child);
      continue;
    }
    sanitizeExportObject(child);
  }
}

function normalizeAnnotation(annotation: SceneAnnotationState): SceneAnnotationState {
  return {
    ...structuredClone(annotation),
    name: annotation.name.trim() || "未命名标签",
    description: annotation.description?.trim() ?? "",
    color: /^#[0-9a-f]{6}$/i.test(annotation.color) ? annotation.color : "#2f8fff",
    visible: annotation.visible !== false,
    locked: annotation.locked === true,
    size: THREE.MathUtils.clamp(annotation.size ?? 1, 0.35, 3)
  };
}

function ellipsize(value: string, maxLength: number): string {
  const characters = [...value];
  return characters.length <= maxLength ? value : `${characters.slice(0, Math.max(maxLength - 1, 1)).join("")}…`;
}

function formatMeasurementState(measurement: MeasurementState): string {
  const kind = measurement.kind ?? "distance";
  if (kind === "angle") return `${THREE.MathUtils.radToDeg(measurement.angle ?? 0).toFixed(1)}°`;
  if (kind === "elevation") {
    const elevation = measurement.elevation ?? measurement.end.y;
    return `标高 ${elevation >= 0 ? "+" : ""}${elevation.toFixed(3)} m`;
  }
  const prefix = kind === "minimum" ? "最小 " : kind === "horizontal" ? "水平 " : kind === "vertical" ? "垂直 " : "";
  if (measurement.distance < 1) return `${prefix}${Math.round(measurement.distance * 1000)} mm`;
  return `${prefix}${measurement.distance.toFixed(measurement.distance < 10 ? 3 : 2)} m`;
}

function countObjects(object: THREE.Object3D): number {
  let count = 0;
  object.traverse(() => count += 1);
  return count;
}

function flattenProperties(value: unknown, output: Record<string, string>, prefix = ""): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (child === null || child === undefined) continue;
    if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") {
      if (!(label in output)) output[label] = String(child);
    } else if (Array.isArray(child)) {
      if (!(label in output)) output[label] = child.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join(", ");
    } else if (prefix.split(".").length < 2) {
      flattenProperties(child, output, label);
    }
  }
}

async function loadNativeBimMetadata(url: string): Promise<NativeBimPropertiesFile> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`BIM 元数据下载失败：${response.status}`);
  return await response.json() as NativeBimPropertiesFile;
}

function hydrateNativeBimMetadata(root: THREE.Object3D, payload: NativeBimPropertiesFile): void {
  if (payload.model && typeof payload.model === "object") root.userData.BimModel = payload.model;
  if (payload.spaces && typeof payload.spaces === "object") root.userData.BimSpaces = payload.spaces;
  const source = payload.elements && typeof payload.elements === "object"
    ? payload.elements
    : Object.fromEntries(
        Object.entries(payload)
          .filter(([key, value]) => key !== "model" && key !== "schemaVersion" && value && typeof value === "object")
      ) as Record<string, NativeBimElementMetadata>;
  const objectsByElement = new Map<string, THREE.Object3D[]>();
  root.traverse((object) => {
    const elementId = scalarText(object.userData.ElementId);
    if (!elementId) return;
    const objects = objectsByElement.get(elementId) ?? [];
    objects.push(object);
    objectsByElement.set(elementId, objects);
  });
  for (const [elementId, metadata] of Object.entries(source)) {
    const candidates = objectsByElement.get(elementId) ?? [];
    const object = candidates.find((candidate) => candidate.userData.NodeType === "Element")
      ?? candidates.find((candidate) => candidate.children.length > 0)
      ?? candidates[0];
    if (!object || !metadata || typeof metadata !== "object") continue;
    const displayProperties = metadata.displayProperties && typeof metadata.displayProperties === "object"
      ? metadata.displayProperties
      : { ...primitiveProperties(metadata), ...parameterProperties(metadata.instanceParameters, "实例") };
    const typeId = scalarText(metadata.typeId);
    const typeMetadata = typeId ? payload.types?.[typeId] : undefined;
    const typeDisplay = typeMetadata?.displayProperties && typeof typeMetadata.displayProperties === "object"
      ? typeMetadata.displayProperties
      : parameterProperties(typeMetadata?.parameters, "类型");
    const materialIds = Array.isArray(metadata.materialIds) ? metadata.materialIds.map(scalarText).filter(Boolean) as string[] : [];
    const materials = materialIds.map((id) => payload.materials?.[id]).filter(Boolean);
    Object.assign(object.userData, typeDisplay, displayProperties, {
      NodeType: "Element",
      ElementId: scalarText(metadata.elementId) ?? elementId,
      UniqueId: scalarText(metadata.uniqueId) ?? scalarText(object.userData.UniqueId) ?? "",
      BimMetadata: { ...metadata, typeMetadata, materials }
    });
  }
}

function primitiveProperties(value: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") output[key] = String(child);
  }
  return output;
}

function parameterProperties(value: unknown, prefix: string): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const output: Record<string, string> = {};
  for (const parameter of value) {
    if (!parameter || typeof parameter !== "object") continue;
    const record = parameter as Record<string, unknown>;
    const name = scalarText(record.name);
    const parameterValue = scalarText(record.value);
    if (!name || parameterValue === undefined) continue;
    const baseKey = `${prefix}.${name}`;
    let key = baseKey;
    let duplicate = 2;
    while (key in output) key = `${baseKey} (${duplicate++})`;
    output[key] = parameterValue;
  }
  return output;
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
}

function firstProperty(properties: Record<string, string>, names: string[]): string | undefined {
  const normalizedNames = names.map((name) => name.toLocaleLowerCase("zh-CN"));
  for (const [key, value] of Object.entries(properties)) {
    if (normalizedNames.includes(key.toLocaleLowerCase("zh-CN")) && value.trim()) return value.trim();
  }
  return undefined;
}

function nearestBimElement(object: THREE.Object3D, boundary?: THREE.Object3D): THREE.Object3D | undefined {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current.userData.NodeType === "Element") return current;
    if (current === boundary) return undefined;
    current = current.parent;
  }
  return undefined;
}

function isVectorValue(value: unknown): value is Vector3Value {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Vector3Value>;
  return Number.isFinite(candidate.x) && Number.isFinite(candidate.y) && Number.isFinite(candidate.z);
}

function dxfPoints(entity: DxfEntity): THREE.Vector3[] {
  if (entity.vertices?.length) return entity.vertices.map((vertex) => new THREE.Vector3(vertex.x, vertex.y, vertex.z ?? 0));
  if ((entity.type === "CIRCLE" || entity.type === "ARC") && entity.center && entity.radius) {
    const start = entity.type === "ARC" ? entity.startAngle ?? 0 : 0;
    const end = entity.type === "ARC" ? entity.endAngle ?? Math.PI * 2 : Math.PI * 2;
    return Array.from({ length: 49 }, (_, index) => {
      const angle = start + ((end - start) * index) / 48;
      return new THREE.Vector3(
        entity.center!.x + Math.cos(angle) * entity.radius!,
        entity.center!.y + Math.sin(angle) * entity.radius!,
        entity.center!.z ?? 0
      );
    });
  }
  return [];
}

function dxfUnitScale(value: unknown): number {
  const unit = Number(value);
  if (unit === 1) return 0.0254;
  if (unit === 2 || unit === 21) return 0.3048;
  if (unit === 4) return 0.001;
  if (unit === 5) return 0.01;
  if (unit === 6) return 1;
  if (unit === 14) return 0.1;
  return 1;
}

function dxfUnitName(value: unknown): string {
  const unit = Number(value);
  if (unit === 1) return "inch";
  if (unit === 2 || unit === 21) return "foot";
  if (unit === 4) return "millimeter";
  if (unit === 5) return "centimeter";
  if (unit === 6) return "meter";
  if (unit === 14) return "decimeter";
  return "drawing units";
}

function dxfDrawingExtents(header?: Record<string, unknown>): THREE.Box2 | undefined {
  const minimum = header?.["$EXTMIN"] as { x?: unknown; y?: unknown } | undefined;
  const maximum = header?.["$EXTMAX"] as { x?: unknown; y?: unknown } | undefined;
  const minX = Number(minimum?.x);
  const minY = Number(minimum?.y);
  const maxX = Number(maximum?.x);
  const maxY = Number(maximum?.y);
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX <= minX || maxY <= minY) return undefined;
  const padding = Math.max(maxX - minX, maxY - minY) * 0.02;
  return new THREE.Box2(
    new THREE.Vector2(minX - padding, minY - padding),
    new THREE.Vector2(maxX + padding, maxY + padding)
  );
}

function pointsIntersectExtents(points: THREE.Vector3[], extents: THREE.Box2): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return maxX >= extents.min.x && minX <= extents.max.x && maxY >= extents.min.y && minY <= extents.max.y;
}
