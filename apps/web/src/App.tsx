import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Box,
  Camera,
  CloudRain,
  ChevronDown,
  ChevronRight,
  DoorOpen,
  Eye,
  EyeOff,
  Footprints,
  Focus,
  Film,
  Import,
  Info,
  Layers3,
  LayoutGrid,
  LoaderCircle,
  Lightbulb,
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
  SceneSnapshot,
  SkyboxPreset,
  WeatherMode
} from "@bim-studio/contracts";
import { api } from "./api";
import { LayerTree } from "./components/LayerTree";
import { SceneManager } from "./components/SceneManager";
import { SceneExportMenu } from "./components/SceneExportMenu";
import { SpaceTree } from "./components/SpaceTree";
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
  type SelectionScope,
  type StandardView,
  type TransformMode
} from "./viewer/ViewerEngine";

const ACCEPTED_MODELS = ".rvt,.ifc,.step,.stp,.dwg,.dxf,.gltf,.glb,.fbx";
const numberFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const DEFAULT_LIGHTING: GlobalLightingState = { enabled: true, intensity: 1 };
const DEFAULT_ENVIRONMENT: SceneEnvironmentState = { gridVisible: true, backgroundColor: "#202a31", skybox: "none" };
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
  const sceneNameCommitRef = useRef<Promise<boolean> | undefined>(undefined);
  const [engine, setEngine] = useState<ViewerEngine>();
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
  const [weather, setWeather] = useState<WeatherMode>("sunny");
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [lighting, setLighting] = useState<GlobalLightingState>(DEFAULT_LIGHTING);
  const [sceneEnvironment, setSceneEnvironment] = useState<SceneEnvironmentState>(DEFAULT_ENVIRONMENT);
  const [sceneAnimation, setSceneAnimation] = useState<SceneAnimationState>(DEFAULT_ANIMATION);
  const [animationTime, setAnimationTime] = useState(0);
  const [animationPlaying, setAnimationPlaying] = useState(false);
  const [animationOpen, setAnimationOpen] = useState(false);
  const [componentQuery, setComponentQuery] = useState("");
  const [componentLevel, setComponentLevel] = useState("");
  const [componentCategory, setComponentCategory] = useState("");
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

  function navigate(next: AppRoute, replace = false) {
    const path = next.view === "manager" || next.view === "optimizer"
      ? `/${next.view}`
      : `/${next.view}/${encodeURIComponent(next.sceneId ?? "new")}`;
    window.history[replace ? "replaceState" : "pushState"]({}, "", path);
    setRoute(next);
  }

  useEffect(() => {
    if (!viewportRef.current) return;
    const viewer = new ViewerEngine(viewportRef.current);
    let revisionFrame: number | undefined;
    const requestRevision = () => {
      if (revisionFrame !== undefined) return;
      revisionFrame = window.requestAnimationFrame(() => {
        revisionFrame = undefined;
        setRevision((value) => value + 1);
      });
    };
    viewer.onSelectionChange = (model) => {
      setSelected(model);
      setSelectedSpace(undefined);
      setRevision((value) => value + 1);
    };
    viewer.onModelChange = requestRevision;
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
      else if (viewer.getNavigationMode() === "orbit") setMessage("测量工具就绪");
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
    return () => {
      if (revisionFrame !== undefined) window.cancelAnimationFrame(revisionFrame);
      viewer.dispose();
      setEngine(undefined);
    };
  }, []);

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
  const selectionProperties = useMemo(() => engine?.getSelectionProperties() ?? {}, [engine, selected, revision]);
  const selectedLayerId = engine?.getSelectedLayerId();
  const selectedComponent = engine?.getSelectedComponentRecord();
  const selectionLocked = engine?.isSelectionLocked() ?? false;
  const componentFacets = useMemo(() => engine?.getComponentFacets() ?? { levels: [], categories: [], specialties: [] }, [engine, revision]);
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
    setMessage(factor > 0 ? `模型爆炸 ${Math.round(factor * 100)}% · ${explosionModeName(mode)}` : "已恢复模型组合");
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
        return transform ? [{
          modelId: item.id,
          name: item.name,
          ...(source ? { sourceName: source.name, sourceFormat: source.format } : {}),
          visible: item.visible,
          locked: engine.isModelLocked(item.id),
          opacity: item.opacity,
          ...(colorOverride ? { colorOverride } : {}),
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
      const nextLighting = scene.lighting ?? DEFAULT_LIGHTING;
      const nextEnvironment = scene.environment ?? DEFAULT_ENVIRONMENT;
      const nextAnimation = scene.animation ?? DEFAULT_ANIMATION;
      engine.setWeather(nextWeather);
      engine.setGlobalLighting(nextLighting);
      engine.setSceneEnvironment(nextEnvironment);
      engine.setSceneAnimation(nextAnimation);
      engine.seekSceneAnimation(0);
      setWeather(nextWeather);
      setLighting(nextLighting);
      setSceneEnvironment(nextEnvironment);
      setSceneAnimation(nextAnimation);
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
      {route.view === "optimizer" && <Suspense fallback={<div className="optimizer-loading"><LoaderCircle className="spin" size={25} />正在加载模型优化器</div>}><ModelOptimizer onBack={() => navigate({ view: "manager" })} /></Suspense>}
      {route.view === "manager" && (
        <SceneManager
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
        />
      )}
    <div className={`app-shell ${route.view === "view" || route.view === "published" ? "viewer-shell" : ""} ${route.view === "studio" || route.view === "view" || route.view === "published" ? "" : "app-shell-hidden"}`}>
      <header className="topbar">
        <div className="brand-mark"><img src={`${import.meta.env.BASE_URL}brand/logo-transparent.png`} alt="BIM Studio" /></div>
        <div className="brand-copy"><strong>BIM Studio</strong><span>{route.view === "studio" ? "空间编排工作台" : "场景浏览"}</span></div>
        <div className="topbar-divider" />
        {route.view === "studio" ? <>
        <select
          className="project-select"
          value={project?.id ?? ""}
          onChange={(event) => switchProjectById(event.target.value)}
          aria-label="当前项目"
        >
          {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button className="project-add-button" title="新建项目" onClick={() => openProjectDialog("create")}><Plus size={15} /></button>
        <div className="scene-title-wrap">
          <span>场景</span>
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
            aria-label="场景名称"
          />
        </div>
        <div className="topbar-actions">
          <button className="button ghost" onClick={() => void commitSceneName().then((committed) => committed && navigate({ view: "manager" }))}><LayoutGrid size={16} />场景管理</button>
          <button className="button ghost" onClick={() => importRef.current?.click()}><Import size={16} />导入</button>
          <SceneExportMenu disabled={busy} onExportLoose={() => exportSceneConfig()} onExportSingle={() => void exportSingleFileScene()} onExportGlb={() => void exportGlbScene()} />
          <button className="button primary" onClick={() => void saveScene()} disabled={busy}><Save size={16} />保存场景</button>
        </div>
        </> : <>
          <div className="viewer-scene-title"><span className="viewer-mode-badge"><Rocket size={13} />{route.view === "published" ? "已发布版本" : "当前保存版本"}</span><strong>{sceneName}</strong></div>
          <div className="topbar-actions"><button className="button ghost" onClick={() => navigate({ view: "manager" })}><ArrowLeft size={16} />返回场景管理</button></div>
        </>}
      </header>

      <aside className="left-panel">
        <div className="panel-heading">
          <div><span className="eyebrow">PROJECT DIRECTORY</span><h2>目录树</h2></div>
          <button className="icon-button" title="上传模型" onClick={() => uploadRef.current?.click()} disabled={uploading}>
            {uploading ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />}
          </button>
        </div>
        <div className="rvt-route-switch" aria-label="RVT 转换链路">
          <span>RVT 转换</span>
          <button className={rvtConversionMode === "native-glb" ? "active" : ""} onClick={() => setRvtConversionMode("native-glb")}><strong>原生 GLB</strong><small>快速 · 推荐</small></button>
          <button className={rvtConversionMode === "ifc" ? "active" : ""} onClick={() => setRvtConversionMode("ifc")}><strong>IFC</strong><small>兼容备用</small></button>
        </div>
        <button className="upload-zone" onClick={() => uploadRef.current?.click()}>
          <Upload size={20} /><span>上传模型</span><small>RVT · IFC · STEP · DWG · GLB · FBX · DXF</small>
        </button>
        <div className="directory-tabs" role="tablist" aria-label="目录类型">
          <button className={directoryMode === "components" ? "active" : ""} onClick={() => setDirectoryMode("components")}>构件</button>
          <button className={directoryMode === "spaces" ? "active" : ""} onClick={() => setDirectoryMode("spaces")}>空间 <small>{spaces.length}</small></button>
        </div>
        {directoryMode === "components" && <section className="component-search" aria-label="构件查询">
          <div className="component-search-input"><Search size={15} /><input value={componentQuery} onChange={(event) => setComponentQuery(event.target.value)} placeholder="搜索名称、ID、属性" aria-label="搜索构件" />{componentQuery && <button title="清空搜索" onClick={() => setComponentQuery("")}><X size={13} /></button>}</div>
          {(componentFacets.levels.length > 0 || componentFacets.categories.length > 0) && (
            <div className="component-filters">
              <select value={componentLevel} onChange={(event) => setComponentLevel(event.target.value)} aria-label="按楼层筛选"><option value="">全部楼层</option>{componentFacets.levels.map((value) => <option key={value} value={value}>{value}</option>)}</select>
              <select value={componentCategory} onChange={(event) => setComponentCategory(event.target.value)} aria-label="按类别筛选"><option value="">全部类别</option>{componentFacets.categories.map((value) => <option key={value} value={value}>{value}</option>)}</select>
            </div>
          )}
          {componentSearchActive && (
            <div className="component-results">
              <div className="component-results-head"><span>{componentResults.length} 个结果</span><div><button disabled={componentResults.length === 0} onClick={() => { engine?.isolateComponents(componentResults); setRevision((value) => value + 1); }}>隔离结果</button>{engine?.isIsolationActive() && <button onClick={() => { engine.clearIsolation(); setRevision((value) => value + 1); }}>恢复</button>}</div></div>
              <div className="component-result-list">
                {componentResults.map((record) => <button key={record.stableId} className={selectedComponent?.stableId === record.stableId ? "selected" : ""} onClick={() => focusComponent(record)}><strong title={record.name}>{record.name}</strong><small>{[record.level, record.category, record.type].filter(Boolean).join(" · ")}</small></button>)}
                {componentResults.length === 0 && <span className="component-no-result">没有匹配构件</span>}
              </div>
            </div>
          )}
        </section>}
        <div className="asset-list">
          {directoryMode === "spaces" ? <SpaceTree
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
            return (
              <div className="model-tree-item" key={model.id}>
                <div className={`asset-row ${selected?.id === model.id ? "selected" : ""}`}>
                  <button className="model-expander" disabled={!loaded} title={expanded ? "收起模型结构" : "展开模型结构"} onClick={() => loaded && toggleModelTree(model.id)}>
                    {loaded ? expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span />}
                  </button>
                  <button className="asset-main" onClick={() => loaded ? engine?.select(model.id) : void loadModel(model)}>
                    <span className={`format-badge format-${model.format}`}>{model.format.toUpperCase()}</span>
                    <span className="asset-copy"><strong title={model.name}>{model.name}</strong><small>{statusText(model, Boolean(loaded))}</small></span>
                  </button>
                  {loaded && <button className="mini-button" title={loaded.visible ? "隐藏" : "显示"} onClick={() => engine?.setVisible(model.id, !loaded.visible)}>{loaded.visible ? <Eye size={15} /> : <EyeOff size={15} />}</button>}
                  {loaded && <button className={`mini-button ${engine?.isModelLocked(model.id) ? "active" : ""}`} title={engine?.isModelLocked(model.id) ? "解锁模型" : "锁定模型"} onClick={() => { engine?.setModelLocked(model.id, !engine.isModelLocked(model.id)); setRevision((value) => value + 1); }}>{engine?.isModelLocked(model.id) ? <Lock size={14} /> : <Unlock size={14} />}</button>}
                  {loaded && (
                    <button
                      className={`mini-button collision-toggle ${engine?.isCollisionEnabled(model.id) ? "active" : ""} ${engine?.isColliding(model.id) ? "colliding" : ""}`}
                      title={engine?.isCollisionEnabled(model.id) ? "关闭碰撞检测" : "开启碰撞检测"}
                      onClick={() => engine?.setCollisionEnabled(model.id, !engine.isCollisionEnabled(model.id))}
                    >
                      <ScanLine size={15} />
                    </button>
                  )}
                  {loaded && engine?.hasAnimation(model.id) && (
                    <button
                      className={`mini-button ${engine.isAnimationEnabled(model.id) ? "active" : ""}`}
                      title={engine.isAnimationEnabled(model.id) ? "暂停模型动画" : "播放模型动画"}
                      onClick={() => { engine.setAnimationEnabled(model.id, !engine.isAnimationEnabled(model.id)); setRevision((value) => value + 1); }}
                    >
                      {engine.isAnimationEnabled(model.id) ? <Pause size={14} /> : <Play size={14} />}
                    </button>
                  )}
                  <button className="mini-button danger" disabled={Boolean(loaded && engine?.isModelLocked(model.id))} title={loaded && engine?.isModelLocked(model.id) ? "请先解锁模型" : "删除模型"} onClick={() => void deleteModel(model)}><Trash2 size={15} /></button>
                </div>
                {expanded && tree && (
                  <LayerTree
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
          }) : scenePrimitives.length === 0 && measurements.length === 0 && annotations.length === 0 ? <div className="empty-state"><Layers3 size={28} /><strong>还没有模型</strong><span>上传文件或插入正方体开始构建场景</span></div> : null}
          {(scenePrimitives.length > 0 || measurements.length > 0 || annotations.length > 0) && (
            <section className="scene-object-layers" aria-label="场景对象图层">
              <div className="scene-object-heading"><span>场景对象</span><small>{scenePrimitives.length + measurements.length + annotations.length}</small></div>
              {scenePrimitives.map((primitive) => (
                <div className={`asset-row scene-object-row ${selected?.id === primitive.id ? "selected" : ""}`} key={primitive.id}>
                  <span className="model-expander" />
                  <button className="asset-main" onClick={() => engine?.select(primitive.id)}>
                    <span className="scene-object-badge"><Box size={15} /></span>
                    <span className="asset-copy"><strong>{primitive.name}</strong><small>基础元素 · 可编辑</small></span>
                  </button>
                  <button className="mini-button" title={primitive.visible ? "隐藏正方体" : "显示正方体"} onClick={() => engine?.setVisible(primitive.id, !primitive.visible)}>{primitive.visible ? <Eye size={15} /> : <EyeOff size={15} />}</button>
                  <button className={`mini-button ${engine?.isModelLocked(primitive.id) ? "active" : ""}`} title={engine?.isModelLocked(primitive.id) ? "解锁正方体" : "锁定正方体"} onClick={() => { engine?.setModelLocked(primitive.id, !engine.isModelLocked(primitive.id)); setRevision((value) => value + 1); }}>{engine?.isModelLocked(primitive.id) ? <Lock size={14} /> : <Unlock size={14} />}</button>
                  <button
                    className={`mini-button collision-toggle ${engine?.isCollisionEnabled(primitive.id) ? "active" : ""} ${engine?.isColliding(primitive.id) ? "colliding" : ""}`}
                    title={engine?.isCollisionEnabled(primitive.id) ? "关闭正方体碰撞检测" : "开启正方体碰撞检测"}
                    onClick={() => engine?.setCollisionEnabled(primitive.id, !engine.isCollisionEnabled(primitive.id))}
                  >
                    <ScanLine size={15} />
                  </button>
                  <button className="mini-button danger" disabled={engine?.isModelLocked(primitive.id)} title={engine?.isModelLocked(primitive.id) ? "请先解锁正方体" : "删除正方体"} onClick={() => deletePrimitive(primitive.id)}><Trash2 size={15} /></button>
                </div>
              ))}
              {measurements.map((measurement, index) => (
                <div className="asset-row scene-object-row" key={measurement.id}>
                  <span className="model-expander" />
                  <button className="asset-main" onClick={() => engine?.focusMeasurement(measurement)}>
                    <span className="scene-object-badge"><Ruler size={15} /></span>
                    <span className="asset-copy"><strong>测量 {index + 1}</strong><small>{measureModeName(measurement.kind ?? "distance")} · {formatMeasurementValue(measurement)}</small></span>
                  </button>
                  <button className="mini-button danger" title={`删除标尺 ${index + 1}`} onClick={() => deleteMeasurement(measurement.id)}><Trash2 size={15} /></button>
                </div>
              ))}
              {annotations.map((annotation) => (
                <div className={`asset-row scene-object-row ${selectedAnnotationId === annotation.id ? "selected" : ""}`} key={annotation.id}>
                  <span className="model-expander" />
                  <button className="asset-main" onClick={() => engine?.focusAnnotation(annotation.id)}>
                    <span className="scene-object-badge annotation-badge" style={{ color: annotation.color }}><MapPin size={15} /></span>
                    <span className="asset-copy"><strong>{annotation.name}</strong><small>{annotation.anchorName || "场景标签"}</small></span>
                  </button>
                  <button className="mini-button" title={annotation.visible ? "隐藏标签" : "显示标签"} onClick={() => updateAnnotation(annotation.id, { visible: !annotation.visible })}>{annotation.visible ? <Eye size={15} /> : <EyeOff size={15} />}</button>
                  <button className={`mini-button ${annotation.locked ? "active" : ""}`} title={annotation.locked ? "解锁标签" : "锁定标签"} onClick={() => updateAnnotation(annotation.id, { locked: !annotation.locked })}>{annotation.locked ? <Lock size={14} /> : <Unlock size={14} />}</button>
                  <button className="mini-button danger" disabled={annotation.locked} title={annotation.locked ? "请先解锁标签" : "删除标签"} onClick={() => deleteAnnotation(annotation.id)}><Trash2 size={15} /></button>
                </div>
              ))}
            </section>
          )}
          </>}
        </div>
      </aside>

      <main className="workspace">
        <div className="viewport" ref={viewportRef} />
        <div className="tool-dock" role="toolbar" aria-label="查看编辑工具">
          {route.view === "view" || route.view === "published" ? <>
            <ToolButton title="适应全部（回到模型）" active={false} onClick={() => engine?.fitAll()} icon={<Focus size={19} />} />
            <ToolButton title="轨道浏览（围绕模型旋转）" active={navigationMode === "orbit"} onClick={() => changeNavigation("orbit")} icon={<Orbit size={19} />} />
            <ToolButton title="第一人称（地面行走）" active={navigationMode === "firstPerson"} onClick={() => changeNavigation("firstPerson")} icon={<Footprints size={19} />} />
            <ToolButton title="第三人称（空中漫游）" active={navigationMode === "thirdPerson"} onClick={() => changeNavigation("thirdPerson")} icon={<UserRound size={19} />} />
            <ToolButton title={avatarVisible ? "隐藏人物" : "显示人物"} active={avatarVisible} onClick={() => { const next = !avatarVisible; setAvatarVisible(next); engine?.setAvatarVisible(next); }} icon={avatarVisible ? <Eye size={19} /> : <EyeOff size={19} />} />
            <ToolButton title="场景信息" active={infoEnabled} onClick={() => setInfoEnabled((value) => !value)} icon={<Info size={19} />} />
          </> : <>
          <ToolButton title="适应全部（回到模型）" active={false} onClick={() => engine?.fitAll()} icon={<Focus size={19} />} />
          <span className="dock-separator" />
          <ToolButton title="选择" active={!measureEnabled && !annotationEnabled && navigationMode === "orbit"} onClick={() => changeNavigation("orbit")} icon={<MousePointer2 size={19} />} />
          <ToolButton title="移动模型" active={transformMode === "translate"} onClick={() => changeTransform("translate")} icon={<Move size={19} />} />
          <ToolButton title="旋转模型" active={transformMode === "rotate"} onClick={() => changeTransform("rotate")} icon={<RotateCw size={19} />} />
          <ToolButton title="缩放模型" active={transformMode === "scale"} onClick={() => changeTransform("scale")} icon={<Scaling size={19} />} />
          <ToolButton title="构件选择" active={selectionScope === "component"} onClick={() => { const next = selectionScope === "model" ? "component" : "model"; setSelectionScope(next); engine?.setSelectionScope(next); setMessage(next === "component" ? "构件选择已开启：画布点击可深入选择构件" : "模型选择已开启：画布点击只选择整个模型"); }} icon={<MousePointer2 size={19} />} />
          <span className="dock-separator" />
          <ToolButton title="测量工具" active={measureEnabled} onClick={toggleMeasurement} icon={<Ruler size={19} />} />
          <ToolButton title="添加立方体" active={false} onClick={addBox} icon={<Box size={19} />} />
          <ToolButton title="标签标记" active={annotationEnabled} onClick={toggleAnnotationPlacement} icon={<MapPin size={19} />} />
          <ToolButton title="剖切模型" active={clipping.enabled} onClick={toggleClipping} icon={<ScanLine size={19} />} />
          <ToolButton title="模型爆炸" active={explosionFactor > 0} onClick={() => updateExplosion(explosionFactor > 0 ? 0 : 0.55)} icon={<Layers3 size={19} />} />
          <span className="dock-separator" />
          <ToolButton title="轨道浏览（围绕模型旋转）" active={navigationMode === "orbit"} onClick={() => changeNavigation("orbit")} icon={<Orbit size={19} />} />
          <ToolButton title="第一人称（地面行走）" active={navigationMode === "firstPerson"} onClick={() => changeNavigation("firstPerson")} icon={<Footprints size={19} />} />
          <ToolButton title="第三人称（空中漫游）" active={navigationMode === "thirdPerson"} onClick={() => changeNavigation("thirdPerson")} icon={<UserRound size={19} />} />
          <ToolButton
            title={avatarVisible ? "隐藏人物" : "显示人物"}
            active={avatarVisible}
            onClick={() => {
              const next = !avatarVisible;
              setAvatarVisible(next);
              engine?.setAvatarVisible(next);
            }}
            icon={avatarVisible ? <Eye size={19} /> : <EyeOff size={19} />}
          />
          <span className="dock-separator" />
          <ToolButton title="场景信息" active={infoEnabled} onClick={() => setInfoEnabled((value) => !value)} icon={<Info size={19} />} />
          <ToolButton title="环境设置" active={environmentOpen} onClick={() => setEnvironmentOpen((value) => !value)} icon={<Sun size={19} />} />
          <ToolButton title="动画编辑" active={animationOpen} onClick={() => setAnimationOpen((value) => !value)} icon={<Film size={19} />} />
          </>}
        </div>
        <ViewControl onSelect={(view) => engine?.setStandardView(view)} />
        {route.view === "studio" && environmentOpen && <div className="environment-control" aria-label="环境与全局灯光">
          <div className="environment-heading"><strong>场景环境</strong><small>随场景保存</small></div>
          <div className="environment-row">
            <span>天气</span>
            <div className="environment-weather">
              <button className={weather === "sunny" ? "active" : ""} title="晴天" onClick={() => changeWeather("sunny")}><Sun size={15} /></button>
              <button className={weather === "rain" ? "active" : ""} title="下雨" onClick={() => changeWeather("rain")}><CloudRain size={15} /></button>
              <button className={weather === "snow" ? "active" : ""} title="下雪" onClick={() => changeWeather("snow")}><Snowflake size={15} /></button>
            </div>
          </div>
          <div className="environment-row">
            <span>天空</span>
            <div className="skybox-presets">
              {SKYBOX_OPTIONS.map((option) => <button key={option.value} className={sceneEnvironment.skybox === option.value ? `active skybox-${option.value}` : `skybox-${option.value}`} onClick={() => changeSceneEnvironment({ ...sceneEnvironment, skybox: option.value })}>{option.label}</button>)}
            </div>
          </div>
          <div className="environment-row environment-compact-row">
            <span>背景</span>
            <label className={sceneEnvironment.skybox === "none" ? "environment-color" : "environment-color disabled"} title={sceneEnvironment.skybox === "none" ? "设置纯色背景" : "选择纯色天空后可设置背景颜色"}>
              <input type="color" value={sceneEnvironment.backgroundColor} disabled={sceneEnvironment.skybox !== "none"} onChange={(event) => changeSceneEnvironment({ ...sceneEnvironment, backgroundColor: event.target.value })} aria-label="场景背景颜色" />
              <output>{sceneEnvironment.backgroundColor.toUpperCase()}</output>
            </label>
            <button className={`grid-toggle ${sceneEnvironment.gridVisible ? "active" : ""}`} title={sceneEnvironment.gridVisible ? "隐藏网格" : "显示网格"} onClick={() => changeSceneEnvironment({ ...sceneEnvironment, gridVisible: !sceneEnvironment.gridVisible })}>{sceneEnvironment.gridVisible ? <Eye size={14} /> : <EyeOff size={14} />}网格</button>
          </div>
          <div className="environment-row environment-light-row">
            <span>灯光</span>
            <button className={`lighting-toggle ${lighting.enabled ? "active" : ""}`} title={lighting.enabled ? "关闭全局灯光" : "开启全局灯光"} onClick={() => changeLighting({ ...lighting, enabled: !lighting.enabled })}><Lightbulb size={15} /></button>
            <input type="range" min="0" max="2.5" step="0.05" value={lighting.intensity} disabled={!lighting.enabled} onChange={(event) => changeLighting({ ...lighting, intensity: Number(event.target.value) })} aria-label="全局灯光强度" />
            <output>{Math.round(lighting.intensity * 100)}%</output>
          </div>
        </div>}
        {route.view === "studio" && measureEnabled && (
          <div className="measure-mode-bar" aria-label="测量模式">
            <span>测量</span>
            <button className={measureMode === "distance" ? "active" : ""} onClick={() => changeMeasureMode("distance")}>距离</button>
            <button className={measureMode === "minimum" ? "active" : ""} onClick={() => changeMeasureMode("minimum")}>最小距离</button>
            <button className={measureMode === "angle" ? "active" : ""} onClick={() => changeMeasureMode("angle")}>角度</button>
            <button className={measureMode === "elevation" ? "active" : ""} onClick={() => changeMeasureMode("elevation")}>标高</button>
            <small>Esc 取消当前起点</small>
          </div>
        )}
        {route.view === "studio" && annotationEnabled && (
          <div className="annotation-placement-bar" aria-label="标签放置模式">
            <MapPin size={15} /><strong>标签标记</strong><span>点击模型表面或地面连续放置标签</span><small>放置后在右侧编辑</small><button title="退出标签放置" onClick={toggleAnnotationPlacement}><X size={14} /></button>
          </div>
        )}
        {route.view === "studio" && clipping.enabled && (
          <div className={`clipping-bar clipping-${clipping.mode ?? "axis"}`} aria-label="剖切设置">
            <div className="clipping-tabs">
              <span>剖切</span>
              <button className={(clipping.mode ?? "axis") === "box" ? "active" : ""} onClick={() => changeClippingMode("box")}>剖切盒</button>
              <button className={(clipping.mode ?? "axis") === "axis" ? "active" : ""} onClick={() => changeClippingMode("axis")}>轴向剖切</button>
              <button className={clipping.mode === "face" ? "active" : ""} onClick={() => changeClippingMode("face")}>拾取面</button>
              <button title="关闭剖切" onClick={toggleClipping}><X size={14} /></button>
            </div>
            {(clipping.mode ?? "axis") === "axis" && <div className="clipping-axis-controls">
              {(["x", "y", "z"] as const).map((axis) => <button key={axis} className={clipping.axis === axis ? "active" : ""} onClick={() => updateClipping({ axis })}>{axis.toUpperCase()}</button>)}
              <input type="range" min={clippingRange.min} max={clippingRange.max} step={Math.max((clippingRange.max - clippingRange.min) / 200, 0.001)} value={clipping.offset} onChange={(event) => updateClipping({ offset: Number(event.target.value) })} aria-label="剖切位置" />
              <output>{clipping.offset.toFixed(2)} m</output>
              <button className={clipping.inverted ? "active" : ""} onClick={() => updateClipping({ inverted: !clipping.inverted })}>反向</button>
            </div>}
            {clipping.mode === "box" && <div className="clipping-box-controls">
              {(["x", "y", "z"] as const).map((axis) => <div className="clipping-bound-row" key={axis}>
                <strong>{axis.toUpperCase()}</strong><span>最小</span>
                <input type="range" min={clippingSceneBounds.min[axis]} max={clippingSceneBounds.max[axis]} step={Math.max((clippingSceneBounds.max[axis] - clippingSceneBounds.min[axis]) / 200, 0.001)} value={(clipping.box ?? clippingSceneBounds).min[axis]} onChange={(event) => updateClippingBox(axis, "min", Number(event.target.value))} />
                <span>最大</span>
                <input type="range" min={clippingSceneBounds.min[axis]} max={clippingSceneBounds.max[axis]} step={Math.max((clippingSceneBounds.max[axis] - clippingSceneBounds.min[axis]) / 200, 0.001)} value={(clipping.box ?? clippingSceneBounds).max[axis]} onChange={(event) => updateClippingBox(axis, "max", Number(event.target.value))} />
              </div>)}
              <button onClick={() => { if (engine) updateClipping({ box: engine.getClippingBounds(), showHelper: true }); }}>重置边界</button>
              <button className={clipping.showHelper === false ? "" : "active"} onClick={() => updateClipping({ showHelper: clipping.showHelper === false })}>显示边框</button>
            </div>}
            {clipping.mode === "face" && <div className="clipping-face-controls">
              <span>{clipping.face ? "剖切面已建立" : "请在模型上点击一个面"}</span>
              <button onClick={() => changeClippingMode("face")}>重新拾取</button>
              <button className={clipping.inverted ? "active" : ""} disabled={!clipping.face} onClick={() => updateClipping({ inverted: !clipping.inverted })}>反向</button>
            </div>}
          </div>
        )}
        {animationOpen && (
          <div className="timeline-panel" aria-label="场景动画编辑器">
            <div className="timeline-main">
              <button className="timeline-jump" title="回到开始" onClick={() => engine?.seekSceneAnimation(0)}>0</button>
              <button className="timeline-play" title={animationPlaying ? "暂停" : "播放"} onClick={toggleSceneAnimation}>{animationPlaying ? <Pause size={16} /> : <Play size={16} />}</button>
              <span className="timeline-time">{animationTime.toFixed(1)}s</span>
              <input className="timeline-range" type="range" min="0" max={sceneAnimation.duration} step="0.05" value={animationTime} onChange={(event) => engine?.seekSceneAnimation(Number(event.target.value))} aria-label="动画时间" />
              <label className="timeline-duration"><span>时长</span><input type="number" min="0.1" step="0.5" value={sceneAnimation.duration} onChange={(event) => updateSceneAnimation({ ...sceneAnimation, duration: Math.max(Number(event.target.value) || 0.1, 0.1) })} /><i>s</i></label>
              <label className="timeline-loop"><input type="checkbox" checked={sceneAnimation.loop} onChange={(event) => updateSceneAnimation({ ...sceneAnimation, loop: event.target.checked })} />循环</label>
              <label className="timeline-loop"><input type="checkbox" checked={sceneAnimation.pingPong ?? false} onChange={(event) => updateSceneAnimation({ ...sceneAnimation, pingPong: event.target.checked })} />往返</label>
            </div>
            <div className="timeline-options">
              <label><span>相机插值</span><select value={sceneAnimation.cameraInterpolation ?? "smooth"} onChange={(event) => updateSceneAnimation({ ...sceneAnimation, cameraInterpolation: event.target.value as NonNullable<SceneAnimationState["cameraInterpolation"]> })}><option value="linear">线性</option><option value="smooth">平滑</option><option value="spline">曲线路径</option></select></label>
              <label><span>播放速度</span><select value={sceneAnimation.playbackSpeed ?? 1} onChange={(event) => updateSceneAnimation({ ...sceneAnimation, playbackSpeed: Number(event.target.value) })}><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option><option value="4">4×</option></select></label>
              <label className="timeline-path"><input type="checkbox" checked={sceneAnimation.showCameraPath ?? true} onChange={(event) => updateSceneAnimation({ ...sceneAnimation, showCameraPath: event.target.checked })} />显示相机轨迹</label>
              <small>关键帧点击定位，双击删除</small>
            </div>
            <div className="timeline-actions">
              <button onClick={addCameraKeyframe}><Camera size={14} />记录/更新相机</button>
              <button onClick={addModelKeyframe} disabled={!selected || selectionLocked}><Box size={14} />记录选中对象</button>
              <span>{sceneAnimation.camera.length} 相机帧 · {sceneAnimation.models.length} 对象帧</span>
              {[...sceneAnimation.camera, ...sceneAnimation.models].sort((a, b) => a.time - b.time).map((frame) => (
                <button className="keyframe-chip" key={frame.id} title="点击定位，双击删除" onClick={() => engine?.seekSceneAnimation(frame.time)} onDoubleClick={() => deleteKeyframe(frame.id)}>{"camera" in frame ? "相机" : "对象"} {frame.time.toFixed(1)}s</button>
              ))}
            </div>
          </div>
        )}
        <div className="viewport-status"><span className={busy ? "status-dot working" : "status-dot"} />{message}</div>
        {navigationMode !== "orbit" && <div className="navigation-hint">W A S D 移动 · Shift 加速{navigationMode === "firstPerson" ? " · 地面行走 · 双击画面锁定视角 · Esc 释放鼠标" : " · 空中漫游 · Space 上升 · Ctrl 下降 · 鼠标旋转视角"}</div>}
        {busy && <div className="loading-overlay"><LoaderCircle className="spin" size={24} /><span>正在处理模型</span></div>}
      </main>

      <aside className="right-panel">
        <div className="panel-heading inspector-heading"><div><span className="eyebrow">INSPECTOR</span><h2>属性检查器</h2></div></div>
        {infoEnabled && <section className="scene-info-panel" aria-label="场景信息">
          <div className="section-label"><span>场景信息</span><small>{sceneStatistics.modelCount + sceneStatistics.primitiveCount} 对象</small></div>
          <div className="scene-info-grid">
            <div><strong>{numberFormat.format(sceneStatistics.modelCount)}</strong><span>模型</span></div>
            <div><strong>{numberFormat.format(sceneStatistics.componentCount)}</strong><span>构件</span></div>
            <div><strong>{numberFormat.format(sceneStatistics.triangleCount)}</strong><span>三角面</span></div>
            <div><strong>{numberFormat.format(sceneStatistics.vertexCount)}</strong><span>顶点</span></div>
          </div>
        </section>}
        {infoEnabled && <section className="runtime-info-panel" aria-label="相机和鼠标信息">
          <div className="runtime-info-row"><Camera size={13} /><span>相机</span><code>{cameraInfo ? formatVector(cameraInfo.position) : "—"}</code></div>
          <div className="runtime-info-row runtime-target"><span>◎</span><span>目标</span><code>{cameraInfo ? formatVector(cameraInfo.target) : "—"}</code></div>
          <div className="runtime-info-row"><MousePointer2 size={13} /><span>鼠标</span><code>{pointerInfo?.world ? formatVector(pointerInfo.world) : pointerInfo ? `${pointerInfo.screenX}, ${pointerInfo.screenY}` : "—"}</code></div>
          {pointerInfo?.objectName && <div className="runtime-object-name" title={pointerInfo.objectName}>{pointerInfo.objectName}</div>}
        </section>}
        {selectedAnnotation ? (
          <div className="inspector-content annotation-inspector">
            <div className="annotation-inspector-title"><span style={{ background: selectedAnnotation.color }}><MapPin size={15} /></span><div><strong>标签标记</strong><small>{selectedAnnotation.anchorName || "场景坐标"}</small></div><button title="定位标签" onClick={() => engine?.focusAnnotation(selectedAnnotation.id)}><Maximize size={14} /></button></div>
            <label className="field"><span>标签名称</span><input disabled={selectedAnnotation.locked} value={selectedAnnotation.name} onChange={(event) => updateAnnotation(selectedAnnotation.id, { name: event.target.value })} /></label>
            <label className="field"><span>说明内容</span><textarea disabled={selectedAnnotation.locked} rows={4} value={selectedAnnotation.description ?? ""} onChange={(event) => updateAnnotation(selectedAnnotation.id, { description: event.target.value })} placeholder="填写巡检事项、设备状态或问题说明" /></label>
            <label className="field color-field"><span>标签颜色</span><div><input disabled={selectedAnnotation.locked} type="color" value={selectedAnnotation.color} onChange={(event) => updateAnnotation(selectedAnnotation.id, { color: event.target.value })} /><output>{selectedAnnotation.color.toUpperCase()}</output></div></label>
            <div className="two-column">
              <label className="field"><span>可见性</span><button className={`toggle ${selectedAnnotation.visible ? "on" : ""}`} onClick={() => updateAnnotation(selectedAnnotation.id, { visible: !selectedAnnotation.visible })}><i />{selectedAnnotation.visible ? "显示" : "隐藏"}</button></label>
              <label className="field"><span>锁定</span><button className={`toggle ${selectedAnnotation.locked ? "on" : ""}`} onClick={() => updateAnnotation(selectedAnnotation.id, { locked: !selectedAnnotation.locked })}><i />{selectedAnnotation.locked ? "已锁定" : "未锁定"}</button></label>
            </div>
            <label className="field compact-opacity"><span>标签尺寸</span><output>{Math.round((selectedAnnotation.size ?? 1) * 100)}%</output></label>
            <input disabled={selectedAnnotation.locked} className="range" type="range" min="0.35" max="3" step="0.05" value={selectedAnnotation.size ?? 1} onChange={(event) => updateAnnotation(selectedAnnotation.id, { size: Number(event.target.value) })} />
            <TransformFields disabled={selectedAnnotation.locked} title="锚点位置" transform={selectedAnnotation.position} onChange={(axis, value) => updateAnnotationPosition(selectedAnnotation, axis, value)} />
            <div className="annotation-binding">
              <span>绑定对象</span>
              <strong>{selectedAnnotation.anchorName || "未绑定构件"}</strong>
              {selectedAnnotation.modelId && <small>模型 {selectedAnnotation.modelId}{selectedAnnotation.layerId ? ` · 图层 ${selectedAnnotation.layerId}` : ""}</small>}
            </div>
            <button className="button remove-scene" disabled={selectedAnnotation.locked} onClick={() => deleteAnnotation(selectedAnnotation.id)}><Trash2 size={16} />删除标签</button>
          </div>
        ) : selectedSpace ? (
          <div className="inspector-content space-inspector">
            <div className="space-inspector-title"><span><DoorOpen size={16} /></span><div><strong>{selectedSpace.number ? `${selectedSpace.number} ${selectedSpace.name}` : selectedSpace.name}</strong><small>{selectedSpace.modelName} · {selectedSpace.level}</small></div><button title="关闭空间属性" onClick={() => setSelectedSpace(undefined)}><X size={14} /></button></div>
            <div className="space-summary-grid">
              <div><span>面积</span><strong>{selectedSpace.areaSquareMetres === undefined ? "—" : `${numberFormat.format(selectedSpace.areaSquareMetres)} m²`}</strong></div>
              <div><span>体积</span><strong>{selectedSpace.volumeCubicMetres === undefined ? "—" : `${numberFormat.format(selectedSpace.volumeCubicMetres)} m³`}</strong></div>
              <div><span>楼层</span><strong title={selectedSpace.level}>{selectedSpace.level}</strong></div>
              <div><span>类型</span><strong>{selectedSpace.kind}</strong></div>
            </div>
            <div className="space-inspector-actions">
              <button onClick={() => { engine?.focusSpace(selectedSpace); setNavigationMode("orbit"); }}><LocateFixed size={13} />定位</button>
              <button className={engine?.isSpaceVisible(selectedSpace) ? "active" : ""} onClick={() => { if (!engine) return; engine.setSpaceVisible(selectedSpace, !engine.isSpaceVisible(selectedSpace)); setRevision((value) => value + 1); }}>{engine?.isSpaceVisible(selectedSpace) ? <EyeOff size={13} /> : <Eye size={13} />}{engine?.isSpaceVisible(selectedSpace) ? "隐藏空间体" : "显示空间体"}</button>
            </div>
            <StructuredProperties
              entries={spacePropertyEntries(selectedSpace)}
              emptyText="该空间没有更多 BIM 参数"
            />
          </div>
        ) : selected && selectedTransform ? (
          <div className="inspector-content">
            <label className="field"><span>{selectedLayerId && selectedLayerId !== "root" ? "图层名称" : "名称"}</span><input disabled={selectionLocked} value={selectionName} onChange={(event) => { engine?.renameSelection(event.target.value); setRevision((value) => value + 1); }} /></label>
            <label className="field color-field"><span>图层颜色</span><div><input disabled={selectionLocked} type="color" value={selectionColor} onChange={(event) => { engine?.setSelectionColor(event.target.value); setRevision((value) => value + 1); }} /><output>{selectionColor.toUpperCase()}</output></div></label>
            <div className="two-column">
              <label className="field"><span>可见性</span><button className={`toggle ${selectionVisible ? "on" : ""}`} onClick={() => engine?.setSelectionVisible(!selectionVisible)}><i />{selectionVisible ? "显示" : "隐藏"}</button></label>
              <label className="field"><span>锁定</span><button className={`toggle ${selectionLocked ? "on" : ""}`} onClick={() => { if (!engine || !selected) return; if (selectedLayerId && selectedLayerId !== "root") engine.setLayerLocked(selected.id, selectedLayerId, !selectionLocked); else engine.setModelLocked(selected.id, !selectionLocked); setRevision((value) => value + 1); }}><i />{selectionLocked ? "已锁定" : "未锁定"}</button></label>
            </div>
            <label className="field compact-opacity"><span>透明度</span><output>{Math.round(selectionOpacity * 100)}%</output></label>
            <input disabled={selectionLocked} className="range" type="range" min="0" max="1" step="0.01" value={selectionOpacity} onChange={(event) => engine?.setSelectionOpacity(Number(event.target.value))} />
            {selected.kind === "model" && (
              <div className="field explosion-field">
                <span>模型爆炸</span><output>{Math.round(explosionFactor * 100)}%</output>
                <input disabled={selectionLocked} className="range" type="range" min="0" max="2" step="0.01" value={explosionFactor} onChange={(event) => updateExplosion(Number(event.target.value))} />
                <div className="explosion-modes">
                  {(["radial", "vertical", "x", "y", "z"] as const).map((mode) => <button disabled={selectionLocked} key={mode} className={explosionMode === mode ? "active" : ""} onClick={() => updateExplosion(Math.max(explosionFactor, 0.55), mode)}>{explosionModeName(mode)}</button>)}
                  <button disabled={selectionLocked} onClick={() => updateExplosion(0)}>复位</button>
                </div>
              </div>
            )}
            {engine?.hasAnimation(selected.id) && (
              <div className="animation-control"><span>模型动画</span><button onClick={() => { engine.setAnimationEnabled(selected.id, !engine.isAnimationEnabled(selected.id)); setRevision((value) => value + 1); }}>{engine.isAnimationEnabled(selected.id) ? <><Pause size={14} />暂停</> : <><Play size={14} />播放</>}</button></div>
            )}
            {selectedComponent && (
              <div className="component-actions"><button onClick={() => focusComponent(selectedComponent)}>定位</button><button onClick={() => { engine?.isolateComponents([selectedComponent]); setRevision((value) => value + 1); }}>隔离当前</button>{engine?.isIsolationActive() && <button onClick={() => { engine.clearIsolation(); setRevision((value) => value + 1); }}>恢复全部</button>}</div>
            )}
            <TransformFields disabled={selectionLocked} title="位置" transform={selectedTransform.position} onChange={(axis, value) => updateSelectedTransform("position", axis, value)} />
            <TransformFields disabled={selectionLocked} title="旋转" transform={{ x: selectedTransform.rotation.x * 180 / Math.PI, y: selectedTransform.rotation.y * 180 / Math.PI, z: selectedTransform.rotation.z * 180 / Math.PI }} suffix="°" onChange={(axis, value) => updateSelectedTransform("rotation", axis, value)} />
            <TransformFields disabled={selectionLocked} title="缩放" transform={selectedTransform.scale} onChange={(axis, value) => updateSelectedTransform("scale", axis, value)} />
            <StructuredProperties entries={Object.entries(selectionProperties).map(([name, value]) => ({ name, value }))} emptyText="该对象没有 BIM 属性" />
            <button className="button remove-scene" disabled={selectionLocked} onClick={() => {
              if (selectedLayerId && selectedLayerId !== "root") engine?.deleteSelectedLayer();
              else engine?.removeModel(selected.id);
              setRevision((value) => value + 1);
            }}><Trash2 size={16} />{selectedLayerId && selectedLayerId !== "root" ? "删除当前图层" : "从场景移除"}</button>
          </div>
        ) : (
          <div className="empty-inspector"><MousePointer2 size={30} /><strong>选择一个模型或构件</strong><span>点击画布中的对象查看属性并进行编辑</span></div>
        )}
        {measurements.length > 0 && (
          <div className="measurement-list">
            <div className="section-label"><span>测量结果</span><button onClick={() => { engine?.clearMeasurements(); setMeasurements([]); }}>清空</button></div>
            {measurements.map((item, index) => (
              <div className="measurement-row" key={item.id}>
                <Ruler size={14} />
                <button onClick={() => engine?.focusMeasurement(item)}><span>{measureModeName(item.kind ?? "distance")} {index + 1}</span><strong>{formatMeasurementValue(item)}</strong></button>
                <button className="measurement-delete" title="删除该测量" onClick={() => deleteMeasurement(item.id)}><X size={13} /></button>
              </div>
            ))}
          </div>
        )}
        {collisions.length > 0 && (
          <div className="collision-list">
            <div className="section-label"><span>碰撞结果</span><small>{collisions.length}</small></div>
            {collisions.map((item) => <button key={item.id} onClick={() => engine?.focusCollision(item)}><ScanLine size={14} /><span><strong>{item.sourceName}</strong><small>与 {item.targetName} 相交</small></span></button>)}
          </div>
        )}
      </aside>

      <div className="app-copyright">Copyright © 张文鹏 Charlie</div>
    </div>
    <input ref={uploadRef} hidden multiple type="file" accept={ACCEPTED_MODELS} onChange={(event) => void uploadModels(event.target.files ?? undefined)} />
    <input ref={importRef} hidden type="file" accept=".json,.bimscene" onChange={(event) => void importScene(event.target.files?.[0])} />
    {projectDialogMode && <div className="dialog-backdrop" onMouseDown={() => !busy && setProjectDialogMode(undefined)}>
      <form className="dialog" onSubmit={(event) => { event.preventDefault(); void submitProjectDialog(); }} onMouseDown={(event) => event.stopPropagation()}>
        <span className="eyebrow">{projectDialogMode === "rename" ? "EDIT PROJECT" : "NEW PROJECT"}</span>
        <h2>{projectDialogMode === "rename" ? "编辑项目" : "新建项目"}</h2>
        <p>{projectDialogMode === "rename" ? "修改项目名称和说明，不影响已有模型与场景。" : "项目用于隔离模型资产和场景，可随时从顶部切换。"}</p>
        <label><span>项目名称</span><input autoFocus value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="例如：研发中心一期" /></label>
        <label><span>项目说明</span><textarea value={newProjectDescription} onChange={(event) => setNewProjectDescription(event.target.value)} placeholder="可选" rows={3} /></label>
        <div className="dialog-actions"><button type="button" className="button" disabled={busy} onClick={() => setProjectDialogMode(undefined)}>取消</button><button className="button primary" disabled={!newProjectName.trim() || busy}>{busy ? "保存中…" : projectDialogMode === "rename" ? "保存修改" : "创建并切换"}</button></div>
      </form>
    </div>}
    {error && <div className="toast error">{error}</div>}
    </>
  );
}

function ToolButton({ title, active, onClick, icon }: { title: string; active: boolean; onClick: () => void; icon: React.ReactNode }) {
  return <button className={`tool-button ${active ? "active" : ""}`} title={title} onClick={onClick}>{icon}<span>{title}</span></button>;
}

function ViewControl({ onSelect }: { onSelect: (view: StandardView) => void }) {
  return (
    <div className="view-control" aria-label="标准视图">
      <button onClick={() => onSelect("top")}>上</button>
      <div><button onClick={() => onSelect("left")}>左</button><button onClick={() => onSelect("front")}>前</button><button onClick={() => onSelect("right")}>右</button></div>
      <div><button onClick={() => onSelect("back")}>后</button><button onClick={() => onSelect("bottom")}>下</button></div>
    </div>
  );
}

function StructuredProperties({ entries, emptyText }: { entries: BimPropertyEntry[]; emptyText: string }) {
  const groups = groupPropertyEntries(entries);
  if (groups.length === 0) return <div className="property-empty">{emptyText}</div>;
  return <div className="structured-properties">
    <div className="section-label property-label"><span>BIM 属性</span><small>{entries.length}</small></div>
    {groups.map((group, index) => <details key={group.name} open={index < 2}>
      <summary><span>{group.name}</span><small>{group.entries.length}</small><ChevronRight size={12} /></summary>
      <dl className="property-list">{group.entries.map((entry, entryIndex) => <div key={`${entry.name}:${entryIndex}`}><dt title={entry.name}>{entry.name}</dt><dd title={entry.value}>{entry.value}</dd></div>)}</dl>
    </details>)}
  </div>;
}

function spacePropertyEntries(space: BimSpaceRecord): BimPropertyEntry[] {
  const base: BimPropertyEntry[] = [
    { name: "空间 ID", value: space.id, group: "identity" },
    { name: "名称", value: space.name, group: "identity" },
    ...(space.number ? [{ name: "编号", value: space.number, group: "identity" }] : []),
    { name: "楼层", value: space.level, group: "constraints" },
    { name: "类型", value: space.kind, group: "identity" },
    ...(space.department ? [{ name: "部门", value: space.department, group: "identity" }] : []),
    ...(space.areaSquareMetres === undefined ? [] : [{ name: "面积", value: `${numberFormat.format(space.areaSquareMetres)} m²`, group: "dimensions" }]),
    ...(space.volumeCubicMetres === undefined ? [] : [{ name: "体积", value: `${numberFormat.format(space.volumeCubicMetres)} m³`, group: "dimensions" }]),
    ...(space.bounds ? [
      { name: "边界最小点", value: formatVector(space.bounds.min), group: "dimensions" },
      { name: "边界最大点", value: formatVector(space.bounds.max), group: "dimensions" }
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

function statusText(model: ModelRecord, loaded: boolean): string {
  if (loaded) return "已载入场景";
  if (model.status === "ready") return `${formatBytes(model.size)} · 点击加载`;
  if (model.status === "processing") return `${model.progress}% · ${model.message}`;
  if (model.status === "waiting_converter") return "等待 Revit 转换机";
  if (model.status === "failed") return `失败 · ${model.message}`;
  return model.message;
}

function formatBytes(size: number): string {
  if (size < 1024 * 1024) return `${numberFormat.format(size / 1024)} KB`;
  return `${numberFormat.format(size / 1024 / 1024)} MB`;
}

function measureModeName(mode: MeasureMode): string {
  if (mode === "minimum") return "最小距离";
  if (mode === "angle") return "角度测量";
  if (mode === "elevation") return "标高测量";
  if (mode === "horizontal") return "水平距离";
  if (mode === "vertical") return "垂直高度";
  return "距离测量";
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

function explosionModeName(mode: ExplosionMode): string {
  if (mode === "vertical") return "楼层";
  if (mode === "x") return "X 轴";
  if (mode === "y") return "Y 轴";
  if (mode === "z") return "Z 轴";
  return "径向";
}

function formatVector(vector: { x: number; y: number; z: number }): string {
  return `${vector.x.toFixed(2)}, ${vector.y.toFixed(2)}, ${vector.z.toFixed(2)}`;
}
