import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Box,
  Camera,
  CloudRain,
  Cpu,
  ChevronDown,
  ChevronRight,
  DoorOpen,
  Eye,
  EyeOff,
  Footprints,
  Focus,
  Film,
  Gauge,
  HeartHandshake,
  Import,
  Info,
  Layers3,
  LayoutGrid,
  LoaderCircle,
  Lightbulb,
  Languages,
  Lock,
  LocateFixed,
  MapPin,
  Maximize,
  Move,
  MousePointer2,
  Orbit,
  Pause,
  Play,
  Plus,
  RotateCw,
  Rocket,
  Ruler,
  Save,
  ScanLine,
  Scaling,
  Search,
  Snowflake,
  Radio,
  Sun,
  Trash2,
  Upload,
  UserRound,
  Unlock,
  X
} from "lucide-react";
import type {
  CameraState,
  ClippingState,
  ExplosionMode,
  GlobalLightingState,
  MeasurementState,
  ModelRecord,
  ModelTransform,
  ProjectRecord,
  RvtConversionMode,
  SceneAnnotationState,
  SceneAnimationState,
  SceneEnvironmentState,
  SceneFloorState,
  SceneLightState,
  SceneMaterialState,
  ScenePostProcessingState,
  SceneSnapshot,
  SkyboxPreset,
  WeatherMode
} from "@bim-studio/contracts";
import { api } from "./api";
import { LayerTree } from "./components/LayerTree";
import { SceneManager } from "./components/SceneManager";
import { SceneExportMenu } from "./components/SceneExportMenu";
import { SpaceTree } from "./components/SpaceTree";
import { CreditsModal } from "./components/CreditsModal";
import { DigitalTwinPanel } from "./components/DigitalTwinPanel";
import { SceneDashboardOverlay } from "./components/SceneDashboardOverlay";
import { readLocale, storeLocale, translate as tr, type AppLocale } from "./i18n";
import { exportGlbFile, exportLooseScene, exportScenePackage, readSceneFile } from "./sceneFiles";
import {
  ViewerEngine,
  type BimPropertyEntry,
  type BimSpaceRecord,
  type ComponentRecord,
  type LoadedSceneModel,
  type MeasureMode,
  type NavigationMode,
  type PointerInfo,
  type RendererBackend,
  type SelectionScope,
  type StandardView,
  type TransformMode
} from "./viewer/ViewerEngine";

const ACCEPTED_MODELS = ".rvt,.ifc,.step,.stp,.dwg,.dxf,.gltf,.glb,.fbx";
const RENDERER_BACKEND_STORAGE_KEY = "bim-studio.renderer-backend";
const numberFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const DEFAULT_LIGHTING: GlobalLightingState = {
  enabled: true,
  intensity: 1,
  shadowsEnabled: false,
  reflectionsEnabled: false,
  globalIlluminationEnabled: false,
  globalIlluminationIntensity: 0.45,
  lights: [
    { id: "hemisphere-default", name: "半球光", type: "hemisphere", enabled: true, color: "#e8f0ff", groundColor: "#3b4249", intensity: 1.4 },
    { id: "sun-default", name: "主方向光", type: "directional", enabled: true, color: "#ffffff", intensity: 2.2, position: { x: 18, y: 28, z: 12 }, target: { x: 0, y: 0, z: 0 }, castShadow: true }
  ]
};
const DEFAULT_ENVIRONMENT: SceneEnvironmentState = { gridVisible: true, backgroundColor: "#202a31", skybox: "none", environmentAsBackground: false, environmentIntensity: 1 };
const DEFAULT_POST_PROCESSING: ScenePostProcessingState = {
  enabled: false,
  smaa: false,
  fxaa: false,
  ssao: false,
  ssaoIntensity: 1,
  gtao: false,
  gtaoIntensity: 1,
  bloom: false,
  bloomStrength: 0.35,
  bloomThreshold: 0.9,
  outline: false,
  outlineStrength: 2.5,
  depthOfField: false,
  focusDistance: 10,
  aperture: 0.00002,
  maxBlur: 0.006,
  vignette: false,
  vignetteDarkness: 1.2,
  filmGrain: false,
  filmGrainIntensity: 0.18,
  afterimage: false,
  afterimageDamp: 0.9
};
const SKYBOX_OPTIONS: Array<{ value: SkyboxPreset; label: string }> = [
  { value: "none", label: "纯色" },
  { value: "clear", label: "晴空" },
  { value: "sunset", label: "黄昏" },
  { value: "night", label: "夜空" }
];
const DEFAULT_ANIMATION: SceneAnimationState = {
  duration: 10,
  loop: false,
  pingPong: false,
  playbackSpeed: 1,
  cameraInterpolation: "smooth",
  showCameraPath: true,
  camera: [],
  models: []
};
const DEFAULT_CLIPPING: ClippingState = { enabled: false, mode: "axis", axis: "x", offset: 0, inverted: false };
const ModelOptimizer = lazy(() => import("./components/ModelOptimizer").then((module) => ({ default: module.ModelOptimizer })));

interface AppRoute {
  view: "manager" | "studio" | "optimizer" | "view" | "published";
  sceneId?: string;
}

function readRoute(): AppRoute {
  if (window.location.pathname === "/optimizer") return { view: "optimizer" };
  const match = window.location.pathname.match(/^\/(studio|view|published)\/([^/]+)$/);
  if (match?.[1] && match[2]) return { view: match[1] as "studio" | "view" | "published", sceneId: decodeURIComponent(match[2]) };
  return { view: "manager" };
}

function sortScenesByTime(items: SceneSnapshot[]): SceneSnapshot[] {
  return [...items].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

async function waitForModelReady(projectId: string, modelId: string): Promise<ProjectRecord> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const current = await api.getProject(projectId);
    const model = current.models.find((item) => item.id === modelId);
    if (!model) throw new Error("导入的模型资源不存在");
    if (model.status === "ready") return current;
    if (model.status === "failed" || model.status === "waiting_converter") throw new Error(model.message);
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error("模型资源处理超时，请稍后在项目资源中查看");
}

export function App() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const environmentMapRef = useRef<HTMLInputElement>(null);
  const sceneNameCommitRef = useRef<Promise<boolean> | undefined>(undefined);
  const rendererSnapshotRef = useRef<{ scene: SceneSnapshot; readOnly: boolean } | undefined>(undefined);
  const [engine, setEngine] = useState<ViewerEngine>();
  const [rendererBackend, setRendererBackend] = useState<RendererBackend>(() =>
    window.localStorage.getItem(RENDERER_BACKEND_STORAGE_KEY) === "webgpu" ? "webgpu" : "webgl"
  );
  const [rendererSwitching, setRendererSwitching] = useState(false);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [project, setProject] = useState<ProjectRecord>();
  const [scenes, setScenes] = useState<SceneSnapshot[]>([]);
  const [activeScene, setActiveScene] = useState<SceneSnapshot>();
  const [sceneName, setSceneName] = useState("未命名场景");
  const [selected, setSelected] = useState<LoadedSceneModel>();
  const [measurements, setMeasurements] = useState<MeasurementState[]>([]);
  const [revision, setRevision] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [rvtConversionMode, setRvtConversionMode] = useState<RvtConversionMode>("native-glb");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("就绪");
  const [error, setError] = useState<string>();
  const [measureEnabled, setMeasureEnabled] = useState(false);
  const [annotationEnabled, setAnnotationEnabled] = useState(false);
  const [annotations, setAnnotations] = useState<SceneAnnotationState[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string>();
  const [selectedSpace, setSelectedSpace] = useState<BimSpaceRecord>();
  const [transformMode, setTransformMode] = useState<TransformMode>("translate");
  const [selectionScope, setSelectionScope] = useState<SelectionScope>("model");
  const [navigationMode, setNavigationMode] = useState<NavigationMode>("orbit");
  const [measureMode, setMeasureMode] = useState<MeasureMode>("distance");
  const [route, setRoute] = useState<AppRoute>(() => readRoute());
  const [avatarVisible, setAvatarVisible] = useState(false);
  const [cameraInfo, setCameraInfo] = useState<CameraState>();
  const [pointerInfo, setPointerInfo] = useState<PointerInfo>();
  const [infoEnabled, setInfoEnabled] = useState(false);
  const [frameRate, setFrameRate] = useState(0);
  const [weather, setWeather] = useState<WeatherMode>("sunny");
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [lighting, setLighting] = useState<GlobalLightingState>(DEFAULT_LIGHTING);
  const [sceneEnvironment, setSceneEnvironment] = useState<SceneEnvironmentState>(DEFAULT_ENVIRONMENT);
  const [postProcessing, setPostProcessing] = useState<ScenePostProcessingState>(DEFAULT_POST_PROCESSING);
  const [selectedLightId, setSelectedLightId] = useState("sun-default");
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [digitalTwinOpen, setDigitalTwinOpen] = useState(false);
  const [sceneDashboardOpen, setSceneDashboardOpen] = useState(false);
  const [xrPanelOpen, setXrPanelOpen] = useState(false);
  const [xrActiveMode, setXrActiveMode] = useState<"immersive-vr" | "immersive-ar">();
  const [xrCapabilities, setXrCapabilities] = useState<{ checking: boolean; secure: boolean; webxr: boolean; vr: boolean; ar: boolean }>({ checking: false, secure: window.isSecureContext, webxr: Boolean(navigator.xr), vr: false, ar: false });
  const [locale, setLocale] = useState<AppLocale>(() => readLocale());
  const [sceneAnimation, setSceneAnimation] = useState<SceneAnimationState>(DEFAULT_ANIMATION);
  const [animationTime, setAnimationTime] = useState(0);
  const [animationPlaying, setAnimationPlaying] = useState(false);
  const [animationOpen, setAnimationOpen] = useState(false);
  const [componentQuery, setComponentQuery] = useState("");
  const [componentLevel, setComponentLevel] = useState("");
  const [componentCategory, setComponentCategory] = useState("");
  const [floorExpansionByModel, setFloorExpansionByModel] = useState<Record<string, number>>({});
  const [clipping, setClippingState] = useState<ClippingState>(DEFAULT_CLIPPING);
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());
  const [directoryMode, setDirectoryMode] = useState<"components" | "spaces">("components");
  const [projectDialogMode, setProjectDialogMode] = useState<"create" | "rename">();
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDescription, setNewProjectDescription] = useState("");
  const primitiveColors = useRef(new Map<string, string>());

  const showError = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : "操作失败");
    window.setTimeout(() => setError(undefined), 5000);
  }, []);

  useEffect(() => storeLocale(locale), [locale]);

  function navigate(next: AppRoute, replace = false) {
    const path = next.view === "manager" || next.view === "optimizer"
      ? `/${next.view}`
      : `/${next.view}/${encodeURIComponent(next.sceneId ?? "new")}`;
    window.history[replace ? "replaceState" : "pushState"]({}, "", path);
    setRoute(next);
  }

  function changeRendererBackend(next: RendererBackend) {
    if (next === rendererBackend || rendererSwitching || !engine) return;
    if (next === "webgpu" && (!("gpu" in navigator) || !window.isSecureContext)) {
      showError(new Error("当前浏览器、显卡或访问地址不支持 WebGPU，请使用新版 Chrome/Edge 和 HTTPS"));
      return;
    }
    const snapshot = makeSnapshot();
    if (snapshot) rendererSnapshotRef.current = { scene: snapshot, readOnly: route.view !== "studio" };
    window.localStorage.setItem(RENDERER_BACKEND_STORAGE_KEY, next);
    setRendererBackend(next);
    setRendererSwitching(true);
    setMessage(`正在切换到 ${next === "webgpu" ? "WebGPU（实验）" : "WebGL"}`);
  }

  useEffect(() => {
    if (!viewportRef.current) return;
    let viewer: ViewerEngine | undefined;
    let cancelled = false;
    let revisionFrame: number | undefined;
    const requestRevision = () => {
      if (revisionFrame !== undefined) return;
      revisionFrame = window.requestAnimationFrame(() => {
        revisionFrame = undefined;
        setRevision((value) => value + 1);
      });
    };
    setRendererSwitching(true);
    void ViewerEngine.create(viewportRef.current, rendererBackend).then((created) => {
      if (cancelled) {
        created.dispose();
        return;
      }
      viewer = created;
      viewer.onSelectionChange = (model) => {
        setSelected(model);
        setSelectedSpace(undefined);
        setRevision((value) => value + 1);
      };
      viewer.onModelChange = requestRevision;
      viewer.onLightingChange = (nextLighting) => {
        setLighting(nextLighting);
        requestRevision();
      };
      viewer.onXRSessionChange = (mode) => setXrActiveMode(mode);
      viewer.onCollisionChange = requestRevision;
      viewer.onAnimationChange = (time, playing) => {
        setAnimationTime(time);
        setAnimationPlaying(playing);
      };
      viewer.onMeasurement = (measurement) => {
        setMeasurements((items) => [...items, measurement]);
        setRevision((value) => value + 1);
      };
      viewer.onMeasurementDraftChange = (hasStart, pointCount = 0, requiredPoints = 2) => {
        if (hasStart) setMessage(`已拾取 ${pointCount}/${requiredPoints} 个点，继续点击 · Esc 取消`);
        else if (viewer?.getNavigationMode() === "orbit") setMessage("测量工具就绪");
      };
      viewer.onAnnotationPlaced = (annotation) => {
        setAnnotations((items) => [...items.filter((item) => item.id !== annotation.id), annotation]);
        setSelectedAnnotationId(annotation.id);
        setMessage(`已添加“${annotation.name}”，可在右侧编辑内容和位置`);
        setRevision((value) => value + 1);
      };
      viewer.onAnnotationSelectionChange = (annotationId) => {
        setSelectedAnnotationId(annotationId);
        if (annotationId) setSelectedSpace(undefined);
        setRevision((value) => value + 1);
      };
      viewer.onClippingFacePicked = (state) => {
        setClippingState(state);
        setMessage("已按拾取面建立剖切面，可反向或重新拾取");
      };
      setEngine(viewer);
      setRendererSwitching(false);
      setMessage(`${viewer.getRendererBackend() === "webgpu" ? "WebGPU（实验）" : "WebGL"} 已启用`);
    }).catch((reason) => {
      if (cancelled) return;
      if (rendererBackend === "webgpu") {
        window.localStorage.setItem(RENDERER_BACKEND_STORAGE_KEY, "webgl");
        setRendererBackend("webgl");
        setMessage("WebGPU 不可用，正在恢复 WebGL");
      } else {
        setRendererSwitching(false);
      }
      showError(reason);
    });
    return () => {
      cancelled = true;
      if (revisionFrame !== undefined) window.cancelAnimationFrame(revisionFrame);
      viewer?.dispose();
      setEngine((current) => current === viewer ? undefined : current);
    };
  }, [rendererBackend, showError]);

  useEffect(() => {
    const pending = rendererSnapshotRef.current;
    if (!engine || !pending || !project) return;
    rendererSnapshotRef.current = undefined;
    void applyScene(pending.scene, false, project, pending.readOnly).then(() => {
      setMessage(`已切换到 ${engine.getRendererBackend() === "webgpu" ? "WebGPU（实验）" : "WebGL"}，场景状态已恢复`);
    });
  }, [engine]);

  useEffect(() => {
    if (!engine) return;
    if (infoEnabled) {
      engine.onCameraChange = setCameraInfo;
      engine.onPointerInfoChange = setPointerInfo;
      setCameraInfo(engine.getCameraState());
    } else {
      delete engine.onCameraChange;
      delete engine.onPointerInfoChange;
      setCameraInfo(undefined);
      setPointerInfo(undefined);
    }
    return () => {
      delete engine.onCameraChange;
      delete engine.onPointerInfoChange;
    };
  }, [engine, infoEnabled]);

  useEffect(() => {
    if (!xrPanelOpen || !engine) return;
    let cancelled = false;
    setXrCapabilities((current) => ({ ...current, checking: true, secure: window.isSecureContext, webxr: Boolean(navigator.xr) }));
    void Promise.all([engine.isXRSupported("immersive-vr"), engine.isXRSupported("immersive-ar")]).then(([vr, ar]) => {
      if (!cancelled) setXrCapabilities({ checking: false, secure: window.isSecureContext, webxr: Boolean(navigator.xr), vr, ar });
    });
    return () => { cancelled = true; };
  }, [engine, xrPanelOpen]);

  useEffect(() => {
    if (!engine || !infoEnabled) {
      setFrameRate(0);
      return;
    }
    const updateFrameRate = () => setFrameRate(Math.round(engine.getFrameRate()));
    updateFrameRate();
    const timer = window.setInterval(updateFrameRate, 500);
    return () => window.clearInterval(timer);
  }, [engine, infoEnabled]);

  useEffect(() => {
    if (window.location.pathname !== "/manager" && window.location.pathname !== "/optimizer" && !/^\/(studio|view|published)\//.test(window.location.pathname)) {
      window.history.replaceState({}, "", "/manager");
      setRoute({ view: "manager" });
    }
    const handlePopState = () => setRoute(readRoute());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const preventContextMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", preventContextMenu);
    return () => document.removeEventListener("contextmenu", preventContextMenu);
  }, []);

  useEffect(() => {
    void api.listProjects().then((items) => {
      setProjects(items);
      setProject((current) => current ?? items[0]);
    }).catch(showError);
  }, [showError]);

  function switchProject(next: ProjectRecord) {
    if (next.id === project?.id) return;
    engine?.clearSceneModels();
    setProject(next);
    setActiveScene(undefined);
    setSceneName("未命名场景");
    setSelected(undefined);
    setMeasurements([]);
    setAnnotations([]);
    setSelectedAnnotationId(undefined);
    setSelectedSpace(undefined);
    setExpandedModels(new Set());
    setDirectoryMode("components");
    if (route.view === "studio" || route.view === "view" || route.view === "published") navigate({ view: "manager" });
    setMessage(`已切换到项目“${next.name}”`);
    setRevision((value) => value + 1);
  }

  function switchProjectById(projectId: string) {
    const next = projects.find((item) => item.id === projectId);
    if (next) switchProject(next);
  }

  function openProjectDialog(mode: "create" | "rename") {
    setProjectDialogMode(mode);
    setNewProjectName(mode === "rename" ? project?.name ?? "" : "");
    setNewProjectDescription(mode === "rename" ? project?.description ?? "" : "");
  }

  async function submitProjectDialog() {
    const name = newProjectName.trim();
    if (!name) return;
    setBusy(true);
    try {
      if (projectDialogMode === "rename" && project) {
        const updated = await api.updateProject(project.id, name, newProjectDescription.trim());
        setProjects((items) => items.map((item) => item.id === updated.id ? updated : item));
        setProject(updated);
        setMessage(`项目已重命名为“${updated.name}”`);
      } else {
        const created = await api.createProject(name, newProjectDescription.trim());
        setProjects((items) => [...items, created]);
        switchProject(created);
        setMessage(`项目“${created.name}”已创建`);
      }
      setNewProjectName("");
      setNewProjectDescription("");
      setProjectDialogMode(undefined);
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function deleteCurrentProject() {
    if (!project || !window.confirm(`确定删除项目“${project.name}”吗？\n项目内的模型文件和场景也会被删除，此操作不可撤销。`)) return;
    setBusy(true);
    try {
      await api.deleteProject(project.id);
      const remaining = projects.filter((item) => item.id !== project.id);
      setProjects(remaining);
      engine?.clearSceneModels();
      setActiveScene(undefined);
      setScenes([]);
      setSelected(undefined);
      setMeasurements([]);
      setAnnotations([]);
      setProject(remaining[0]);
      setSceneName("未命名场景");
      if (route.view === "studio" || route.view === "view" || route.view === "published") navigate({ view: "manager" });
      setMessage(`项目“${project.name}”已删除`);
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  }

  const refreshProject = useCallback(async () => {
    if (!project) return;
    const next = await api.getProject(project.id);
    setProject(next);
    setProjects((items) => items.map((item) => item.id === next.id ? next : item));
  }, [project?.id]);

  useEffect(() => {
    if (!project) return;
    void api.listScenes(project.id).then((items) => setScenes(sortScenesByTime(items))).catch(showError);
    const timer = window.setInterval(() => void refreshProject().catch(showError), 2500);
    return () => window.clearInterval(timer);
  }, [project?.id, refreshProject, showError]);

  useEffect(() => {
    if (route.view !== "studio" || !route.sceneId || !engine || activeScene?.id === route.sceneId) return;
    const sceneId = route.sceneId;
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.getSceneForBrowse(sceneId);
        if (cancelled) return;
        setProject(result.project);
        setProjects((items) => items.some((item) => item.id === result.project.id)
          ? items.map((item) => item.id === result.project.id ? result.project : item)
          : [...items, result.project]);
        await applyScene(result.scene, false, result.project, false);
      } catch (reason) {
        if (!cancelled) showError(reason);
      }
    })();
    return () => { cancelled = true; };
  }, [route.view, route.sceneId, engine, activeScene?.id, showError]);

  useEffect(() => {
    if ((route.view !== "view" && route.view !== "published") || !route.sceneId || !engine) return;
    const sceneId = route.sceneId;
    const browseView = route.view;
    let cancelled = false;
    void (async () => {
      try {
        const result = browseView === "published"
          ? await api.getPublishedScene(sceneId).then(async (publication) => ({
            scene: publication.snapshot,
            project: await api.getProject(publication.projectId)
          }))
          : await api.getSceneForBrowse(sceneId);
        if (cancelled) return;
        setProject(result.project);
        setProjects((items) => items.some((item) => item.id === result.project.id)
          ? items.map((item) => item.id === result.project.id ? result.project : item)
          : [...items, result.project]);
        await applyScene(result.scene, false, result.project, true);
        if (!cancelled) setMessage(browseView === "published" ? "正在浏览已发布版本" : "正在浏览当前保存版本");
      } catch (reason) {
        if (!cancelled) showError(reason);
      }
    })();
    return () => { cancelled = true; };
  }, [route.view, route.sceneId, engine]);

  const loadedModels = useMemo(() => engine?.listModels() ?? [], [engine, revision]);
  const scenePrimitives = loadedModels.filter((item) => item.kind === "primitive");
  const selectedTransform = selected && engine ? engine.getSelectionTransform() : undefined;
  const selectionName = selected && engine ? engine.getSelectionName() : "";
  const selectionVisible = selected && engine ? engine.getSelectionVisible() : false;
  const selectionOpacity = selected && engine ? engine.getSelectionOpacity() : 1;
  const selectionColor = selected && engine ? engine.getSelectionColor() : "#d4a84f";
  const selectionMaterial = useMemo(() => selected && engine ? engine.getSelectionMaterial() : {}, [engine, selected, revision]);
  const selectionProperties = useMemo(() => engine?.getSelectionProperties() ?? {}, [engine, selected, revision]);
  const selectedLayerId = engine?.getSelectedLayerId();
  const selectedComponent = engine?.getSelectedComponentRecord();
  const selectionLocked = engine?.isSelectionLocked() ?? false;
  const componentFacets = useMemo(() => engine?.getComponentFacets() ?? { levels: [], categories: [], specialties: [] }, [engine, revision]);
  const floorStates = useMemo(() => engine?.getFloorStates() ?? [], [engine, revision]);
  const floorStatesByModel = useMemo(() => {
    const grouped = new Map<string, SceneFloorState[]>();
    for (const floor of floorStates) grouped.set(floor.modelId, [...(grouped.get(floor.modelId) ?? []), floor]);
    return grouped;
  }, [floorStates]);
  const selectedLight = lighting.lights?.find((light) => light.id === selectedLightId) ?? lighting.lights?.[0];
  const componentResults = useMemo(() => engine?.searchComponents({ query: componentQuery, level: componentLevel, category: componentCategory }, 80) ?? [], [engine, revision, componentQuery, componentLevel, componentCategory]);
  const componentSearchActive = Boolean(componentQuery.trim() || componentLevel || componentCategory);
  const collisions = useMemo(() => engine?.getCollisionRecords() ?? [], [engine, revision]);
  const spaces = useMemo(() => engine?.getSpaces() ?? [], [engine, revision]);
  const selectedAnnotation = annotations.find((item) => item.id === selectedAnnotationId);
  const clippingRange = engine?.getClippingRange(clipping.axis) ?? { min: -10, max: 10 };
  const clippingSceneBounds = engine?.getClippingBounds() ?? { min: { x: -10, y: -10, z: -10 }, max: { x: 10, y: 10, z: 10 } };
  const explosionFactor = selected && engine ? engine.getExplosionFactor(selected.id) : 0;
  const explosionMode = selected && engine ? engine.getExplosionMode(selected.id) : "radial";
  const sceneStatistics = useMemo(
    () => infoEnabled && engine ? engine.getSceneStatistics() : { modelCount: 0, primitiveCount: 0, componentCount: 0, triangleCount: 0, vertexCount: 0 },
    [engine, revision, infoEnabled]
  );

  async function loadModel(model: ModelRecord): Promise<LoadedSceneModel | undefined> {
    if (!engine) return;
    if (model.status !== "ready" || !model.manifest) {
      setMessage(model.message);
      return;
    }
    setBusy(true);
    setMessage(`正在加载 ${model.name}`);
    try {
      const loaded = await engine.loadManifest(model.manifest);
      engine.select(model.id);
      setRevision((value) => value + 1);
      setMessage(`${model.name} 已加载`);
      return loaded;
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function uploadModels(files?: FileList | File[]) {
    if (!files?.length || !project) return;
    setUploading(true);
    try {
      for (const [index, file] of [...files].entries()) {
        setMessage(`正在上传 ${file.name}（${index + 1}/${files.length}）`);
        await api.uploadModel(project.id, file, rvtConversionMode);
      }
      setMessage(`${files.length} 个模型上传完成，等待处理`);
      await refreshProject();
    } catch (reason) {
      showError(reason);
    } finally {
      setUploading(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  }

  async function deleteModel(model: ModelRecord) {
    if (!project) return;
    engine?.removeModel(model.id);
    try {
      await api.deleteModel(project.id, model.id);
      await refreshProject();
      setMessage(`${model.name} 已删除`);
      setRevision((value) => value + 1);
    } catch (reason) {
      showError(reason);
    }
  }

  function addBox() {
    if (!engine) return;
    const id = crypto.randomUUID();
    const color = "#d4a84f";
    primitiveColors.current.set(id, color);
    engine.createBox(id, `立方体 ${loadedModels.filter((item) => item.kind === "primitive").length + 1}`, color);
    setRevision((value) => value + 1);
  }

  function deletePrimitive(id: string) {
    engine?.removeModel(id);
    primitiveColors.current.delete(id);
    setRevision((value) => value + 1);
    setMessage("正方体已从场景删除");
  }

  function deleteMeasurement(id: string) {
    engine?.deleteMeasurement(id);
    setMeasurements((items) => items.filter((measurement) => measurement.id !== id));
    setMessage("标尺已从场景删除");
  }

  function toggleAnnotationPlacement() {
    if (!engine) return;
    const next = !annotationEnabled;
    setAnnotationEnabled(next);
    engine.setAnnotationPlacementEnabled(next);
    if (next) {
      setMeasureEnabled(false);
      engine.setMeasureEnabled(false);
      setNavigationMode("orbit");
      engine.setNavigationMode("orbit");
    }
    setMessage(next ? "标签工具：点击模型表面或地面放置标签" : "已退出标签放置");
  }

  function updateAnnotation(id: string, patch: Partial<Omit<SceneAnnotationState, "id">>) {
    const next = engine?.updateAnnotation(id, patch);
    if (!next) return;
    setAnnotations((items) => items.map((item) => item.id === id ? next : item));
    setRevision((value) => value + 1);
  }

  function updateAnnotationPosition(annotation: SceneAnnotationState, axis: "x" | "y" | "z", rawValue: string) {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || annotation.locked) return;
    updateAnnotation(annotation.id, { position: { ...annotation.position, [axis]: value } });
  }

  function deleteAnnotation(id: string) {
    const annotation = annotations.find((item) => item.id === id);
    if (!annotation || annotation.locked) return;
    engine?.removeAnnotation(id);
    setAnnotations((items) => items.filter((item) => item.id !== id));
    setSelectedAnnotationId(undefined);
    setMessage("标签已从场景删除");
  }

  function changeNavigation(mode: NavigationMode) {
    engine?.setNavigationMode(mode);
    setNavigationMode(mode);
    setMeasureEnabled(false);
    engine?.setMeasureEnabled(false);
    setAnnotationEnabled(false);
    engine?.setAnnotationPlacementEnabled(false);
  }

  function changeTransform(mode: TransformMode) {
    engine?.setTransformMode(mode);
    setTransformMode(mode);
  }

  function toggleMeasurement() {
    const next = !measureEnabled;
    setMeasureEnabled(next);
    engine?.setMeasureEnabled(next, measureMode);
    if (next) {
      setAnnotationEnabled(false);
      engine?.setAnnotationPlacementEnabled(false);
    }
    setMessage(next ? "依次点击两个位置进行测量" : "已退出测量");
  }

  function changeMeasureMode(mode: MeasureMode) {
    setMeasureMode(mode);
    setMeasureEnabled(true);
    engine?.setMeasureEnabled(true, mode);
    setAnnotationEnabled(false);
    engine?.setAnnotationPlacementEnabled(false);
    setMessage(mode === "elevation"
      ? "标高测量：点击模型上的位置"
      : mode === "angle"
        ? "角度测量：依次点击顶点、第一条边、第二条边"
        : mode === "minimum"
          ? "最小距离：依次点击两个构件"
          : "距离测量：依次点击起点和终点");
  }

  function focusComponent(record: ComponentRecord) {
    setExpandedModels((current) => new Set(current).add(record.modelId));
    engine?.focusComponent(record);
    setMessage(`已定位构件“${record.name}”`);
    setRevision((value) => value + 1);
  }

  function updateClipping(patch: Partial<ClippingState>) {
    if (!engine) return;
    const next = { ...clipping, ...patch };
    if (patch.axis && patch.offset === undefined) {
      const range = engine.getClippingRange(patch.axis);
      next.offset = (range.min + range.max) / 2;
    }
    setClippingState(next);
    engine.setClipping(next);
  }

  function changeClippingMode(mode: NonNullable<ClippingState["mode"]>) {
    if (!engine) return;
    const range = engine.getClippingRange(clipping.axis);
    const next: ClippingState = {
      ...clipping,
      enabled: true,
      mode,
      ...(mode === "axis" ? { offset: (range.min + range.max) / 2 } : {}),
      ...(mode === "box" ? { box: clipping.box ?? engine.getClippingBounds(), showHelper: true } : {})
    };
    if (mode === "face") delete next.face;
    setClippingState(next);
    engine.setClipping(next);
    setMeasureEnabled(false);
    engine.setMeasureEnabled(false);
    setAnnotationEnabled(false);
    engine.setAnnotationPlacementEnabled(false);
    setMessage(mode === "box" ? "剖切盒已开启，调整六个边界" : mode === "face" ? "点击模型表面建立剖切面" : "轴向剖切已开启");
  }

  function updateClippingBox(axis: "x" | "y" | "z", side: "min" | "max", value: number) {
    if (!engine) return;
    const bounds = clipping.box ?? engine.getClippingBounds();
    const opposite = side === "min" ? bounds.max[axis] : bounds.min[axis];
    const safeValue = side === "min" ? Math.min(value, opposite - 0.001) : Math.max(value, opposite + 0.001);
    updateClipping({ box: { ...bounds, [side]: { ...bounds[side], [axis]: safeValue } } });
  }

  function toggleClipping() {
    if (!engine) return;
    const enabled = !clipping.enabled;
    const range = engine.getClippingRange(clipping.axis);
    updateClipping({ enabled, mode: clipping.mode ?? "axis", ...(enabled ? { offset: (range.min + range.max) / 2 } : {}) });
    if (enabled) {
      setMeasureEnabled(false);
      engine.setMeasureEnabled(false);
      setAnnotationEnabled(false);
      engine.setAnnotationPlacementEnabled(false);
    }
    setMessage(enabled ? "剖切工具已开启" : "已关闭剖切");
  }

  function updateExplosion(factor: number, mode: ExplosionMode = explosionMode) {
    if (!engine || !selected || selected.kind !== "model") return;
    engine.setExplosion(selected.id, factor, mode);
    setRevision((value) => value + 1);
    setMessage(factor > 0 ? `${tr(locale, "模型爆炸", "Model explosion")} ${Math.round(factor * 100)}% · ${explosionModeName(mode, locale)}` : tr(locale, "已恢复模型组合", "Model restored"));
  }

  function updateSelectedTransform(group: keyof ModelTransform, axis: "x" | "y" | "z", rawValue: string) {
    if (!engine || !selected) return;
    const current = engine.getSelectionTransform();
    if (!current) return;
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric)) return;
    const value = group === "rotation" ? numeric * Math.PI / 180 : numeric;
    const transform: ModelTransform = {
      position: { ...current.position },
      rotation: { ...current.rotation },
      scale: { ...current.scale },
      [group]: { ...current[group], [axis]: value }
    };
    engine.applySelectionTransform(transform);
    setRevision((item) => item + 1);
  }

  function changeWeather(mode: WeatherMode) {
    setWeather(mode);
    engine?.setWeather(mode);
    setMessage(`天气已切换为${mode === "sunny" ? "晴天" : mode === "rain" ? "下雨" : "下雪"}`);
  }

  function changeLighting(next: GlobalLightingState) {
    setLighting(next);
    engine?.setGlobalLighting(next);
  }

  function changeSceneEnvironment(next: SceneEnvironmentState) {
    setSceneEnvironment(next);
    engine?.setSceneEnvironment(next);
  }

  function changePostProcessing(next: ScenePostProcessingState) {
    setPostProcessing(next);
    engine?.setPostProcessing(next);
  }

  async function uploadEnvironmentMap(file?: File) {
    if (!file || !project) return;
    setBusy(true);
    try {
      const uploaded = await api.uploadEnvironmentMap(project.id, file);
      changeSceneEnvironment({ ...sceneEnvironment, environmentMapUrl: uploaded.url, environmentMapName: uploaded.name });
      setMessage(`环境贴图“${uploaded.name}”已应用`);
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
      if (environmentMapRef.current) environmentMapRef.current.value = "";
    }
  }

  function updateLight(id: string, patch: Partial<SceneLightState>) {
    changeLighting({ ...lighting, lights: (lighting.lights ?? []).map((light) => light.id === id ? { ...light, ...patch } : light) });
  }

  function addLight(type: SceneLightState["type"]) {
    const id = crypto.randomUUID();
    const light: SceneLightState = {
      id,
      name: `${lightTypeName(type)} ${(lighting.lights?.length ?? 0) + 1}`,
      type,
      enabled: true,
      color: "#ffffff",
      intensity: type === "ambient" ? 0.3 : 1,
      position: { x: 4, y: 6, z: 4 },
      target: { x: 0, y: 0, z: 0 },
      castShadow: ["directional", "point", "spot"].includes(type)
    };
    changeLighting({ ...lighting, lights: [...(lighting.lights ?? []), light] });
    setSelectedLightId(id);
  }

  function removeLight(id: string) {
    changeLighting({ ...lighting, lights: (lighting.lights ?? []).filter((light) => light.id !== id) });
    setSelectedLightId(lighting.lights?.find((light) => light.id !== id)?.id ?? "");
  }

  function updateSelectionMaterial(patch: SceneMaterialState) {
    engine?.setSelectionMaterial(patch);
    setRevision((value) => value + 1);
  }

  function updateFloor(state: SceneFloorState) {
    engine?.setFloorState(state.modelId, state.level, state.visible, state.expansion);
    setRevision((value) => value + 1);
  }

  function expandFloors(modelId: string, value: number) {
    setFloorExpansionByModel((current) => ({ ...current, [modelId]: value }));
    (floorStatesByModel.get(modelId) ?? []).forEach((state, index) => engine?.setFloorState(modelId, state.level, state.visible, index * value));
    setRevision((item) => item + 1);
  }

  function selectLightForTransform(light: SceneLightState, handle: "position" | "target") {
    setSelectedLightId(light.id);
    setEnvironmentOpen(true);
    setSelected(undefined);
    const selectedHandle = engine?.selectSceneLight(light.id, handle) ?? false;
    if (selectedHandle) {
      setTransformMode("translate");
      setMessage(handle === "position" ? tr(locale, "拖动坐标轴移动光源", "Drag the gizmo to move the light") : tr(locale, "拖动目标点改变光照方向", "Drag the target to change light direction"));
    }
  }

  async function startXR(mode: "immersive-vr" | "immersive-ar") {
    try {
      await engine?.startXR(mode);
      setXrActiveMode(mode);
      setMessage(mode === "immersive-vr" ? "已进入 VR" : "已进入 AR");
    } catch (reason) {
      showError(reason);
    }
  }

  function updateSceneAnimation(next: SceneAnimationState) {
    setSceneAnimation(next);
    engine?.setSceneAnimation(next);
  }

  function addCameraKeyframe() {
    if (!engine) return;
    const frame = { id: crypto.randomUUID(), time: animationTime, camera: engine.getCameraState() };
    updateSceneAnimation({
      ...sceneAnimation,
      camera: [...sceneAnimation.camera.filter((item) => Math.abs(item.time - animationTime) > 0.001), frame]
        .sort((a, b) => a.time - b.time)
    });
    setMessage(`已在 ${animationTime.toFixed(1)} 秒记录相机关键帧`);
  }

  function addModelKeyframe() {
    if (!engine || !selected) return;
    const transform = engine.getModelTransform(selected.id);
    if (!transform) return;
    const frame = { id: crypto.randomUUID(), time: animationTime, modelId: selected.id, transform };
    updateSceneAnimation({
      ...sceneAnimation,
      models: [...sceneAnimation.models.filter((item) => item.modelId !== selected.id || Math.abs(item.time - animationTime) > 0.001), frame]
        .sort((a, b) => a.time - b.time)
    });
    setMessage(`已为“${selected.name}”记录 ${animationTime.toFixed(1)} 秒关键帧`);
  }

  function toggleSceneAnimation() {
    if (!engine) return;
    if (animationPlaying) engine.pauseSceneAnimation();
    else engine.playSceneAnimation();
  }

  function deleteKeyframe(id: string) {
    updateSceneAnimation({
      ...sceneAnimation,
      camera: sceneAnimation.camera.filter((item) => item.id !== id),
      models: sceneAnimation.models.filter((item) => item.id !== id)
    });
  }

  function makeSnapshot(): SceneSnapshot | undefined {
    if (!engine || !project) return;
    const now = new Date().toISOString();
    const currentModels = engine.listModels();
    return {
      schemaVersion: 1,
      id: activeScene?.id ?? crypto.randomUUID(),
      projectId: project.id,
      name: sceneName.trim() || "未命名场景",
      camera: engine.getCameraState(),
      models: currentModels.filter((item) => item.kind === "model").flatMap((item) => {
        const transform = engine.getModelTransform(item.id);
        const source = project.models.find((model) => model.id === item.id);
        const colorOverride = engine.getModelColorOverride(item.id);
        const material = engine.getModelMaterialOverride(item.id);
        return transform ? [{
          modelId: item.id,
          name: item.name,
          ...(source ? { sourceName: source.name, sourceFormat: source.format } : {}),
          visible: item.visible,
          locked: engine.isModelLocked(item.id),
          opacity: item.opacity,
          ...(colorOverride ? { colorOverride } : {}),
          ...(material ? { material } : {}),
          transform,
          collisionEnabled: engine.isCollisionEnabled(item.id),
          explosionFactor: engine.getExplosionFactor(item.id),
          explosionMode: engine.getExplosionMode(item.id),
          ...(engine.hasAnimation(item.id) ? { animationEnabled: engine.isAnimationEnabled(item.id) } : {}),
          layers: engine.getLayerStates(item.id)
        }] : [];
      }),
      primitives: currentModels.filter((item) => item.kind === "primitive").flatMap((item) => {
        const state = engine.primitiveState(item.id, primitiveColors.current.get(item.id) ?? "#d4a84f");
        return state ? [state] : [];
      }),
      measurements,
      annotations: engine.listAnnotations(),
      clipping: engine.getClippingState(),
      weather: engine.getWeather(),
      lighting: engine.getGlobalLighting(),
      environment: engine.getSceneEnvironment(),
      floors: engine.getFloorStates(),
      postProcessing: engine.getPostProcessing(),
      animation: engine.getSceneAnimation(),
      ...(selected ? { selectedModelId: selected.id } : {}),
      ...(selectedLayerId ? { selectedLayerId } : {}),
      ...(selectedAnnotationId ? { selectedAnnotationId } : {}),
      ...(activeScene?.publishedAt ? { publishedAt: activeScene.publishedAt } : {}),
      createdAt: activeScene?.createdAt ?? now,
      updatedAt: now
    };
  }

  async function saveScene() {
    const snapshot = makeSnapshot();
    if (!snapshot) return;
    setBusy(true);
    try {
      const saved = await api.saveScene(snapshot);
      setActiveScene(saved);
      setSceneName(saved.name);
      setScenes((items) => sortScenesByTime([saved, ...items.filter((item) => item.id !== saved.id)]));
      setMessage(`场景“${saved.name}”已保存`);
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function commitSceneName(): Promise<boolean> {
    const name = sceneName.trim();
    if (!activeScene || !project) return true;
    if (!name) {
      setSceneName(activeScene.name);
      showError(new Error("场景名称不能为空"));
      return false;
    }
    if (name === activeScene.name) {
      if (sceneName !== name) setSceneName(name);
      return true;
    }
    if (sceneNameCommitRef.current) return sceneNameCommitRef.current;
    const pending = api.renameScene(project.id, activeScene.id, name)
      .then((saved) => {
        setActiveScene(saved);
        setSceneName(saved.name);
        setScenes((items) => sortScenesByTime([saved, ...items.filter((item) => item.id !== saved.id)]));
        setMessage(`场景已重命名为“${saved.name}”`);
        return true;
      })
      .catch((reason) => {
        setSceneName(activeScene.name);
        showError(reason);
        return false;
      })
      .finally(() => {
        sceneNameCommitRef.current = undefined;
      });
    sceneNameCommitRef.current = pending;
    return pending;
  }

  async function applyScene(scene: SceneSnapshot, updateRoute = true, sceneProject = project, readOnly = false) {
    if (!engine || !sceneProject) return;
    setBusy(true);
    if (updateRoute) navigate({ view: "studio", sceneId: scene.id });
    try {
      engine.setReadOnly(readOnly);
      engine.clearSceneModels();
      primitiveColors.current.clear();
      setSelected(undefined);
      setMeasurements([]);
      setAnnotations([]);
      setSelectedAnnotationId(undefined);
      setSelectedSpace(undefined);
      for (const item of scene.models) {
        const record = sceneProject.models.find((model) => model.id === item.modelId);
        if (record) await loadModel(record);
        engine.applyModelState(item.modelId, item);
        engine.rename(item.modelId, item.name);
      }
      for (const item of engine.listModels().filter((model) => model.kind === "primitive")) engine.removeModel(item.id);
      for (const primitive of scene.primitives) {
        primitiveColors.current.set(primitive.modelId, primitive.color);
        engine.createBox(primitive.modelId, primitive.name, primitive.color);
        engine.applyModelState(primitive.modelId, primitive);
      }
      engine.clearMeasurements();
      for (const measurement of scene.measurements) engine.addMeasurementVisual(measurement);
      setMeasurements(scene.measurements);
      for (const annotation of scene.annotations ?? []) engine.addAnnotation(annotation);
      setAnnotations(engine.listAnnotations());
      engine.applyCamera(scene.camera);
      const nextWeather = scene.weather ?? "sunny";
      const savedLights = scene.lighting?.lights?.filter((light) => light.id !== "ambient-default");
      const nextLighting: GlobalLightingState = { ...DEFAULT_LIGHTING, ...scene.lighting, lights: savedLights?.length ? savedLights : (DEFAULT_LIGHTING.lights ?? []) };
      const nextEnvironment: SceneEnvironmentState = { ...DEFAULT_ENVIRONMENT, ...scene.environment };
      const nextAnimation = scene.animation ?? DEFAULT_ANIMATION;
      const nextPostProcessing = { ...DEFAULT_POST_PROCESSING, ...scene.postProcessing };
      engine.setWeather(nextWeather);
      engine.setGlobalLighting(nextLighting);
      engine.setSceneEnvironment(nextEnvironment);
      engine.applyFloorStates(scene.floors);
      engine.setPostProcessing(nextPostProcessing);
      engine.setSceneAnimation(nextAnimation);
      engine.seekSceneAnimation(0);
      setWeather(nextWeather);
      setLighting(nextLighting);
      setSceneEnvironment(nextEnvironment);
      setSceneAnimation(nextAnimation);
      setPostProcessing(nextPostProcessing);
      setAnimationTime(0);
      setAnimationPlaying(false);
      const nextClipping = scene.clipping ?? DEFAULT_CLIPPING;
      engine.setClipping(nextClipping);
      setClippingState(nextClipping);
      if (scene.selectedAnnotationId) engine.selectAnnotation(scene.selectedAnnotationId);
      else if (scene.selectedModelId && scene.selectedLayerId) engine.selectLayer(scene.selectedModelId, scene.selectedLayerId);
      else engine.select(scene.selectedModelId);
      setNavigationMode(scene.camera.mode);
      setAvatarVisible(scene.camera.avatarVisible ?? false);
      setActiveScene(scene);
      setSceneName(scene.name);
      setMessage(`场景“${scene.name}”已恢复`);
      setRevision((value) => value + 1);
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function createScene(name: string) {
    if (!engine || !project) return;
    engine.clearSceneModels();
    engine.setClipping(DEFAULT_CLIPPING);
    engine.setWeather("sunny");
    engine.setGlobalLighting(DEFAULT_LIGHTING);
    engine.setSceneEnvironment(DEFAULT_ENVIRONMENT);
    engine.setPostProcessing(DEFAULT_POST_PROCESSING);
    engine.setSceneAnimation(DEFAULT_ANIMATION);
    engine.seekSceneAnimation(0);
    setClippingState(DEFAULT_CLIPPING);
    primitiveColors.current.clear();
    setMeasurements([]);
    setAnnotations([]);
    setSelectedAnnotationId(undefined);
    setSelected(undefined);
    const now = new Date().toISOString();
    const scene: SceneSnapshot = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      projectId: project.id,
      name,
      camera: {
        position: { x: 12, y: 8, z: 12 },
        target: { x: 0, y: 1, z: 0 },
        mode: "orbit"
      },
      models: [],
      primitives: [],
      measurements: [],
      annotations: [],
      weather: "sunny",
      lighting: DEFAULT_LIGHTING,
      environment: DEFAULT_ENVIRONMENT,
      postProcessing: DEFAULT_POST_PROCESSING,
      animation: DEFAULT_ANIMATION,
      createdAt: now,
      updatedAt: now
    };
    const saved = await api.saveScene(scene);
    engine.applyCamera(saved.camera);
    setActiveScene(saved);
    setSceneName(saved.name);
    setScenes((items) => sortScenesByTime([saved, ...items]));
    setNavigationMode("orbit");
    setAvatarVisible(false);
    setWeather("sunny");
    setLighting(DEFAULT_LIGHTING);
    setSceneEnvironment(DEFAULT_ENVIRONMENT);
    setPostProcessing(DEFAULT_POST_PROCESSING);
    setSceneAnimation(DEFAULT_ANIMATION);
    setAnimationTime(0);
    setAnimationPlaying(false);
    navigate({ view: "studio", sceneId: saved.id });
    setMessage(`场景“${saved.name}”已创建，可加载多个模型`);
    setRevision((value) => value + 1);
  }

  function exportSceneConfig(scene?: SceneSnapshot) {
    const snapshot = scene ?? makeSnapshot();
    if (!snapshot) return;
    exportLooseScene(snapshot);
    setMessage("已导出零散场景配置；模型资源仍由项目资源库管理");
  }

  async function exportSingleFileScene(scene?: SceneSnapshot) {
    const snapshot = scene ?? makeSnapshot();
    if (!snapshot || !project) return;
    setBusy(true);
    try {
      await exportScenePackage(snapshot, project.models);
      setMessage("已导出单文件场景（.bimscene，包含可浏览模型资源）");
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function exportGlbScene(scene?: SceneSnapshot) {
    if (!engine) return;
    setBusy(true);
    try {
      if (scene && activeScene?.id !== scene.id) await applyScene(scene, false);
      const data = await engine.exportSceneGlb();
      exportGlbFile(data, scene?.name ?? sceneName);
      setMessage("已导出 GLB 单文件（当前可见模型与基础元素已合并）");
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function importScene(file?: File) {
    if (!file || !project) return;
    setBusy(true);
    try {
      const importedFile = await readSceneFile(file);
      const parsed = importedFile.scene;
      let targetProject = project;
      const modelIdMap = new Map<string, string>();

      for (const asset of importedFile.assets) {
        const existing = targetProject.models.find((model) => model.id === asset.originalModelId && model.status === "ready")
          ?? targetProject.models.find((model) => model.name === asset.sourceName && model.format === asset.sourceFormat && model.status === "ready");
        if (existing) {
          modelIdMap.set(asset.originalModelId, existing.id);
          continue;
        }
        const uploaded = await api.uploadModel(targetProject.id, asset.file);
        targetProject = await waitForModelReady(targetProject.id, uploaded.id);
        modelIdMap.set(asset.originalModelId, uploaded.id);
      }

      const reboundModels = parsed.models.map((item) => {
        const mappedId = modelIdMap.get(item.modelId);
        const target = targetProject.models.find((model) => model.id === mappedId)
          ?? targetProject.models.find((model) => model.id === item.modelId)
          ?? targetProject.models.find((model) => model.name === item.sourceName && model.format === item.sourceFormat);
        if (!target) return item;
        modelIdMap.set(item.modelId, target.id);
        return { ...item, modelId: target.id, sourceName: target.name, sourceFormat: target.format };
      });
      const missingModels = reboundModels.filter((item) => !targetProject.models.some((model) => model.id === item.modelId));
      const rebound: SceneSnapshot = {
        ...parsed,
        models: reboundModels,
        ...(parsed.animation ? {
          animation: {
            ...parsed.animation,
            models: parsed.animation.models.map((frame) => ({
              ...frame,
              modelId: modelIdMap.get(frame.modelId) ?? frame.modelId
            }))
          }
        } : {}),
        ...(parsed.annotations ? {
          annotations: parsed.annotations.map((annotation) => ({
            ...annotation,
            ...(annotation.modelId ? { modelId: modelIdMap.get(annotation.modelId) ?? annotation.modelId } : {})
          }))
        } : {}),
        ...(parsed.floors ? {
          floors: parsed.floors.map((floor) => ({
            ...floor,
            modelId: modelIdMap.get(floor.modelId) ?? floor.modelId
          }))
        } : {}),
        ...(parsed.selectedModelId ? { selectedModelId: modelIdMap.get(parsed.selectedModelId) ?? parsed.selectedModelId } : {})
      };
      const imported = await api.importScene(project.id, rebound);
      setProject(targetProject);
      setProjects((items) => items.map((item) => item.id === targetProject.id ? targetProject : item));
      setScenes((items) => sortScenesByTime([imported, ...items]));
      await applyScene(imported, true, targetProject);
      if (missingModels.length > 0) {
        setMessage(`场景已导入，但缺少 ${missingModels.length} 个模型资源；请上传同名文件后重新打开`);
      } else {
        setMessage(importedFile.mode === "package" ? "单文件场景及模型资源已导入" : "零散场景配置已导入");
      }
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
      if (importRef.current) importRef.current.value = "";
    }
  }

  async function deleteScene(scene: SceneSnapshot) {
    if (!project || !window.confirm(`确定删除场景“${scene.name}”吗？`)) return;
    try {
      await api.deleteScene(project.id, scene.id);
      setScenes((items) => items.filter((item) => item.id !== scene.id));
      if (activeScene?.id === scene.id) setActiveScene(undefined);
      if ((route.view === "studio" || route.view === "view" || route.view === "published") && route.sceneId === scene.id) navigate({ view: "manager" });
      setMessage(`场景“${scene.name}”已删除`);
    } catch (reason) {
      showError(reason);
    }
  }

  async function copyScene(scene: SceneSnapshot) {
    if (!project) return;
    try {
      const copy = await api.copyScene(project.id, scene.id);
      setScenes((items) => sortScenesByTime([copy, ...items]));
      setMessage(`已复制为“${copy.name}”`);
    } catch (reason) {
      showError(reason);
    }
  }

  async function renameScene(scene: SceneSnapshot, name: string) {
    if (!project) return;
    try {
      const updated = await api.renameScene(project.id, scene.id, name);
      setScenes((items) => sortScenesByTime(items.map((item) => item.id === updated.id ? updated : item)));
      if (activeScene?.id === updated.id) {
        setActiveScene(updated);
        setSceneName(updated.name);
      }
      setMessage(`场景已重命名为“${updated.name}”`);
    } catch (reason) {
      showError(reason);
    }
  }

  async function publishScene(scene: SceneSnapshot) {
    if (!project) return;
    try {
      const publication = await api.publishScene(project.id, scene.id);
      setScenes((items) => sortScenesByTime(items.map((item) => item.id === scene.id ? publication.snapshot : item)));
      if (activeScene?.id === scene.id) setActiveScene(publication.snapshot);
      setMessage(`场景“${scene.name}”已发布`);
    } catch (reason) {
      showError(reason);
    }
  }

  async function unpublishScene(scene: SceneSnapshot) {
    if (!project || !window.confirm(`撤回场景“${scene.name}”的发布版本吗？`)) return;
    try {
      await api.unpublishScene(project.id, scene.id);
      const updated = { ...scene };
      delete updated.publishedAt;
      setScenes((items) => items.map((item) => item.id === scene.id ? updated : item));
      if (activeScene?.id === scene.id) setActiveScene(updated);
      setMessage(`场景“${scene.name}”已撤回发布`);
    } catch (reason) {
      showError(reason);
    }
  }

  function toggleModelTree(modelId: string) {
    setExpandedModels((current) => {
      const next = new Set(current);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  }

  return (
    <>
      {route.view === "optimizer" && <Suspense fallback={<div className="optimizer-loading"><LoaderCircle className="spin" size={25} />{tr(locale, "正在加载模型优化器", "Loading model optimizer")}</div>}><ModelOptimizer locale={locale} onBack={() => navigate({ view: "manager" })} /></Suspense>}
      {route.view === "manager" && (
        <SceneManager
          locale={locale}
          projects={projects}
          project={project}
          scenes={scenes}
          onProjectChange={switchProjectById}
          onCreateProject={() => openProjectDialog("create")}
          onRenameProject={() => openProjectDialog("rename")}
          onDeleteProject={() => void deleteCurrentProject()}
          onCreate={async (name) => { try { await createScene(name); } catch (reason) { showError(reason); } }}
          onOpen={applyScene}
          onCopy={copyScene}
          onRename={renameScene}
          onPublish={publishScene}
          onUnpublish={unpublishScene}
          onBrowse={(scene) => navigate({ view: "view", sceneId: scene.id })}
          onBrowsePublished={(scene) => navigate({ view: "published", sceneId: scene.id })}
          onImport={() => importRef.current?.click()}
          onExportLoose={exportSceneConfig}
          onExportSingle={exportSingleFileScene}
          onExportGlb={exportGlbScene}
          onDelete={deleteScene}
          onOptimizer={() => navigate({ view: "optimizer" })}
          onUploadModels={uploadModels}
          onDeleteModel={deleteModel}
          onRefreshModels={refreshProject}
        />
      )}
    <div className={`app-shell ${route.view === "view" || route.view === "published" ? "viewer-shell" : ""} ${route.view === "studio" || route.view === "view" || route.view === "published" ? "" : "app-shell-hidden"}`}>
      <header className="topbar">
        <div className="brand-mark"><img src={`${import.meta.env.BASE_URL}brand/logo-transparent.png`} alt="BIM Studio" /></div>
        <div className="brand-copy"><strong>BIM Studio</strong><span>{route.view === "studio" ? tr(locale, "空间编排工作台", "Spatial composition studio") : tr(locale, "场景浏览", "Scene viewer")}</span></div>
        <div className="topbar-divider" />
        {route.view === "studio" ? <>
        <select
          className="project-select"
          value={project?.id ?? ""}
          onChange={(event) => switchProjectById(event.target.value)}
          aria-label={tr(locale, "当前项目", "Current project")}
        >
          {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button className="project-add-button" title={tr(locale, "新建项目", "New project")} onClick={() => openProjectDialog("create")}><Plus size={15} /></button>
        <div className="scene-title-wrap">
          <span>{tr(locale, "场景", "Scene")}</span>
          <input
            value={sceneName}
            onChange={(event) => setSceneName(event.target.value)}
            onBlur={() => void commitSceneName()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setSceneName(activeScene?.name ?? "未命名场景");
                event.currentTarget.blur();
              }
            }}
            aria-label={tr(locale, "场景名称", "Scene name")}
          />
        </div>
        <div className="topbar-actions">
          <div className="renderer-switch" aria-label={tr(locale, "渲染模式", "Renderer")} title={tr(locale, "WebGPU 仍处于实验阶段；切换时会自动恢复当前场景", "WebGPU is experimental; switching restores the current scene")}>
            {rendererSwitching ? <LoaderCircle className="spin" size={14} /> : <Cpu size={14} />}
            <button className={rendererBackend === "webgl" ? "active" : ""} disabled={rendererSwitching || busy} onClick={() => changeRendererBackend("webgl")}>WebGL</button>
            <button className={rendererBackend === "webgpu" ? "active" : ""} disabled={rendererSwitching || busy} onClick={() => changeRendererBackend("webgpu")}>WebGPU<small>{tr(locale, "实验", "Experimental")}</small></button>
          </div>
          <button className={`button ghost compact-action ${digitalTwinOpen ? "active" : ""}`} title={tr(locale, "数字孪生流程与看板", "Digital twin flows and dashboards")} onClick={() => { setDigitalTwinOpen((value) => !value); setEnvironmentOpen(false); }}><Radio size={16} />{tr(locale, "数据", "Data")}</button>
          <button className="button ghost" onClick={() => void commitSceneName().then((committed) => committed && navigate({ view: "manager" }))}><LayoutGrid size={16} />{tr(locale, "场景管理", "Scenes")}</button>
          <button className="button ghost" onClick={() => importRef.current?.click()}><Import size={16} />{tr(locale, "导入", "Import")}</button>
          <SceneExportMenu locale={locale} disabled={busy} onExportLoose={() => exportSceneConfig()} onExportSingle={() => void exportSingleFileScene()} onExportGlb={() => void exportGlbScene()} />
          <button className="button primary" onClick={() => void saveScene()} disabled={busy}><Save size={16} />{tr(locale, "保存场景", "Save scene")}</button>
        </div>
        </> : <>
          <div className="viewer-scene-title"><span className="viewer-mode-badge"><Rocket size={13} />{route.view === "published" ? tr(locale, "已发布版本", "Published version") : tr(locale, "当前保存版本", "Saved version")}</span><strong>{sceneName}</strong></div>
          <div className="topbar-actions"><button className="button ghost" onClick={() => navigate({ view: "manager" })}><ArrowLeft size={16} />{tr(locale, "返回场景管理", "Back to scenes")}</button></div>
        </>}
      </header>

      <aside className="left-panel">
        <div className="panel-heading">
          <div><span className="eyebrow">PROJECT DIRECTORY</span><h2>{tr(locale, "目录树", "Directory")}</h2></div>
          <button className="icon-button" title={tr(locale, "上传模型", "Upload model")} onClick={() => uploadRef.current?.click()} disabled={uploading}>
            {uploading ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />}
          </button>
        </div>
        <div className="rvt-route-switch" aria-label={tr(locale, "RVT 转换链路", "RVT conversion route")}>
          <span>{tr(locale, "RVT 转换", "RVT conversion")}</span>
          <button className={rvtConversionMode === "native-glb" ? "active" : ""} onClick={() => setRvtConversionMode("native-glb")}><strong>{tr(locale, "原生 GLB", "Native GLB")}</strong><small>{tr(locale, "快速 · 推荐", "Fast · Recommended")}</small></button>
          <button className={rvtConversionMode === "ifc" ? "active" : ""} onClick={() => setRvtConversionMode("ifc")}><strong>IFC</strong><small>{tr(locale, "兼容备用", "Compatibility fallback")}</small></button>
        </div>
        <button className="upload-zone" onClick={() => uploadRef.current?.click()}>
          <Upload size={20} /><span>{tr(locale, "上传模型", "Upload model")}</span><small>RVT · IFC · STEP · DWG · GLB · FBX · DXF</small>
        </button>
        <div className="directory-tabs" role="tablist" aria-label={tr(locale, "目录类型", "Directory type")}>
          <button className={directoryMode === "components" ? "active" : ""} onClick={() => setDirectoryMode("components")}>{tr(locale, "构件", "Components")}</button>
          <button className={directoryMode === "spaces" ? "active" : ""} onClick={() => setDirectoryMode("spaces")}>{tr(locale, "空间", "Spaces")} <small>{spaces.length}</small></button>
        </div>
        {directoryMode === "components" && <section className="component-search" aria-label={tr(locale, "构件查询", "Component search")}>
          <div className="component-search-input"><Search size={15} /><input value={componentQuery} onChange={(event) => setComponentQuery(event.target.value)} placeholder={tr(locale, "搜索名称、ID、属性", "Search name, ID or property")} aria-label={tr(locale, "搜索构件", "Search components")} />{componentQuery && <button title={tr(locale, "清空搜索", "Clear search")} onClick={() => setComponentQuery("")}><X size={13} /></button>}</div>
          {(componentFacets.levels.length > 0 || componentFacets.categories.length > 0) && (
            <div className="component-filters">
              <select value={componentLevel} onChange={(event) => setComponentLevel(event.target.value)} aria-label={tr(locale, "按楼层筛选", "Filter by floor")}><option value="">{tr(locale, "全部楼层", "All floors")}</option>{componentFacets.levels.map((value) => <option key={value} value={value}>{value}</option>)}</select>
              <select value={componentCategory} onChange={(event) => setComponentCategory(event.target.value)} aria-label={tr(locale, "按类别筛选", "Filter by category")}><option value="">{tr(locale, "全部类别", "All categories")}</option>{componentFacets.categories.map((value) => <option key={value} value={value}>{value}</option>)}</select>
            </div>
          )}
          {componentSearchActive && (
            <div className="component-results">
              <div className="component-results-head"><span>{componentResults.length} {tr(locale, "个结果", "results")}</span><div><button disabled={componentResults.length === 0} onClick={() => { engine?.isolateComponents(componentResults); setRevision((value) => value + 1); }}>{tr(locale, "隔离结果", "Isolate")}</button>{engine?.isIsolationActive() && <button onClick={() => { engine.clearIsolation(); setRevision((value) => value + 1); }}>{tr(locale, "恢复", "Restore")}</button>}</div></div>
              <div className="component-result-list">
                {componentResults.map((record) => <button key={record.stableId} className={selectedComponent?.stableId === record.stableId ? "selected" : ""} onClick={() => focusComponent(record)}><strong title={record.name}>{record.name}</strong><small>{[record.level, record.category, record.type].filter(Boolean).join(" · ")}</small></button>)}
                {componentResults.length === 0 && <span className="component-no-result">{tr(locale, "没有匹配构件", "No matching components")}</span>}
              </div>
            </div>
          )}
        </section>}
        <div className="asset-list">
          {directoryMode === "spaces" ? <SpaceTree
            locale={locale}
            spaces={spaces}
            isVisible={(space) => engine?.isSpaceVisible(space) ?? false}
            onFocus={(space) => {
              const focused = engine?.focusSpace(space) ?? false;
              if (focused) {
                setSelectedSpace(space);
                setNavigationMode("orbit");
                setAnimationPlaying(false);
                setMessage(`已定位空间“${space.number ? `${space.number} ` : ""}${space.name}”`);
              } else setMessage(`空间“${space.name}”缺少有效边界，无法定位`);
              setRevision((value) => value + 1);
            }}
            onVisibilityChange={(space, visible) => {
              const changed = engine?.setSpaceVisible(space, visible) ?? false;
              setMessage(changed ? `${visible ? "显示" : "隐藏"}空间“${space.name}”` : `空间“${space.name}”缺少有效边界`);
              setRevision((value) => value + 1);
            }}
            onBatchVisibilityChange={(items, visible) => {
              const count = engine?.setSpacesVisible(items, visible) ?? 0;
              setMessage(`${visible ? "显示" : "隐藏"} ${count} 个空间`);
              setRevision((value) => value + 1);
            }}
          /> : <>
          {project?.models.length ? project.models.map((model) => {
            const loaded = loadedModels.find((item) => item.id === model.id);
            const tree = loaded ? engine?.getLayerTree(model.id) : undefined;
            const expanded = expandedModels.has(model.id);
            const modelFloors = floorStatesByModel.get(model.id) ?? [];
            const floorExpansion = floorExpansionByModel[model.id] ?? 0;
            return (
              <div className="model-tree-item" key={model.id}>
                <div className={`asset-row ${selected?.id === model.id ? "selected" : ""}`}>
                  <button className="model-expander" disabled={!loaded} title={expanded ? tr(locale, "收起模型结构", "Collapse model structure") : tr(locale, "展开模型结构", "Expand model structure")} onClick={() => loaded && toggleModelTree(model.id)}>
                    {loaded ? expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span />}
                  </button>
                  <button className="asset-main" onClick={() => loaded ? engine?.select(model.id) : void loadModel(model)}>
                    <span className={`format-badge format-${model.format}`}>{model.format.toUpperCase()}</span>
                    <span className="asset-copy"><strong title={model.name}>{model.name}</strong><small>{statusText(model, Boolean(loaded), locale)}</small></span>
                  </button>
                  {loaded && <button className="mini-button" title={loaded.visible ? tr(locale, "隐藏", "Hide") : tr(locale, "显示", "Show")} onClick={() => engine?.setVisible(model.id, !loaded.visible)}>{loaded.visible ? <Eye size={15} /> : <EyeOff size={15} />}</button>}
                  {loaded && <button className={`mini-button ${engine?.isModelLocked(model.id) ? "active" : ""}`} title={engine?.isModelLocked(model.id) ? tr(locale, "解锁模型", "Unlock model") : tr(locale, "锁定模型", "Lock model")} onClick={() => { engine?.setModelLocked(model.id, !engine.isModelLocked(model.id)); setRevision((value) => value + 1); }}>{engine?.isModelLocked(model.id) ? <Lock size={14} /> : <Unlock size={14} />}</button>}
                  {loaded && (
                    <button
                      className={`mini-button collision-toggle ${engine?.isCollisionEnabled(model.id) ? "active" : ""} ${engine?.isColliding(model.id) ? "colliding" : ""}`}
                      title={engine?.isCollisionEnabled(model.id) ? tr(locale, "关闭碰撞检测", "Disable collision detection") : tr(locale, "开启碰撞检测", "Enable collision detection")}
                      onClick={() => engine?.setCollisionEnabled(model.id, !engine.isCollisionEnabled(model.id))}
                    >
                      <ScanLine size={15} />
                    </button>
                  )}
                  {loaded && engine?.hasAnimation(model.id) && (
                    <button
                      className={`mini-button ${engine.isAnimationEnabled(model.id) ? "active" : ""}`}
                      title={engine.isAnimationEnabled(model.id) ? tr(locale, "暂停模型动画", "Pause model animation") : tr(locale, "播放模型动画", "Play model animation")}
                      onClick={() => { engine.setAnimationEnabled(model.id, !engine.isAnimationEnabled(model.id)); setRevision((value) => value + 1); }}
                    >
                      {engine.isAnimationEnabled(model.id) ? <Pause size={14} /> : <Play size={14} />}
                    </button>
                  )}
                  <button className="mini-button danger" disabled={Boolean(loaded && engine?.isModelLocked(model.id))} title={loaded && engine?.isModelLocked(model.id) ? tr(locale, "请先解锁模型", "Unlock the model first") : tr(locale, "删除模型", "Delete model")} onClick={() => void deleteModel(model)}><Trash2 size={15} /></button>
                </div>
                {expanded && modelFloors.length > 0 && (
                  <section className="floor-control model-floor-control" aria-label={`${model.name} ${tr(locale, "楼层控制", "floor controls")}`}>
                    <div className="floor-control-head"><span>{tr(locale, "楼层", "Floors")}</span><small>{modelFloors.length}</small><label><span>{tr(locale, "向上展开", "Expand upward")}</span><input type="range" min="0" max="12" step="0.25" value={floorExpansion} onChange={(event) => expandFloors(model.id, Number(event.target.value))} /><output>{floorExpansion.toFixed(1)}m</output></label></div>
                    <div className="floor-list">{modelFloors.map((floor) => <button key={`${floor.modelId}:${floor.level}`} className={floor.visible ? "active" : ""} title={floor.visible ? tr(locale, "隐藏该楼层", "Hide floor") : tr(locale, "显示该楼层", "Show floor")} onClick={() => updateFloor({ ...floor, visible: !floor.visible })}>{floor.visible ? <Eye size={13} /> : <EyeOff size={13} />}<span>{floor.level}</span></button>)}</div>
                  </section>
                )}
                {expanded && tree && (
                  <LayerTree
                    locale={locale}
                    root={tree}
                    selectedNodeId={selected?.id === model.id ? selectedLayerId : undefined}
                    onSelect={(node) => { engine?.selectLayer(model.id, node.id); setRevision((value) => value + 1); }}
                    onVisibilityChange={(node, visible) => { engine?.setLayerVisible(model.id, node.id, visible); setRevision((value) => value + 1); }}
                    onLockChange={(node, locked) => { engine?.setLayerLocked(model.id, node.id, locked); setRevision((value) => value + 1); setMessage(locked ? `已锁定“${node.name}”` : `已解锁“${node.name}”`); }}
                    onDelete={(node) => {
                      if (!window.confirm(`从当前场景删除图层“${node.name}”吗？`)) return;
                      engine?.selectLayer(model.id, node.id);
                      engine?.deleteSelectedLayer();
                      setRevision((value) => value + 1);
                    }}
                  />
                )}
              </div>
            );
          }) : scenePrimitives.length === 0 && measurements.length === 0 && annotations.length === 0 ? <div className="empty-state"><Layers3 size={28} /><strong>{tr(locale, "还没有模型", "No models yet")}</strong><span>{tr(locale, "上传文件或插入正方体开始构建场景", "Upload a file or insert a cube to begin")}</span></div> : null}
          {route.view === "studio" && (lighting.lights?.length ?? 0) > 0 && (
            <section className="scene-light-layers" aria-label={tr(locale, "灯光图层", "Light layers")}>
              <div className="scene-object-heading"><span>{tr(locale, "灯光", "Lights")}</span><small>{lighting.lights?.length ?? 0}</small></div>
              {(lighting.lights ?? []).map((light) => {
                const canMove = !["ambient", "hemisphere"].includes(light.type);
                const canAim = ["directional", "spot", "rectArea"].includes(light.type);
                return <div className={`asset-row scene-object-row ${selectedLightId === light.id ? "selected" : ""}`} key={light.id}>
                  <span className="model-expander" />
                  <button className="asset-main" onClick={() => { setSelectedLightId(light.id); setEnvironmentOpen(true); }}>
                    <span className="scene-object-badge light-layer-badge" style={{ color: light.color }}><Lightbulb size={15} /></span>
                    <span className="asset-copy"><strong>{light.name}</strong><small>{tr(locale, lightTypeName(light.type), lightTypeEnglishName(light.type))}</small></span>
                  </button>
                  <button className="mini-button" title={light.enabled ? tr(locale, "关闭光源", "Disable light") : tr(locale, "开启光源", "Enable light")} onClick={() => updateLight(light.id, { enabled: !light.enabled })}>{light.enabled ? <Eye size={15} /> : <EyeOff size={15} />}</button>
                  {canMove && <button className="mini-button" title={tr(locale, "移动光源", "Move light")} onClick={() => selectLightForTransform(light, "position")}><Move size={14} /></button>}
                  {canAim && <button className="mini-button" title={tr(locale, "改变光照方向", "Change light direction")} onClick={() => selectLightForTransform(light, "target")}><LocateFixed size={14} /></button>}
                  <button className="mini-button danger" title={tr(locale, "删除光源", "Delete light")} onClick={() => removeLight(light.id)}><Trash2 size={15} /></button>
                </div>;
              })}
            </section>
          )}
          {(scenePrimitives.length > 0 || measurements.length > 0 || annotations.length > 0) && (
            <section className="scene-object-layers" aria-label={tr(locale, "场景对象图层", "Scene object layers")}>
              <div className="scene-object-heading"><span>{tr(locale, "场景对象", "Scene objects")}</span><small>{scenePrimitives.length + measurements.length + annotations.length}</small></div>
              {scenePrimitives.map((primitive) => (
                <div className={`asset-row scene-object-row ${selected?.id === primitive.id ? "selected" : ""}`} key={primitive.id}>
                  <span className="model-expander" />
                  <button className="asset-main" onClick={() => engine?.select(primitive.id)}>
                    <span className="scene-object-badge"><Box size={15} /></span>
                    <span className="asset-copy"><strong>{primitive.name}</strong><small>{tr(locale, "基础元素 · 可编辑", "Primitive · Editable")}</small></span>
                  </button>
                  <button className="mini-button" title={primitive.visible ? tr(locale, "隐藏正方体", "Hide cube") : tr(locale, "显示正方体", "Show cube")} onClick={() => engine?.setVisible(primitive.id, !primitive.visible)}>{primitive.visible ? <Eye size={15} /> : <EyeOff size={15} />}</button>
                  <button className={`mini-button ${engine?.isModelLocked(primitive.id) ? "active" : ""}`} title={engine?.isModelLocked(primitive.id) ? tr(locale, "解锁正方体", "Unlock cube") : tr(locale, "锁定正方体", "Lock cube")} onClick={() => { engine?.setModelLocked(primitive.id, !engine.isModelLocked(primitive.id)); setRevision((value) => value + 1); }}>{engine?.isModelLocked(primitive.id) ? <Lock size={14} /> : <Unlock size={14} />}</button>
                  <button
                    className={`mini-button collision-toggle ${engine?.isCollisionEnabled(primitive.id) ? "active" : ""} ${engine?.isColliding(primitive.id) ? "colliding" : ""}`}
                    title={engine?.isCollisionEnabled(primitive.id) ? tr(locale, "关闭正方体碰撞检测", "Disable cube collision detection") : tr(locale, "开启正方体碰撞检测", "Enable cube collision detection")}
                    onClick={() => engine?.setCollisionEnabled(primitive.id, !engine.isCollisionEnabled(primitive.id))}
                  >
                    <ScanLine size={15} />
                  </button>
                  <button className="mini-button danger" disabled={engine?.isModelLocked(primitive.id)} title={engine?.isModelLocked(primitive.id) ? tr(locale, "请先解锁正方体", "Unlock the cube first") : tr(locale, "删除正方体", "Delete cube")} onClick={() => deletePrimitive(primitive.id)}><Trash2 size={15} /></button>
                </div>
              ))}
              {measurements.map((measurement, index) => (
                <div className="asset-row scene-object-row" key={measurement.id}>
                  <span className="model-expander" />
                  <button className="asset-main" onClick={() => engine?.focusMeasurement(measurement)}>
                    <span className="scene-object-badge"><Ruler size={15} /></span>
                    <span className="asset-copy"><strong>{tr(locale, "测量", "Measurement")} {index + 1}</strong><small>{measureModeName(measurement.kind ?? "distance", locale)} · {formatMeasurementValue(measurement)}</small></span>
                  </button>
                  <button className="mini-button danger" title={`${tr(locale, "删除标尺", "Delete measurement")} ${index + 1}`} onClick={() => deleteMeasurement(measurement.id)}><Trash2 size={15} /></button>
                </div>
              ))}
              {annotations.map((annotation) => (
                <div className={`asset-row scene-object-row ${selectedAnnotationId === annotation.id ? "selected" : ""}`} key={annotation.id}>
                  <span className="model-expander" />
                  <button className="asset-main" onClick={() => engine?.focusAnnotation(annotation.id)}>
                    <span className="scene-object-badge annotation-badge" style={{ color: annotation.color }}><MapPin size={15} /></span>
                    <span className="asset-copy"><strong>{annotation.name}</strong><small>{annotation.anchorName || tr(locale, "场景标签", "Scene annotation")}</small></span>
                  </button>
                  <button className="mini-button" title={annotation.visible ? tr(locale, "隐藏标签", "Hide annotation") : tr(locale, "显示标签", "Show annotation")} onClick={() => updateAnnotation(annotation.id, { visible: !annotation.visible })}>{annotation.visible ? <Eye size={15} /> : <EyeOff size={15} />}</button>
                  <button className={`mini-button ${annotation.locked ? "active" : ""}`} title={annotation.locked ? tr(locale, "解锁标签", "Unlock annotation") : tr(locale, "锁定标签", "Lock annotation")} onClick={() => updateAnnotation(annotation.id, { locked: !annotation.locked })}>{annotation.locked ? <Lock size={14} /> : <Unlock size={14} />}</button>
                  <button className="mini-button danger" disabled={annotation.locked} title={annotation.locked ? tr(locale, "请先解锁标签", "Unlock the annotation first") : tr(locale, "删除标签", "Delete annotation")} onClick={() => deleteAnnotation(annotation.id)}><Trash2 size={15} /></button>
                </div>
              ))}
            </section>
          )}
          </>}
        </div>
      </aside>

      <main className="workspace">
        <div className="viewport" ref={viewportRef} />
        {rendererSwitching && <div className="renderer-loading"><LoaderCircle className="spin" size={18} /><span>{tr(locale, "正在初始化", "Initializing")} {rendererBackend === "webgpu" ? "WebGPU" : "WebGL"}</span></div>}
        <div className="tool-dock" role="toolbar" aria-label={tr(locale, "查看编辑工具", "View and edit tools")}>
          {route.view === "view" || route.view === "published" ? <>
            <ToolButton title={tr(locale, "适应全部（回到模型）", "Fit all")} active={false} onClick={() => engine?.fitAll()} icon={<Focus size={19} />} />
            <ToolButton title={tr(locale, "轨道浏览（围绕模型旋转）", "Orbit around model")} active={navigationMode === "orbit"} onClick={() => changeNavigation("orbit")} icon={<Orbit size={19} />} />
            <ToolButton title={tr(locale, "第一人称（地面行走）", "First person walk")} active={navigationMode === "firstPerson"} onClick={() => changeNavigation("firstPerson")} icon={<Footprints size={19} />} />
            <ToolButton title={tr(locale, "第三人称（空中漫游）", "Third person fly")} active={navigationMode === "thirdPerson"} onClick={() => changeNavigation("thirdPerson")} icon={<UserRound size={19} />} />
            <ToolButton title={avatarVisible ? tr(locale, "隐藏人物", "Hide avatar") : tr(locale, "显示人物", "Show avatar")} active={avatarVisible} onClick={() => { const next = !avatarVisible; setAvatarVisible(next); engine?.setAvatarVisible(next); }} icon={avatarVisible ? <Eye size={19} /> : <EyeOff size={19} />} />
            <ToolButton title={tr(locale, "场景信息", "Scene information")} active={infoEnabled} onClick={() => setInfoEnabled((value) => !value)} icon={<Info size={19} />} />
            <ToolButton title={tr(locale, "进入 VR（需头显与 HTTPS）", "Enter VR (headset and HTTPS required)")} active={false} onClick={() => void startXR("immersive-vr")} icon={<span className="xr-tool-label">VR</span>} />
            <ToolButton title={tr(locale, "进入 AR（需兼容移动设备与 HTTPS）", "Enter AR (compatible mobile device and HTTPS required)")} active={false} onClick={() => void startXR("immersive-ar")} icon={<span className="xr-tool-label">AR</span>} />
          </> : <>
          <ToolButton title={tr(locale, "适应全部（回到模型）", "Fit all")} active={false} onClick={() => engine?.fitAll()} icon={<Focus size={19} />} />
          <span className="dock-separator" />
          <ToolButton title={tr(locale, "选择", "Select")} active={!measureEnabled && !annotationEnabled && navigationMode === "orbit"} onClick={() => changeNavigation("orbit")} icon={<MousePointer2 size={19} />} />
          <ToolButton title={tr(locale, "移动模型", "Move object")} active={transformMode === "translate"} onClick={() => changeTransform("translate")} icon={<Move size={19} />} />
          <ToolButton title={tr(locale, "旋转模型", "Rotate object")} active={transformMode === "rotate"} onClick={() => changeTransform("rotate")} icon={<RotateCw size={19} />} />
          <ToolButton title={tr(locale, "缩放模型", "Scale object")} active={transformMode === "scale"} onClick={() => changeTransform("scale")} icon={<Scaling size={19} />} />
          <ToolButton title={tr(locale, "构件选择", "Component selection")} active={selectionScope === "component"} onClick={() => { const next = selectionScope === "model" ? "component" : "model"; setSelectionScope(next); engine?.setSelectionScope(next); setMessage(next === "component" ? "构件选择已开启：画布点击可深入选择构件" : "模型选择已开启：画布点击只选择整个模型"); }} icon={<MousePointer2 size={19} />} />
          <span className="dock-separator" />
          <ToolButton title={tr(locale, "测量工具", "Measurement tools")} active={measureEnabled} onClick={toggleMeasurement} icon={<Ruler size={19} />} />
          <ToolButton title={tr(locale, "添加立方体", "Add cube")} active={false} onClick={addBox} icon={<Box size={19} />} />
          <ToolButton title={tr(locale, "标签标记", "Annotations")} active={annotationEnabled} onClick={toggleAnnotationPlacement} icon={<MapPin size={19} />} />
          <ToolButton title={tr(locale, "剖切模型", "Section model")} active={clipping.enabled} onClick={toggleClipping} icon={<ScanLine size={19} />} />
          <ToolButton title={tr(locale, "模型爆炸", "Explode model")} active={explosionFactor > 0} onClick={() => updateExplosion(explosionFactor > 0 ? 0 : 0.55)} icon={<Layers3 size={19} />} />
          <span className="dock-separator" />
          <ToolButton title={tr(locale, "轨道浏览（围绕模型旋转）", "Orbit around model")} active={navigationMode === "orbit"} onClick={() => changeNavigation("orbit")} icon={<Orbit size={19} />} />
          <ToolButton title={tr(locale, "第一人称（地面行走）", "First person walk")} active={navigationMode === "firstPerson"} onClick={() => changeNavigation("firstPerson")} icon={<Footprints size={19} />} />
          <ToolButton title={tr(locale, "第三人称（空中漫游）", "Third person fly")} active={navigationMode === "thirdPerson"} onClick={() => changeNavigation("thirdPerson")} icon={<UserRound size={19} />} />
          <ToolButton
            title={avatarVisible ? tr(locale, "隐藏人物", "Hide avatar") : tr(locale, "显示人物", "Show avatar")}
            active={avatarVisible}
            onClick={() => {
              const next = !avatarVisible;
              setAvatarVisible(next);
              engine?.setAvatarVisible(next);
            }}
            icon={avatarVisible ? <Eye size={19} /> : <EyeOff size={19} />}
          />
          <span className="dock-separator" />
          <ToolButton title={tr(locale, "场景信息", "Scene information")} active={infoEnabled} onClick={() => setInfoEnabled((value) => !value)} icon={<Info size={19} />} />
          <ToolButton title={tr(locale, "环境设置", "Environment")} active={environmentOpen} onClick={() => { setEnvironmentOpen((value) => !value); setDigitalTwinOpen(false); }} icon={<Sun size={19} />} />
          <ToolButton title={tr(locale, "动画编辑", "Animation editor")} active={animationOpen} onClick={() => setAnimationOpen((value) => !value)} icon={<Film size={19} />} />
          <ToolButton title={tr(locale, "二维数据看板", "2D data dashboard")} active={sceneDashboardOpen} onClick={() => setSceneDashboardOpen((value) => !value)} icon={<Gauge size={19} />} />
          <ToolButton title={tr(locale, "VR / AR", "VR / AR")} active={xrPanelOpen} onClick={() => setXrPanelOpen((value) => !value)} icon={<span className="xr-tool-label">XR</span>} />
          </>}
        </div>
        <ViewControl locale={locale} onSelect={(view) => engine?.setStandardView(view)} />
        {route.view === "studio" && environmentOpen && <div className="environment-control" aria-label={tr(locale, "环境与全局灯光", "Environment and global lighting")}>
          <div className="environment-heading"><strong>{tr(locale, "场景环境", "Scene environment")}</strong><small>{tr(locale, "随场景保存", "Saved with scene")}</small></div>
          <div className="environment-row">
            <span>{tr(locale, "天气", "Weather")}</span>
            <div className="environment-weather">
              <button className={weather === "sunny" ? "active" : ""} title={tr(locale, "晴天", "Sunny")} onClick={() => changeWeather("sunny")}><Sun size={15} /></button>
              <button className={weather === "rain" ? "active" : ""} title={tr(locale, "下雨", "Rain")} onClick={() => changeWeather("rain")}><CloudRain size={15} /></button>
              <button className={weather === "snow" ? "active" : ""} title={tr(locale, "下雪", "Snow")} onClick={() => changeWeather("snow")}><Snowflake size={15} /></button>
            </div>
          </div>
          <div className="environment-row">
            <span>{tr(locale, "天空", "Sky")}</span>
            <div className="skybox-presets">
              {SKYBOX_OPTIONS.map((option) => <button key={option.value} className={sceneEnvironment.skybox === option.value ? `active skybox-${option.value}` : `skybox-${option.value}`} onClick={() => changeSceneEnvironment({ ...sceneEnvironment, skybox: option.value })}>{tr(locale, option.label, skyboxEnglishLabel(option.value))}</button>)}
            </div>
          </div>
          <div className="environment-row environment-compact-row">
            <span>{tr(locale, "背景", "Background")}</span>
            <label className={sceneEnvironment.skybox === "none" ? "environment-color" : "environment-color disabled"} title={sceneEnvironment.skybox === "none" ? tr(locale, "设置纯色背景", "Set solid background") : tr(locale, "选择纯色天空后可设置背景颜色", "Choose solid sky to set the background color")}>
              <input type="color" value={sceneEnvironment.backgroundColor} disabled={sceneEnvironment.skybox !== "none"} onChange={(event) => changeSceneEnvironment({ ...sceneEnvironment, backgroundColor: event.target.value })} aria-label={tr(locale, "场景背景颜色", "Scene background color")} />
              <output>{sceneEnvironment.backgroundColor.toUpperCase()}</output>
            </label>
            <button className={`grid-toggle ${sceneEnvironment.gridVisible ? "active" : ""}`} title={sceneEnvironment.gridVisible ? tr(locale, "隐藏网格", "Hide grid") : tr(locale, "显示网格", "Show grid")} onClick={() => changeSceneEnvironment({ ...sceneEnvironment, gridVisible: !sceneEnvironment.gridVisible })}>{sceneEnvironment.gridVisible ? <Eye size={14} /> : <EyeOff size={14} />}{tr(locale, "网格", "Grid")}</button>
          </div>
          <div className="environment-row environment-light-row">
            <span>{tr(locale, "灯光", "Lighting")}</span>
            <button className={`lighting-toggle ${lighting.enabled ? "active" : ""}`} title={lighting.enabled ? tr(locale, "关闭全局灯光", "Disable global lighting") : tr(locale, "开启全局灯光", "Enable global lighting")} onClick={() => changeLighting({ ...lighting, enabled: !lighting.enabled })}><Lightbulb size={15} /></button>
            <input type="range" min="0" max="2.5" step="0.05" value={lighting.intensity} disabled={!lighting.enabled} onChange={(event) => changeLighting({ ...lighting, intensity: Number(event.target.value) })} aria-label={tr(locale, "全局灯光强度", "Global lighting intensity")} />
            <output>{Math.round(lighting.intensity * 100)}%</output>
          </div>
          <div className="environment-row environment-switches">
            <span>{tr(locale, "渲染", "Rendering")}</span>
            <button className={lighting.shadowsEnabled ? "active" : ""} onClick={() => changeLighting({ ...lighting, shadowsEnabled: !lighting.shadowsEnabled })}>{tr(locale, "阴影", "Shadows")}</button>
            <button className={lighting.reflectionsEnabled ? "active" : ""} onClick={() => changeLighting({ ...lighting, reflectionsEnabled: !lighting.reflectionsEnabled })}>{tr(locale, "反射", "Reflections")}</button>
          </div>
          <div className="environment-row environment-gi-row">
            <span>{tr(locale, "全局光照", "Global illumination")}</span>
            <button className={lighting.globalIlluminationEnabled ? "active" : ""} onClick={() => changeLighting({ ...lighting, globalIlluminationEnabled: !lighting.globalIlluminationEnabled })}>{lighting.globalIlluminationEnabled ? tr(locale, "已开启", "On") : tr(locale, "已关闭", "Off")}</button>
            <input type="range" min="0" max="2" step="0.05" value={lighting.globalIlluminationIntensity ?? 0.45} disabled={!lighting.globalIlluminationEnabled} onChange={(event) => changeLighting({ ...lighting, globalIlluminationIntensity: Number(event.target.value) })} />
            <output>{(lighting.globalIlluminationIntensity ?? 0.45).toFixed(2)}</output>
            <small>{tr(locale, "环境漫反射近似，默认关闭", "Environment diffuse approximation, off by default")}</small>
          </div>
          <div className="post-processing-control">
            <div className="light-system-head"><span>{tr(locale, "后处理", "Post-processing")}</span><button disabled={rendererBackend !== "webgl"} className={postProcessing.enabled ? "active" : ""} onClick={() => changePostProcessing({ ...postProcessing, enabled: !postProcessing.enabled })}>{postProcessing.enabled ? tr(locale, "已启用", "Enabled") : tr(locale, "已关闭", "Disabled")}</button></div>
            {rendererBackend !== "webgl" && <small>{tr(locale, "实时后处理当前使用 WebGL 管线", "Real-time post-processing currently uses the WebGL pipeline")}</small>}
            <div className="post-effect-grid">
              <button disabled={!postProcessing.enabled || rendererBackend !== "webgl"} className={postProcessing.smaa ? "active" : ""} onClick={() => changePostProcessing({ ...postProcessing, smaa: !postProcessing.smaa })}>SMAA</button>
              <button disabled={!postProcessing.enabled || rendererBackend !== "webgl"} className={postProcessing.fxaa ? "active" : ""} onClick={() => changePostProcessing({ ...postProcessing, fxaa: !postProcessing.fxaa })}>FXAA</button>
              <button disabled={!postProcessing.enabled || rendererBackend !== "webgl"} className={postProcessing.ssao ? "active" : ""} onClick={() => changePostProcessing({ ...postProcessing, ssao: !postProcessing.ssao })}>SSAO</button>
              <button disabled={!postProcessing.enabled || rendererBackend !== "webgl"} className={postProcessing.gtao ? "active" : ""} onClick={() => changePostProcessing({ ...postProcessing, gtao: !postProcessing.gtao })}>GTAO</button>
              <button disabled={!postProcessing.enabled || rendererBackend !== "webgl"} className={postProcessing.bloom ? "active" : ""} onClick={() => changePostProcessing({ ...postProcessing, bloom: !postProcessing.bloom })}>Bloom</button>
              <button disabled={!postProcessing.enabled || rendererBackend !== "webgl"} className={postProcessing.outline ? "active" : ""} onClick={() => changePostProcessing({ ...postProcessing, outline: !postProcessing.outline })}>{tr(locale, "轮廓", "Outline")}</button>
              <button disabled={!postProcessing.enabled || rendererBackend !== "webgl"} className={postProcessing.depthOfField ? "active" : ""} onClick={() => changePostProcessing({ ...postProcessing, depthOfField: !postProcessing.depthOfField })}>DOF</button>
              <button disabled={!postProcessing.enabled || rendererBackend !== "webgl"} className={postProcessing.vignette ? "active" : ""} onClick={() => changePostProcessing({ ...postProcessing, vignette: !postProcessing.vignette })}>{tr(locale, "暗角", "Vignette")}</button>
              <button disabled={!postProcessing.enabled || rendererBackend !== "webgl"} className={postProcessing.filmGrain ? "active" : ""} onClick={() => changePostProcessing({ ...postProcessing, filmGrain: !postProcessing.filmGrain })}>{tr(locale, "胶片", "Film")}</button>
              <button disabled={!postProcessing.enabled || rendererBackend !== "webgl"} className={postProcessing.afterimage ? "active" : ""} onClick={() => changePostProcessing({ ...postProcessing, afterimage: !postProcessing.afterimage })}>{tr(locale, "残像", "Trail")}</button>
            </div>
            {postProcessing.ssao && <label className="light-parameter"><span>{tr(locale, "遮蔽强度", "AO strength")}</span><input disabled={!postProcessing.enabled} type="range" min="0.1" max="4" step="0.1" value={postProcessing.ssaoIntensity} onChange={(event) => changePostProcessing({ ...postProcessing, ssaoIntensity: Number(event.target.value) })} /><output>{postProcessing.ssaoIntensity.toFixed(1)}</output></label>}
            {postProcessing.gtao && <label className="light-parameter"><span>GTAO</span><input disabled={!postProcessing.enabled} type="range" min="0.1" max="4" step="0.1" value={postProcessing.gtaoIntensity ?? 1} onChange={(event) => changePostProcessing({ ...postProcessing, gtaoIntensity: Number(event.target.value) })} /><output>{(postProcessing.gtaoIntensity ?? 1).toFixed(1)}</output></label>}
            {postProcessing.bloom && <><label className="light-parameter"><span>{tr(locale, "辉光强度", "Bloom strength")}</span><input disabled={!postProcessing.enabled} type="range" min="0" max="3" step="0.05" value={postProcessing.bloomStrength} onChange={(event) => changePostProcessing({ ...postProcessing, bloomStrength: Number(event.target.value) })} /><output>{postProcessing.bloomStrength.toFixed(2)}</output></label><label className="light-parameter"><span>{tr(locale, "辉光阈值", "Bloom threshold")}</span><input disabled={!postProcessing.enabled} type="range" min="0" max="1" step="0.01" value={postProcessing.bloomThreshold} onChange={(event) => changePostProcessing({ ...postProcessing, bloomThreshold: Number(event.target.value) })} /><output>{postProcessing.bloomThreshold.toFixed(2)}</output></label></>}
            {postProcessing.outline && <label className="light-parameter"><span>{tr(locale, "轮廓强度", "Outline")}</span><input disabled={!postProcessing.enabled} type="range" min="0" max="10" step="0.1" value={postProcessing.outlineStrength ?? 2.5} onChange={(event) => changePostProcessing({ ...postProcessing, outlineStrength: Number(event.target.value) })} /><output>{(postProcessing.outlineStrength ?? 2.5).toFixed(1)}</output></label>}
            {postProcessing.depthOfField && <><label className="light-parameter"><span>{tr(locale, "焦距", "Focus")}</span><input disabled={!postProcessing.enabled} type="range" min="0.1" max="200" step="0.5" value={postProcessing.focusDistance ?? 10} onChange={(event) => changePostProcessing({ ...postProcessing, focusDistance: Number(event.target.value) })} /><output>{(postProcessing.focusDistance ?? 10).toFixed(1)}</output></label><label className="light-parameter"><span>{tr(locale, "虚化", "Blur")}</span><input disabled={!postProcessing.enabled} type="range" min="0" max="0.03" step="0.001" value={postProcessing.maxBlur ?? 0.006} onChange={(event) => changePostProcessing({ ...postProcessing, maxBlur: Number(event.target.value) })} /><output>{(postProcessing.maxBlur ?? 0.006).toFixed(3)}</output></label></>}
            {postProcessing.vignette && <label className="light-parameter"><span>{tr(locale, "暗角强度", "Vignette")}</span><input disabled={!postProcessing.enabled} type="range" min="0" max="3" step="0.05" value={postProcessing.vignetteDarkness ?? 1.2} onChange={(event) => changePostProcessing({ ...postProcessing, vignetteDarkness: Number(event.target.value) })} /><output>{(postProcessing.vignetteDarkness ?? 1.2).toFixed(2)}</output></label>}
            {postProcessing.filmGrain && <label className="light-parameter"><span>{tr(locale, "颗粒强度", "Grain")}</span><input disabled={!postProcessing.enabled} type="range" min="0" max="1" step="0.01" value={postProcessing.filmGrainIntensity ?? 0.18} onChange={(event) => changePostProcessing({ ...postProcessing, filmGrainIntensity: Number(event.target.value) })} /><output>{(postProcessing.filmGrainIntensity ?? 0.18).toFixed(2)}</output></label>}
            {postProcessing.afterimage && <label className="light-parameter"><span>{tr(locale, "残像衰减", "Trail damp")}</span><input disabled={!postProcessing.enabled} type="range" min="0" max="0.99" step="0.01" value={postProcessing.afterimageDamp ?? 0.9} onChange={(event) => changePostProcessing({ ...postProcessing, afterimageDamp: Number(event.target.value) })} /><output>{(postProcessing.afterimageDamp ?? 0.9).toFixed(2)}</output></label>}
            <small>{tr(locale, "GTAO、景深和残像开销较高；SMAA 与 FXAA 建议二选一", "GTAO, DOF and trails are costly; use either SMAA or FXAA")}</small>
          </div>
          <div className="environment-map-row">
            <div><span>{tr(locale, "环境贴图", "Environment map")}</span><small title={sceneEnvironment.environmentMapName}>{sceneEnvironment.environmentMapName ?? tr(locale, "未选择 HDR / EXR", "No HDR / EXR selected")}</small></div>
            <button onClick={() => environmentMapRef.current?.click()}>{tr(locale, "上传", "Upload")}</button>
            {sceneEnvironment.environmentMapUrl && <button onClick={() => { const next = { ...sceneEnvironment }; delete next.environmentMapUrl; delete next.environmentMapName; changeSceneEnvironment(next); }}>{tr(locale, "清除", "Clear")}</button>}
            <label><input type="checkbox" checked={sceneEnvironment.environmentAsBackground ?? false} onChange={(event) => changeSceneEnvironment({ ...sceneEnvironment, environmentAsBackground: event.target.checked })} />{tr(locale, "作为背景", "Use as background")}</label>
          </div>
          <div className="light-system">
            <div className="light-system-head"><span>{tr(locale, "光源", "Lights")}</span><select value="" onChange={(event) => { if (event.target.value) addLight(event.target.value as SceneLightState["type"]); }}><option value="">+ {tr(locale, "添加光源", "Add light")}</option><option value="ambient">{tr(locale, "环境光", "Ambient")}</option><option value="hemisphere">{tr(locale, "半球光", "Hemisphere")}</option><option value="directional">{tr(locale, "方向光", "Directional")}</option><option value="point">{tr(locale, "点光源", "Point")}</option><option value="spot">{tr(locale, "聚光灯", "Spot")}</option><option value="rectArea">{tr(locale, "矩形区域光", "Rect area")}</option></select></div>
            <div className="light-tabs">{(lighting.lights ?? []).map((light) => <button key={light.id} className={selectedLight?.id === light.id ? "active" : ""} onClick={() => setSelectedLightId(light.id)}><i style={{ background: light.color }} />{light.name}</button>)}</div>
            {selectedLight && <div className="light-editor">
              <label><span>{tr(locale, "名称", "Name")}</span><input value={selectedLight.name} onChange={(event) => updateLight(selectedLight.id, { name: event.target.value })} /></label>
              <label><span>{tr(locale, "颜色", "Color")}</span><input type="color" value={selectedLight.color} onChange={(event) => updateLight(selectedLight.id, { color: event.target.value })} /></label>
              <label className="light-intensity"><span>{tr(locale, "强度", "Intensity")}</span><input type="range" min="0" max="20" step="0.05" value={selectedLight.intensity} onChange={(event) => updateLight(selectedLight.id, { intensity: Number(event.target.value) })} /><output>{selectedLight.intensity.toFixed(2)}</output></label>
              {selectedLight.position && <div className="light-vector"><span>{tr(locale, "位置", "Position")}</span>{(["x", "y", "z"] as const).map((axis) => <label key={axis}><i>{axis.toUpperCase()}</i><input type="number" step="0.5" value={selectedLight.position?.[axis] ?? 0} onChange={(event) => updateLight(selectedLight.id, { position: { ...selectedLight.position!, [axis]: Number(event.target.value) } })} /></label>)}</div>}
              {["directional", "spot", "rectArea"].includes(selectedLight.type) && selectedLight.target && <div className="light-vector"><span>{tr(locale, "照射目标", "Target")}</span>{(["x", "y", "z"] as const).map((axis) => <label key={axis}><i>{axis.toUpperCase()}</i><input type="number" step="0.5" value={selectedLight.target?.[axis] ?? 0} onChange={(event) => updateLight(selectedLight.id, { target: { ...selectedLight.target!, [axis]: Number(event.target.value) } })} /></label>)}</div>}
              {selectedLight.type === "spot" && <label className="light-parameter"><span>{tr(locale, "锥角", "Cone")}</span><input type="range" min="5" max="90" step="1" value={(selectedLight.angle ?? Math.PI / 6) * 180 / Math.PI} onChange={(event) => updateLight(selectedLight.id, { angle: Number(event.target.value) * Math.PI / 180 })} /><output>{Math.round((selectedLight.angle ?? Math.PI / 6) * 180 / Math.PI)}°</output></label>}
              {selectedLight.type === "rectArea" && <div className="light-size"><label><span>{tr(locale, "宽", "Width")}</span><input type="number" min="0.1" step="0.5" value={selectedLight.width ?? 6} onChange={(event) => updateLight(selectedLight.id, { width: Number(event.target.value) })} /></label><label><span>{tr(locale, "高", "Height")}</span><input type="number" min="0.1" step="0.5" value={selectedLight.height ?? 4} onChange={(event) => updateLight(selectedLight.id, { height: Number(event.target.value) })} /></label></div>}
              <button className={selectedLight.enabled ? "active" : ""} onClick={() => updateLight(selectedLight.id, { enabled: !selectedLight.enabled })}>{selectedLight.enabled ? tr(locale, "已启用", "Enabled") : tr(locale, "已关闭", "Disabled")}</button>
              {["directional", "point", "spot"].includes(selectedLight.type) && <button className={selectedLight.castShadow ? "active" : ""} onClick={() => updateLight(selectedLight.id, { castShadow: !selectedLight.castShadow })}>{tr(locale, "投射阴影", "Cast shadow")}</button>}
              <button className="danger" title={tr(locale, "删除光源", "Delete light")} onClick={() => removeLight(selectedLight.id)}><Trash2 size={13} /></button>
            </div>}
          </div>
        </div>}
        {route.view === "studio" && xrPanelOpen && <div className="xr-panel" aria-label={tr(locale, "沉浸式体验", "Immersive experience")}>
          <header><div><strong>{tr(locale, "VR / AR", "VR / AR")}</strong><small>{tr(locale, "WebXR 设备能力", "WebXR device capabilities")}</small></div><button onClick={() => setXrPanelOpen(false)}><X size={14} /></button></header>
          <div className="xr-requirements">
            <span className={xrCapabilities.secure ? "ok" : "bad"}>{xrCapabilities.secure ? "✓" : "!"} HTTPS</span>
            <span className={xrCapabilities.webxr ? "ok" : "bad"}>{xrCapabilities.webxr ? "✓" : "!"} WebXR</span>
            <span>{rendererBackend === "webgl" ? "✓ WebGL" : "! WebGPU"}</span>
          </div>
          <div className="xr-mode-grid">
            <article><span className="xr-mode-icon">VR</span><div><strong>{tr(locale, "虚拟现实", "Virtual reality")}</strong><small>{tr(locale, "头显 · 空间漫游", "Headset · immersive walkthrough")}</small></div><button disabled={xrCapabilities.checking || !xrCapabilities.vr || Boolean(xrActiveMode)} onClick={() => void startXR("immersive-vr")}>{xrCapabilities.checking ? "…" : xrCapabilities.vr ? tr(locale, "进入", "Enter") : tr(locale, "不支持", "Unavailable")}</button></article>
            <article><span className="xr-mode-icon">AR</span><div><strong>{tr(locale, "增强现实", "Augmented reality")}</strong><small>{tr(locale, "Android 移动设备 · 现实叠加", "Android mobile · world overlay")}</small></div><button disabled={xrCapabilities.checking || !xrCapabilities.ar || Boolean(xrActiveMode)} onClick={() => void startXR("immersive-ar")}>{xrCapabilities.checking ? "…" : xrCapabilities.ar ? tr(locale, "进入", "Enter") : tr(locale, "不支持", "Unavailable")}</button></article>
          </div>
          {xrActiveMode && <button className="xr-exit" onClick={() => void engine?.endXR()}>{tr(locale, "退出当前 XR 会话", "Exit current XR session")}</button>}
          {!xrCapabilities.checking && (!xrCapabilities.vr || !xrCapabilities.ar) && <p>{tr(locale, "桌面浏览器通常只能检测 VR 头显；AR 需支持 WebXR 的 Android 设备。自签名证书必须先在设备上信任。", "Desktop browsers usually require a connected VR headset; AR requires a WebXR-capable Android device. Trust the self-signed certificate on the device first.")}</p>}
        </div>}
        {route.view === "studio" && sceneDashboardOpen && <SceneDashboardOverlay locale={locale} onClose={() => setSceneDashboardOpen(false)} />}
        {route.view === "studio" && measureEnabled && (
          <div className="measure-mode-bar" aria-label={tr(locale, "测量模式", "Measurement mode")}>
            <span>{tr(locale, "测量", "Measure")}</span>
            <button className={measureMode === "distance" ? "active" : ""} onClick={() => changeMeasureMode("distance")}>{tr(locale, "距离", "Distance")}</button>
            <button className={measureMode === "minimum" ? "active" : ""} onClick={() => changeMeasureMode("minimum")}>{tr(locale, "最小距离", "Minimum")}</button>
            <button className={measureMode === "angle" ? "active" : ""} onClick={() => changeMeasureMode("angle")}>{tr(locale, "角度", "Angle")}</button>
            <button className={measureMode === "elevation" ? "active" : ""} onClick={() => changeMeasureMode("elevation")}>{tr(locale, "标高", "Elevation")}</button>
            <small>{tr(locale, "Esc 取消当前起点", "Esc cancels the current start point")}</small>
          </div>
        )}
        {route.view === "studio" && annotationEnabled && (
          <div className="annotation-placement-bar" aria-label={tr(locale, "标签放置模式", "Annotation placement mode")}>
            <MapPin size={15} /><strong>{tr(locale, "标签标记", "Annotation")}</strong><span>{tr(locale, "点击模型表面或地面连续放置标签", "Click a model surface or ground to place annotations")}</span><small>{tr(locale, "放置后在右侧编辑", "Edit on the right after placement")}</small><button title={tr(locale, "退出标签放置", "Exit annotation placement")} onClick={toggleAnnotationPlacement}><X size={14} /></button>
          </div>
        )}
        {route.view === "studio" && clipping.enabled && (
          <div className={`clipping-bar clipping-${clipping.mode ?? "axis"}`} aria-label={tr(locale, "剖切设置", "Section settings")}>
            <div className="clipping-tabs">
              <span>{tr(locale, "剖切", "Section")}</span>
              <button className={(clipping.mode ?? "axis") === "box" ? "active" : ""} onClick={() => changeClippingMode("box")}>{tr(locale, "剖切盒", "Section box")}</button>
              <button className={(clipping.mode ?? "axis") === "axis" ? "active" : ""} onClick={() => changeClippingMode("axis")}>{tr(locale, "轴向剖切", "Axis section")}</button>
              <button className={clipping.mode === "face" ? "active" : ""} onClick={() => changeClippingMode("face")}>{tr(locale, "拾取面", "Pick face")}</button>
              <button title={tr(locale, "关闭剖切", "Close section tool")} onClick={toggleClipping}><X size={14} /></button>
            </div>
            {(clipping.mode ?? "axis") === "axis" && <div className="clipping-axis-controls">
              {(["x", "y", "z"] as const).map((axis) => <button key={axis} className={clipping.axis === axis ? "active" : ""} onClick={() => updateClipping({ axis })}>{axis.toUpperCase()}</button>)}
              <input type="range" min={clippingRange.min} max={clippingRange.max} step={Math.max((clippingRange.max - clippingRange.min) / 200, 0.001)} value={clipping.offset} onChange={(event) => updateClipping({ offset: Number(event.target.value) })} aria-label={tr(locale, "剖切位置", "Section position")} />
              <output>{clipping.offset.toFixed(2)} m</output>
              <button className={clipping.inverted ? "active" : ""} onClick={() => updateClipping({ inverted: !clipping.inverted })}>{tr(locale, "反向", "Invert")}</button>
            </div>}
            {clipping.mode === "box" && <div className="clipping-box-controls">
              {(["x", "y", "z"] as const).map((axis) => <div className="clipping-bound-row" key={axis}>
                <strong>{axis.toUpperCase()}</strong><span>{tr(locale, "最小", "Min")}</span>
                <input type="range" min={clippingSceneBounds.min[axis]} max={clippingSceneBounds.max[axis]} step={Math.max((clippingSceneBounds.max[axis] - clippingSceneBounds.min[axis]) / 200, 0.001)} value={(clipping.box ?? clippingSceneBounds).min[axis]} onChange={(event) => updateClippingBox(axis, "min", Number(event.target.value))} />
                <span>{tr(locale, "最大", "Max")}</span>
                <input type="range" min={clippingSceneBounds.min[axis]} max={clippingSceneBounds.max[axis]} step={Math.max((clippingSceneBounds.max[axis] - clippingSceneBounds.min[axis]) / 200, 0.001)} value={(clipping.box ?? clippingSceneBounds).max[axis]} onChange={(event) => updateClippingBox(axis, "max", Number(event.target.value))} />
              </div>)}
              <button onClick={() => { if (engine) updateClipping({ box: engine.getClippingBounds(), showHelper: true }); }}>{tr(locale, "重置边界", "Reset bounds")}</button>
              <button className={clipping.showHelper === false ? "" : "active"} onClick={() => updateClipping({ showHelper: clipping.showHelper === false })}>{tr(locale, "显示边框", "Show outline")}</button>
            </div>}
            {clipping.mode === "face" && <div className="clipping-face-controls">
              <span>{clipping.face ? tr(locale, "剖切面已建立", "Section plane created") : tr(locale, "请在模型上点击一个面", "Click a face on the model")}</span>
              <button onClick={() => changeClippingMode("face")}>{tr(locale, "重新拾取", "Pick again")}</button>
              <button className={clipping.inverted ? "active" : ""} disabled={!clipping.face} onClick={() => updateClipping({ inverted: !clipping.inverted })}>{tr(locale, "反向", "Invert")}</button>
            </div>}
          </div>
        )}
        {animationOpen && (
          <div className="timeline-panel" aria-label={tr(locale, "场景动画编辑器", "Scene animation editor")}>
            <div className="timeline-main">
              <button className="timeline-jump" title={tr(locale, "回到开始", "Go to start")} onClick={() => engine?.seekSceneAnimation(0)}>0</button>
              <button className="timeline-play" title={animationPlaying ? tr(locale, "暂停", "Pause") : tr(locale, "播放", "Play")} onClick={toggleSceneAnimation}>{animationPlaying ? <Pause size={16} /> : <Play size={16} />}</button>
              <span className="timeline-time">{animationTime.toFixed(1)}s</span>
              <input className="timeline-range" type="range" min="0" max={sceneAnimation.duration} step="0.05" value={animationTime} onChange={(event) => engine?.seekSceneAnimation(Number(event.target.value))} aria-label={tr(locale, "动画时间", "Animation time")} />
              <label className="timeline-duration"><span>{tr(locale, "时长", "Duration")}</span><input type="number" min="0.1" step="0.5" value={sceneAnimation.duration} onChange={(event) => updateSceneAnimation({ ...sceneAnimation, duration: Math.max(Number(event.target.value) || 0.1, 0.1) })} /><i>s</i></label>
              <label className="timeline-loop"><input type="checkbox" checked={sceneAnimation.loop} onChange={(event) => updateSceneAnimation({ ...sceneAnimation, loop: event.target.checked })} />{tr(locale, "循环", "Loop")}</label>
              <label className="timeline-loop"><input type="checkbox" checked={sceneAnimation.pingPong ?? false} onChange={(event) => updateSceneAnimation({ ...sceneAnimation, pingPong: event.target.checked })} />{tr(locale, "往返", "Ping-pong")}</label>
            </div>
            <div className="timeline-options">
              <label><span>{tr(locale, "相机插值", "Camera interpolation")}</span><select value={sceneAnimation.cameraInterpolation ?? "smooth"} onChange={(event) => updateSceneAnimation({ ...sceneAnimation, cameraInterpolation: event.target.value as NonNullable<SceneAnimationState["cameraInterpolation"]> })}><option value="linear">{tr(locale, "线性", "Linear")}</option><option value="smooth">{tr(locale, "平滑", "Smooth")}</option><option value="spline">{tr(locale, "曲线路径", "Spline")}</option></select></label>
              <label><span>{tr(locale, "播放速度", "Playback speed")}</span><select value={sceneAnimation.playbackSpeed ?? 1} onChange={(event) => updateSceneAnimation({ ...sceneAnimation, playbackSpeed: Number(event.target.value) })}><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option><option value="4">4×</option></select></label>
              <label className="timeline-path"><input type="checkbox" checked={sceneAnimation.showCameraPath ?? true} onChange={(event) => updateSceneAnimation({ ...sceneAnimation, showCameraPath: event.target.checked })} />{tr(locale, "显示相机轨迹", "Show camera path")}</label>
              <small>{tr(locale, "关键帧点击定位，双击删除", "Click a keyframe to seek; double-click to delete")}</small>
            </div>
            <div className="timeline-actions">
              <button onClick={addCameraKeyframe}><Camera size={14} />{tr(locale, "记录/更新相机", "Record/update camera")}</button>
              <button onClick={addModelKeyframe} disabled={!selected || selectionLocked}><Box size={14} />{tr(locale, "记录选中对象", "Record selected object")}</button>
              <span>{sceneAnimation.camera.length} {tr(locale, "相机帧", "camera frames")} · {sceneAnimation.models.length} {tr(locale, "对象帧", "object frames")}</span>
              {[...sceneAnimation.camera, ...sceneAnimation.models].sort((a, b) => a.time - b.time).map((frame) => (
                <button className="keyframe-chip" key={frame.id} title={tr(locale, "点击定位，双击删除", "Click to seek; double-click to delete")} onClick={() => engine?.seekSceneAnimation(frame.time)} onDoubleClick={() => deleteKeyframe(frame.id)}>{"camera" in frame ? tr(locale, "相机", "Camera") : tr(locale, "对象", "Object")} {frame.time.toFixed(1)}s</button>
              ))}
            </div>
          </div>
        )}
        <div className="viewport-status"><span className={busy ? "status-dot working" : "status-dot"} />{message}</div>
        {navigationMode !== "orbit" && <div className="navigation-hint">{tr(locale, "W A S D 移动 · Shift 加速", "W A S D move · Shift boost")}{navigationMode === "firstPerson" ? tr(locale, " · 地面行走 · 双击画面锁定视角 · Esc 释放鼠标", " · Ground walk · Double-click to capture pointer · Esc to release") : tr(locale, " · 空中漫游 · Space 上升 · Ctrl 下降 · 鼠标旋转视角", " · Fly mode · Space up · Ctrl down · Mouse to look")}</div>}
        {busy && <div className="loading-overlay"><LoaderCircle className="spin" size={24} /><span>{tr(locale, "正在处理模型", "Processing model")}</span></div>}
      </main>

      <aside className="right-panel">
        <div className="panel-heading inspector-heading"><div><span className="eyebrow">INSPECTOR</span><h2>{tr(locale, "属性检查器", "Inspector")}</h2></div></div>
        {infoEnabled && <section className="scene-info-panel" aria-label={tr(locale, "场景信息", "Scene information")}>
          <div className="section-label"><span>{tr(locale, "场景信息", "Scene information")}</span><small>{sceneStatistics.modelCount + sceneStatistics.primitiveCount} {tr(locale, "对象", "objects")}</small></div>
          <div className="scene-info-grid">
            <div><strong>{numberFormat.format(sceneStatistics.modelCount)}</strong><span>{tr(locale, "模型", "Models")}</span></div>
            <div><strong>{numberFormat.format(sceneStatistics.componentCount)}</strong><span>{tr(locale, "构件", "Components")}</span></div>
            <div><strong>{numberFormat.format(sceneStatistics.triangleCount)}</strong><span>{tr(locale, "三角面", "Triangles")}</span></div>
            <div><strong>{numberFormat.format(sceneStatistics.vertexCount)}</strong><span>{tr(locale, "顶点", "Vertices")}</span></div>
            <div><strong>{frameRate || "—"}</strong><span>FPS</span></div>
          </div>
        </section>}
        {infoEnabled && <section className="runtime-info-panel" aria-label={tr(locale, "相机和鼠标信息", "Camera and pointer information")}>
          <div className="runtime-info-row"><Camera size={13} /><span>{tr(locale, "相机", "Camera")}</span><code>{cameraInfo ? formatVector(cameraInfo.position) : "—"}</code></div>
          <div className="runtime-info-row runtime-target"><span>◎</span><span>{tr(locale, "目标", "Target")}</span><code>{cameraInfo ? formatVector(cameraInfo.target) : "—"}</code></div>
          <div className="runtime-info-row"><MousePointer2 size={13} /><span>{tr(locale, "鼠标", "Pointer")}</span><code>{pointerInfo?.world ? formatVector(pointerInfo.world) : pointerInfo ? `${pointerInfo.screenX}, ${pointerInfo.screenY}` : "—"}</code></div>
          {pointerInfo?.objectName && <div className="runtime-object-name" title={pointerInfo.objectName}>{pointerInfo.objectName}</div>}
        </section>}
        {selectedAnnotation ? (
          <div className="inspector-content annotation-inspector">
            <div className="annotation-inspector-title"><span style={{ background: selectedAnnotation.color }}><MapPin size={15} /></span><div><strong>{tr(locale, "标签标记", "Annotation")}</strong><small>{selectedAnnotation.anchorName || tr(locale, "场景坐标", "Scene coordinates")}</small></div><button title={tr(locale, "定位标签", "Focus annotation")} onClick={() => engine?.focusAnnotation(selectedAnnotation.id)}><Maximize size={14} /></button></div>
            <label className="field"><span>{tr(locale, "标签名称", "Annotation name")}</span><input disabled={selectedAnnotation.locked} value={selectedAnnotation.name} onChange={(event) => updateAnnotation(selectedAnnotation.id, { name: event.target.value })} /></label>
            <label className="field"><span>{tr(locale, "说明内容", "Description")}</span><textarea disabled={selectedAnnotation.locked} rows={4} value={selectedAnnotation.description ?? ""} onChange={(event) => updateAnnotation(selectedAnnotation.id, { description: event.target.value })} placeholder={tr(locale, "填写巡检事项、设备状态或问题说明", "Describe an inspection item, device status, or issue")} /></label>
            <label className="field color-field"><span>{tr(locale, "标签颜色", "Annotation color")}</span><div><input disabled={selectedAnnotation.locked} type="color" value={selectedAnnotation.color} onChange={(event) => updateAnnotation(selectedAnnotation.id, { color: event.target.value })} /><output>{selectedAnnotation.color.toUpperCase()}</output></div></label>
            <div className="two-column">
              <label className="field"><span>{tr(locale, "可见性", "Visibility")}</span><button className={`toggle ${selectedAnnotation.visible ? "on" : ""}`} onClick={() => updateAnnotation(selectedAnnotation.id, { visible: !selectedAnnotation.visible })}><i />{selectedAnnotation.visible ? tr(locale, "显示", "Visible") : tr(locale, "隐藏", "Hidden")}</button></label>
              <label className="field"><span>{tr(locale, "锁定", "Lock")}</span><button className={`toggle ${selectedAnnotation.locked ? "on" : ""}`} onClick={() => updateAnnotation(selectedAnnotation.id, { locked: !selectedAnnotation.locked })}><i />{selectedAnnotation.locked ? tr(locale, "已锁定", "Locked") : tr(locale, "未锁定", "Unlocked")}</button></label>
            </div>
            <label className="field compact-opacity"><span>{tr(locale, "标签尺寸", "Annotation size")}</span><output>{Math.round((selectedAnnotation.size ?? 1) * 100)}%</output></label>
            <input disabled={selectedAnnotation.locked} className="range" type="range" min="0.35" max="3" step="0.05" value={selectedAnnotation.size ?? 1} onChange={(event) => updateAnnotation(selectedAnnotation.id, { size: Number(event.target.value) })} />
            <TransformFields disabled={selectedAnnotation.locked} title={tr(locale, "锚点位置", "Anchor position")} transform={selectedAnnotation.position} onChange={(axis, value) => updateAnnotationPosition(selectedAnnotation, axis, value)} />
            <div className="annotation-binding">
              <span>{tr(locale, "绑定对象", "Bound object")}</span>
              <strong>{selectedAnnotation.anchorName || tr(locale, "未绑定构件", "No component bound")}</strong>
              {selectedAnnotation.modelId && <small>{tr(locale, "模型", "Model")} {selectedAnnotation.modelId}{selectedAnnotation.layerId ? ` · ${tr(locale, "图层", "Layer")} ${selectedAnnotation.layerId}` : ""}</small>}
            </div>
            <button className="button remove-scene" disabled={selectedAnnotation.locked} onClick={() => deleteAnnotation(selectedAnnotation.id)}><Trash2 size={16} />{tr(locale, "删除标签", "Delete annotation")}</button>
          </div>
        ) : selectedSpace ? (
          <div className="inspector-content space-inspector">
            <div className="space-inspector-title"><span><DoorOpen size={16} /></span><div><strong>{selectedSpace.number ? `${selectedSpace.number} ${selectedSpace.name}` : selectedSpace.name}</strong><small>{selectedSpace.modelName} · {selectedSpace.level}</small></div><button title={tr(locale, "关闭空间属性", "Close space properties")} onClick={() => setSelectedSpace(undefined)}><X size={14} /></button></div>
            <div className="space-summary-grid">
              <div><span>{tr(locale, "面积", "Area")}</span><strong>{selectedSpace.areaSquareMetres === undefined ? "—" : `${numberFormat.format(selectedSpace.areaSquareMetres)} m²`}</strong></div>
              <div><span>{tr(locale, "体积", "Volume")}</span><strong>{selectedSpace.volumeCubicMetres === undefined ? "—" : `${numberFormat.format(selectedSpace.volumeCubicMetres)} m³`}</strong></div>
              <div><span>{tr(locale, "楼层", "Floor")}</span><strong title={selectedSpace.level}>{selectedSpace.level}</strong></div>
              <div><span>{tr(locale, "类型", "Type")}</span><strong>{selectedSpace.kind}</strong></div>
            </div>
            <div className="space-inspector-actions">
              <button onClick={() => { engine?.focusSpace(selectedSpace); setNavigationMode("orbit"); }}><LocateFixed size={13} />{tr(locale, "定位", "Focus")}</button>
              <button className={engine?.isSpaceVisible(selectedSpace) ? "active" : ""} onClick={() => { if (!engine) return; engine.setSpaceVisible(selectedSpace, !engine.isSpaceVisible(selectedSpace)); setRevision((value) => value + 1); }}>{engine?.isSpaceVisible(selectedSpace) ? <EyeOff size={13} /> : <Eye size={13} />}{engine?.isSpaceVisible(selectedSpace) ? tr(locale, "隐藏空间体", "Hide space") : tr(locale, "显示空间体", "Show space")}</button>
            </div>
            <StructuredProperties
              locale={locale}
              entries={spacePropertyEntries(selectedSpace, locale)}
              emptyText={tr(locale, "该空间没有更多 BIM 参数", "This space has no additional BIM parameters")}
            />
          </div>
        ) : selected && selectedTransform ? (
          <div className="inspector-content">
            <label className="field"><span>{selectedLayerId && selectedLayerId !== "root" ? tr(locale, "图层名称", "Layer name") : tr(locale, "名称", "Name")}</span><input disabled={selectionLocked} value={selectionName} onChange={(event) => { engine?.renameSelection(event.target.value); setRevision((value) => value + 1); }} /></label>
            <label className="field color-field"><span>{tr(locale, "图层颜色", "Layer color")}</span><div><input disabled={selectionLocked} type="color" value={selectionColor} onChange={(event) => { engine?.setSelectionColor(event.target.value); setRevision((value) => value + 1); }} /><output>{selectionColor.toUpperCase()}</output></div></label>
            <div className="two-column">
              <label className="field"><span>{tr(locale, "可见性", "Visibility")}</span><button className={`toggle ${selectionVisible ? "on" : ""}`} onClick={() => engine?.setSelectionVisible(!selectionVisible)}><i />{selectionVisible ? tr(locale, "显示", "Visible") : tr(locale, "隐藏", "Hidden")}</button></label>
              <label className="field"><span>{tr(locale, "锁定", "Lock")}</span><button className={`toggle ${selectionLocked ? "on" : ""}`} onClick={() => { if (!engine || !selected) return; if (selectedLayerId && selectedLayerId !== "root") engine.setLayerLocked(selected.id, selectedLayerId, !selectionLocked); else engine.setModelLocked(selected.id, !selectionLocked); setRevision((value) => value + 1); }}><i />{selectionLocked ? tr(locale, "已锁定", "Locked") : tr(locale, "未锁定", "Unlocked")}</button></label>
            </div>
            <label className="field compact-opacity"><span>{tr(locale, "透明度", "Opacity")}</span><output>{Math.round(selectionOpacity * 100)}%</output></label>
            <input disabled={selectionLocked} className="range" type="range" min="0" max="1" step="0.01" value={selectionOpacity} onChange={(event) => engine?.setSelectionOpacity(Number(event.target.value))} />
            <div className="material-editor">
              <div className="section-label"><span>{tr(locale, "材质", "Material")}</span><small>PBR</small></div>
              <label><span>{tr(locale, "粗糙度", "Roughness")}</span><input disabled={selectionLocked || selectionMaterial.roughness === undefined} type="range" min="0" max="1" step="0.01" value={selectionMaterial.roughness ?? 0.5} onChange={(event) => updateSelectionMaterial({ roughness: Number(event.target.value) })} /><output>{selectionMaterial.roughness?.toFixed(2) ?? "—"}</output></label>
              <label><span>{tr(locale, "金属度", "Metalness")}</span><input disabled={selectionLocked || selectionMaterial.metalness === undefined} type="range" min="0" max="1" step="0.01" value={selectionMaterial.metalness ?? 0} onChange={(event) => updateSelectionMaterial({ metalness: Number(event.target.value) })} /><output>{selectionMaterial.metalness?.toFixed(2) ?? "—"}</output></label>
              <label className="material-emissive"><span>{tr(locale, "自发光", "Emissive")}</span><input disabled={selectionLocked || selectionMaterial.emissive === undefined} type="color" value={selectionMaterial.emissive ?? "#000000"} onChange={(event) => updateSelectionMaterial({ emissive: event.target.value })} /><input disabled={selectionLocked || selectionMaterial.emissiveIntensity === undefined} type="range" min="0" max="5" step="0.05" value={selectionMaterial.emissiveIntensity ?? 0} onChange={(event) => updateSelectionMaterial({ emissiveIntensity: Number(event.target.value) })} /></label>
              <div className="material-toggles"><button disabled={selectionLocked} className={selectionMaterial.wireframe ? "active" : ""} onClick={() => updateSelectionMaterial({ wireframe: !selectionMaterial.wireframe })}>{tr(locale, "线框", "Wireframe")}</button><button disabled={selectionLocked} className={selectionMaterial.doubleSided ? "active" : ""} onClick={() => updateSelectionMaterial({ doubleSided: !selectionMaterial.doubleSided })}>{tr(locale, "双面", "Double-sided")}</button></div>
            </div>
            {selected.kind === "model" && (
              <div className="field explosion-field">
                <span>{tr(locale, "模型爆炸", "Model explosion")}</span><output>{Math.round(explosionFactor * 100)}%</output>
                <input disabled={selectionLocked} className="range" type="range" min="0" max="2" step="0.01" value={explosionFactor} onChange={(event) => updateExplosion(Number(event.target.value))} />
                <div className="explosion-modes">
                  {(["radial", "vertical", "x", "y", "z"] as const).map((mode) => <button disabled={selectionLocked} key={mode} className={explosionMode === mode ? "active" : ""} onClick={() => updateExplosion(Math.max(explosionFactor, 0.55), mode)}>{explosionModeName(mode, locale)}</button>)}
                  <button disabled={selectionLocked} onClick={() => updateExplosion(0)}>{tr(locale, "复位", "Reset")}</button>
                </div>
              </div>
            )}
            {engine?.hasAnimation(selected.id) && (
              <div className="animation-control"><span>{tr(locale, "模型动画", "Model animation")}</span><button onClick={() => { engine.setAnimationEnabled(selected.id, !engine.isAnimationEnabled(selected.id)); setRevision((value) => value + 1); }}>{engine.isAnimationEnabled(selected.id) ? <><Pause size={14} />{tr(locale, "暂停", "Pause")}</> : <><Play size={14} />{tr(locale, "播放", "Play")}</>}</button></div>
            )}
            {selectedComponent && (
              <div className="component-actions"><button onClick={() => focusComponent(selectedComponent)}>{tr(locale, "定位", "Focus")}</button><button onClick={() => { engine?.isolateComponents([selectedComponent]); setRevision((value) => value + 1); }}>{tr(locale, "隔离当前", "Isolate")}</button>{engine?.isIsolationActive() && <button onClick={() => { engine.clearIsolation(); setRevision((value) => value + 1); }}>{tr(locale, "恢复全部", "Restore all")}</button>}</div>
            )}
            <TransformFields disabled={selectionLocked} title={tr(locale, "位置", "Position")} transform={selectedTransform.position} onChange={(axis, value) => updateSelectedTransform("position", axis, value)} />
            <TransformFields disabled={selectionLocked} title={tr(locale, "旋转", "Rotation")} transform={{ x: selectedTransform.rotation.x * 180 / Math.PI, y: selectedTransform.rotation.y * 180 / Math.PI, z: selectedTransform.rotation.z * 180 / Math.PI }} suffix="°" onChange={(axis, value) => updateSelectedTransform("rotation", axis, value)} />
            <TransformFields disabled={selectionLocked} title={tr(locale, "缩放", "Scale")} transform={selectedTransform.scale} onChange={(axis, value) => updateSelectedTransform("scale", axis, value)} />
            <StructuredProperties locale={locale} entries={Object.entries(selectionProperties).map(([name, value]) => ({ name, value }))} emptyText={tr(locale, "该对象没有 BIM 属性", "This object has no BIM properties")} />
            <button className="button remove-scene" disabled={selectionLocked} onClick={() => {
              if (selectedLayerId && selectedLayerId !== "root") engine?.deleteSelectedLayer();
              else engine?.removeModel(selected.id);
              setRevision((value) => value + 1);
            }}><Trash2 size={16} />{selectedLayerId && selectedLayerId !== "root" ? tr(locale, "删除当前图层", "Delete layer") : tr(locale, "从场景移除", "Remove from scene")}</button>
          </div>
        ) : (
          <div className="empty-inspector"><MousePointer2 size={30} /><strong>{tr(locale, "选择一个模型或构件", "Select a model or component")}</strong><span>{tr(locale, "点击画布中的对象查看属性并进行编辑", "Click an object in the viewport to inspect and edit it")}</span></div>
        )}
        {measurements.length > 0 && (
          <div className="measurement-list">
            <div className="section-label"><span>{tr(locale, "测量结果", "Measurements")}</span><button onClick={() => { engine?.clearMeasurements(); setMeasurements([]); }}>{tr(locale, "清空", "Clear")}</button></div>
            {measurements.map((item, index) => (
              <div className="measurement-row" key={item.id}>
                <Ruler size={14} />
                <button onClick={() => engine?.focusMeasurement(item)}><span>{measureModeName(item.kind ?? "distance", locale)} {index + 1}</span><strong>{formatMeasurementValue(item)}</strong></button>
                <button className="measurement-delete" title={tr(locale, "删除该测量", "Delete measurement")} onClick={() => deleteMeasurement(item.id)}><X size={13} /></button>
              </div>
            ))}
          </div>
        )}
        {collisions.length > 0 && (
          <div className="collision-list">
            <div className="section-label"><span>{tr(locale, "碰撞结果", "Collisions")}</span><small>{collisions.length}</small></div>
            {collisions.map((item) => <button key={item.id} onClick={() => engine?.focusCollision(item)}><ScanLine size={14} /><span><strong>{item.sourceName}</strong><small>{tr(locale, `与 ${item.targetName} 相交`, `Intersects ${item.targetName}`)}</small></span></button>)}
          </div>
        )}
      </aside>

      <div className="app-copyright">Copyright © 张文鹏 Charlie</div>
    </div>
    <input ref={uploadRef} hidden multiple type="file" accept={ACCEPTED_MODELS} onChange={(event) => void uploadModels(event.target.files ?? undefined)} />
    <input ref={importRef} hidden type="file" accept=".json,.bimscene" onChange={(event) => void importScene(event.target.files?.[0])} />
    <input ref={environmentMapRef} hidden type="file" accept=".hdr,.exr,.jpg,.jpeg,.png,.webp" onChange={(event) => void uploadEnvironmentMap(event.target.files?.[0])} />
    {projectDialogMode && <div className="dialog-backdrop" onMouseDown={() => !busy && setProjectDialogMode(undefined)}>
      <form className="dialog" onSubmit={(event) => { event.preventDefault(); void submitProjectDialog(); }} onMouseDown={(event) => event.stopPropagation()}>
        <span className="eyebrow">{projectDialogMode === "rename" ? "EDIT PROJECT" : "NEW PROJECT"}</span>
        <h2>{projectDialogMode === "rename" ? tr(locale, "编辑项目", "Edit project") : tr(locale, "新建项目", "New project")}</h2>
        <p>{projectDialogMode === "rename" ? tr(locale, "修改项目名称和说明，不影响已有模型与场景。", "Change the project name and description without affecting existing models or scenes.") : tr(locale, "项目用于隔离模型资产和场景，可随时从顶部切换。", "Projects separate model assets and scenes and can be switched from the top bar.")}</p>
        <label><span>{tr(locale, "项目名称", "Project name")}</span><input autoFocus value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder={tr(locale, "例如：研发中心一期", "For example: R&D Center Phase 1")} /></label>
        <label><span>{tr(locale, "项目说明", "Project description")}</span><textarea value={newProjectDescription} onChange={(event) => setNewProjectDescription(event.target.value)} placeholder={tr(locale, "可选", "Optional")} rows={3} /></label>
        <div className="dialog-actions"><button type="button" className="button" disabled={busy} onClick={() => setProjectDialogMode(undefined)}>{tr(locale, "取消", "Cancel")}</button><button className="button primary" disabled={!newProjectName.trim() || busy}>{busy ? tr(locale, "保存中…", "Saving…") : projectDialogMode === "rename" ? tr(locale, "保存修改", "Save changes") : tr(locale, "创建并切换", "Create and switch")}</button></div>
      </form>
    </div>}
    {(route.view === "manager" || route.view === "optimizer") && <div className="global-utility"><button onClick={() => { const next = locale === "zh-CN" ? "en-US" : "zh-CN"; setLocale(next); storeLocale(next); }}><Languages size={15} />{locale === "zh-CN" ? "EN" : "中文"}</button><button onClick={() => setDigitalTwinOpen((value) => !value)}><Radio size={15} />{tr(locale, "数据", "Data")}</button><button onClick={() => setCreditsOpen(true)}><HeartHandshake size={15} />{tr(locale, "致谢", "Credits")}</button></div>}
    {digitalTwinOpen && <DigitalTwinPanel locale={locale} onClose={() => setDigitalTwinOpen(false)} onMessage={(data) => { if (engine?.applySceneDataMessage(data)) { setMessage(`数据 ${data.source}/${data.key} 已映射到场景`); setRevision((value) => value + 1); } }} />}
    {(route.view === "manager" || route.view === "optimizer") && creditsOpen && <CreditsModal locale={locale} onClose={() => setCreditsOpen(false)} />}
    {error && <div className="toast error">{error}</div>}
    </>
  );
}

function ToolButton({ title, active, onClick, icon }: { title: string; active: boolean; onClick: () => void; icon: React.ReactNode }) {
  return <button className={`tool-button ${active ? "active" : ""}`} title={title} onClick={onClick}>{icon}<span>{title}</span></button>;
}

function ViewControl({ locale, onSelect }: { locale: AppLocale; onSelect: (view: StandardView) => void }) {
  return (
    <div className="view-control" aria-label={tr(locale, "标准视图", "Standard views")}>
      <button onClick={() => onSelect("top")}>{tr(locale, "上", "Top")}</button>
      <div><button onClick={() => onSelect("left")}>{tr(locale, "左", "Left")}</button><button onClick={() => onSelect("front")}>{tr(locale, "前", "Front")}</button><button onClick={() => onSelect("right")}>{tr(locale, "右", "Right")}</button></div>
      <div><button onClick={() => onSelect("back")}>{tr(locale, "后", "Back")}</button><button onClick={() => onSelect("bottom")}>{tr(locale, "下", "Bottom")}</button></div>
    </div>
  );
}

function StructuredProperties({ locale, entries, emptyText }: { locale: AppLocale; entries: BimPropertyEntry[]; emptyText: string }) {
  const groups = groupPropertyEntries(entries);
  if (groups.length === 0) return <div className="property-empty">{emptyText}</div>;
  return <div className="structured-properties">
    <div className="section-label property-label"><span>{tr(locale, "BIM 属性", "BIM properties")}</span><small>{entries.length}</small></div>
    {groups.map((group, index) => <details key={group.name} open={index < 2}>
      <summary><span>{tr(locale, group.name, propertyGroupEnglishName(group.name))}</span><small>{group.entries.length}</small><ChevronRight size={12} /></summary>
      <dl className="property-list">{group.entries.map((entry, entryIndex) => <div key={`${entry.name}:${entryIndex}`}><dt title={entry.name}>{entry.name}</dt><dd title={entry.value}>{entry.value}</dd></div>)}</dl>
    </details>)}
  </div>;
}

function spacePropertyEntries(space: BimSpaceRecord, locale: AppLocale): BimPropertyEntry[] {
  const base: BimPropertyEntry[] = [
    { name: tr(locale, "空间 ID", "Space ID"), value: space.id, group: "identity" },
    { name: tr(locale, "名称", "Name"), value: space.name, group: "identity" },
    ...(space.number ? [{ name: tr(locale, "编号", "Number"), value: space.number, group: "identity" }] : []),
    { name: tr(locale, "楼层", "Floor"), value: space.level, group: "constraints" },
    { name: tr(locale, "类型", "Type"), value: space.kind, group: "identity" },
    ...(space.department ? [{ name: tr(locale, "部门", "Department"), value: space.department, group: "identity" }] : []),
    ...(space.areaSquareMetres === undefined ? [] : [{ name: tr(locale, "面积", "Area"), value: `${numberFormat.format(space.areaSquareMetres)} m²`, group: "dimensions" }]),
    ...(space.volumeCubicMetres === undefined ? [] : [{ name: tr(locale, "体积", "Volume"), value: `${numberFormat.format(space.volumeCubicMetres)} m³`, group: "dimensions" }]),
    ...(space.bounds ? [
      { name: tr(locale, "边界最小点", "Bounds minimum"), value: formatVector(space.bounds.min), group: "dimensions" },
      { name: tr(locale, "边界最大点", "Bounds maximum"), value: formatVector(space.bounds.max), group: "dimensions" }
    ] : [])
  ];
  return [...base, ...(space.parameters ?? [])];
}

function groupPropertyEntries(entries: BimPropertyEntry[]) {
  const names = ["基本信息", "标识与分类", "位置与尺寸", "材质", "约束", "能耗与负荷", "阶段与 IFC", "其他参数"] as const;
  const grouped = new Map<string, BimPropertyEntry[]>(names.map((name) => [name, []]));
  for (const entry of entries) {
    const token = `${entry.group ?? ""} ${entry.name}`.toLocaleLowerCase("zh-CN");
    let group: typeof names[number] = "其他参数";
    if (/名称|name|类型|type|对象数量|构件数量/.test(token)) group = "基本信息";
    else if (/identity|编号|id|guid|类别|category|族|family|department|部门/.test(token)) group = "标识与分类";
    else if (/dimension|面积|体积|长度|宽度|高度|周长|尺寸|坐标|边界|位置|offset|偏移/.test(token)) group = "位置与尺寸";
    else if (/material|材质|混凝土|钢|木|玻璃/.test(token)) group = "材质";
    else if (/constraint|约束|标高|level|上限|底部|顶部/.test(token)) group = "约束";
    else if (/energy|负荷|功率|照明|热增量|人数/.test(token)) group = "能耗与负荷";
    else if (/phase|ifc|阶段/.test(token)) group = "阶段与 IFC";
    grouped.get(group)?.push(entry);
  }
  return names.flatMap((name) => {
    const groupEntries = grouped.get(name) ?? [];
    return groupEntries.length ? [{ name, entries: groupEntries }] : [];
  });
}

function propertyGroupEnglishName(name: string): string {
  if (name === "基本信息") return "General";
  if (name === "标识与分类") return "Identity and classification";
  if (name === "位置与尺寸") return "Location and dimensions";
  if (name === "材质") return "Materials";
  if (name === "约束") return "Constraints";
  if (name === "能耗与负荷") return "Energy and loads";
  if (name === "阶段与 IFC") return "Phasing and IFC";
  return "Other parameters";
}

function TransformFields({ title, transform, suffix, disabled = false, onChange }: {
  title: string;
  transform: { x: number; y: number; z: number };
  suffix?: string;
  disabled?: boolean;
  onChange: (axis: "x" | "y" | "z", value: string) => void;
}) {
  return (
    <fieldset className="transform-fields">
      <legend>{title}</legend>
      <div>{(["x", "y", "z"] as const).map((axis) => <label key={axis}><span>{axis.toUpperCase()}</span><input disabled={disabled} type="number" step="0.1" value={Number(transform[axis].toFixed(3))} onChange={(event) => onChange(axis, event.target.value)} />{suffix && <i>{suffix}</i>}</label>)}</div>
    </fieldset>
  );
}

function statusText(model: ModelRecord, loaded: boolean, locale: AppLocale): string {
  if (loaded) return tr(locale, "已载入场景", "Loaded in scene");
  if (model.status === "ready") return `${formatBytes(model.size)} · ${tr(locale, "点击加载", "Click to load")}`;
  if (model.status === "processing") return `${model.progress}% · ${model.message}`;
  if (model.status === "waiting_converter") return tr(locale, "等待 Revit 转换机", "Waiting for Revit converter");
  if (model.status === "failed") return `${tr(locale, "失败", "Failed")} · ${model.message}`;
  return model.message;
}

function formatBytes(size: number): string {
  if (size < 1024 * 1024) return `${numberFormat.format(size / 1024)} KB`;
  return `${numberFormat.format(size / 1024 / 1024)} MB`;
}

function measureModeName(mode: MeasureMode, locale: AppLocale): string {
  if (mode === "minimum") return tr(locale, "最小距离", "Minimum distance");
  if (mode === "angle") return tr(locale, "角度测量", "Angle");
  if (mode === "elevation") return tr(locale, "标高测量", "Elevation");
  if (mode === "horizontal") return tr(locale, "水平距离", "Horizontal distance");
  if (mode === "vertical") return tr(locale, "垂直高度", "Vertical height");
  return tr(locale, "距离测量", "Distance");
}

function formatMeasurementValue(measurement: MeasurementState): string {
  if (measurement.kind === "angle") return `${numberFormat.format((measurement.angle ?? 0) * 180 / Math.PI)}°`;
  if (measurement.kind === "elevation") {
    const elevation = measurement.elevation ?? measurement.end.y;
    return `${elevation >= 0 ? "+" : ""}${numberFormat.format(elevation)} m`;
  }
  const distance = measurement.distance;
  if (distance < 1) return `${Math.round(distance * 1000)} mm`;
  return `${numberFormat.format(distance)} m`;
}

function explosionModeName(mode: ExplosionMode, locale: AppLocale): string {
  if (mode === "vertical") return tr(locale, "楼层", "Floors");
  if (mode === "x") return tr(locale, "X 轴", "X axis");
  if (mode === "y") return tr(locale, "Y 轴", "Y axis");
  if (mode === "z") return tr(locale, "Z 轴", "Z axis");
  return tr(locale, "径向", "Radial");
}

function skyboxEnglishLabel(preset: SkyboxPreset): string {
  if (preset === "none") return "Solid";
  if (preset === "clear") return "Clear sky";
  if (preset === "sunset") return "Sunset";
  return "Night";
}

function lightTypeName(type: SceneLightState["type"]): string {
  if (type === "ambient") return "环境光";
  if (type === "hemisphere") return "半球光";
  if (type === "directional") return "方向光";
  if (type === "point") return "点光源";
  if (type === "spot") return "聚光灯";
  return "矩形区域光";
}

function lightTypeEnglishName(type: SceneLightState["type"]): string {
  if (type === "ambient") return "Ambient";
  if (type === "hemisphere") return "Hemisphere";
  if (type === "directional") return "Directional";
  if (type === "point") return "Point";
  if (type === "spot") return "Spot";
  return "Rect area";
}

function formatVector(vector: { x: number; y: number; z: number }): string {
  return `${vector.x.toFixed(2)}, ${vector.y.toFixed(2)}, ${vector.z.toFixed(2)}`;
}
