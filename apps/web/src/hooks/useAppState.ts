import { useCallback, useMemo, useRef, useState } from "react";
import type {
  ApplicationDocument, CameraConstraintsState, CameraState, CameraViewState, ClippingState,
  GlobalLightingState, MeasurementState, NavigationSettingsState, ProjectRecord,
  RevitRuntimeInfo, RvtConversionMode, SceneAnnotationState, SceneAnimationState, SceneAssetBindingState,
  SceneCoordinateSystemState, SceneDashboardState, SceneDataBindingState,
  SceneEnvironmentState, SceneInteractionScriptState, ScenePhysicsState,
  ScenePostProcessingState, SceneSelectionSetState, SceneSnapshot,
  SystemBrandingSettings, SystemUserRecord, TopologyScadaRuntimeState, WeatherMode
} from "@bim-studio/contracts";
import {
  AUTO_SAVE_STORAGE_KEY, DEFAULT_ANIMATION, DEFAULT_BRANDING, DEFAULT_CAMERA_CONSTRAINTS,
  DEFAULT_CLIPPING, DEFAULT_ENVIRONMENT, DEFAULT_LIGHTING, DEFAULT_PHYSICS,
  DEFAULT_POST_PROCESSING, RENDERER_BACKEND_STORAGE_KEY, REVIT_VERSION_STORAGE_KEY
} from "../appDefaults";
import { DEFAULT_DASHBOARD_STATE } from "../components/dashboardState";
import type { InteractionTargetOption } from "../components/InteractionEditor";
import type { SceneDataBindingRuntimeState } from "../components/SceneDataBindingEditor";
import type { SceneBehaviorLogEntry } from "../components/SceneBehaviorPanel";
import type { TopologyDataProductOption } from "../components/TopologyEditorPanel";
import { appendInteractionLayerOptions } from "../appPresentation";
import { ApplicationSession } from "../studio/applicationSession";
import { readLocale, type AppLocale } from "../i18n";
import { readRoute, type AppRoute } from "../appRoute";
import { DEFAULT_NAVIGATION_SETTINGS } from "../navigationSettings";
import { DEFAULT_SCENE_COORDINATES } from "../viewer/sceneCoordinates";
import { useRendererDiagnostics } from "../viewer/useRendererDiagnostics";
import { initialRendererBackend, requiresWebGlPostProcessing } from "../rendererCapabilities";
import { SceneBehaviorManager, type SceneBehaviorManagerEntry } from "../behavior/SceneBehaviorManager";
import type { SceneDataBridgeStatus } from "../sceneDataBridge";
import type {
  BimSpaceRecord, LoadedSceneModel, MeasureMode, NavigationCollisionDiagnostics,
  NavigationMode, PointerInfo, RendererBackend, SelectionScope, TransformMode, ViewerEngine
} from "../viewer/ViewerEngine";
import type { RendererRecoveryState } from "../viewer/rendererRecoveryState";

/** 汇集应用级 React 状态；控制器和视图通过同一强类型状态对象协作。 */
export function useAppState() {
  const initialPathRef = useRef(window.location.pathname);
  const defaultEntryAppliedRef = useRef(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const environmentMapRef = useRef<HTMLInputElement>(null);
  const materialTextureRef = useRef<HTMLInputElement>(null);
  const materialTextureKindRef = useRef<"baseColor" | "normal" | "emissive" | "ambientOcclusion" | "roughness" | "metalness">("baseColor");
  const sceneNameCommitRef = useRef<Promise<boolean> | undefined>(undefined);
  const sceneApplyVersionRef = useRef(0);
  const sceneWorkspaceLoadRef = useRef<string | undefined>(undefined);
  const rendererSnapshotRef = useRef<RendererRecoveryState | undefined>(undefined);
  const webGpuSceneReplacementCountRef = useRef(0);
  const applicationSessionRef = useRef<ApplicationSession>(null!);
  applicationSessionRef.current ??= new ApplicationSession();
  const activeSceneIdRef = useRef<string | undefined>(undefined);
  // 跨页面定位必须等待三维引擎和场景资源重新就绪，不能捕获已销毁的 ViewerEngine。
  const pendingSceneFocusRef = useRef<{ sceneId: string; objectId: string; label?: string } | undefined>(undefined);
  const visionEventCursorRef = useRef<{ scope: string; id: string }>({
    scope: "",
    id: "",
  });
  const behaviorManagerRef = useRef<SceneBehaviorManager | undefined>(undefined);
  const behaviorCommandQueueRef = useRef(Promise.resolve());
  const [engine, setEngine] = useState<ViewerEngine>();
  const [currentUser, setCurrentUser] = useState<SystemUserRecord>();
  const [branding, setBranding] = useState<SystemBrandingSettings>(DEFAULT_BRANDING);
  const [authReady, setAuthReady] = useState(false);
  const [rendererBackend, setRendererBackend] = useState<RendererBackend>(() => initialRendererBackend(
    new URLSearchParams(window.location.search).get("renderer"),
    window.localStorage.getItem(RENDERER_BACKEND_STORAGE_KEY)
  ));
  const [rendererSwitching, setRendererSwitching] = useState(false);
  const [rendererGeneration, setRendererGeneration] = useState(0);
  const [rendererDiagnosticsOpen, setRendererDiagnosticsOpen] = useState(false);
  const [systemInitialTab, setSystemInitialTab] = useState<"users" | "cloud-render">("users");
  const [studioPublishMode, setStudioPublishMode] = useState<NonNullable<SceneSnapshot["publicationMode"]>>("webgl");
  const [studioPublishPerformance, setStudioPublishPerformance] = useState<NonNullable<SceneSnapshot["publicationPerformance"]>>("standard");
  const [studioPublishOpen, setStudioPublishOpen] = useState(false);
  const [studioCloudConfigured, setStudioCloudConfigured] = useState<boolean>();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [project, setProject] = useState<ProjectRecord>();
  const [scenes, setScenes] = useState<SceneSnapshot[]>([]);
  const [managerApplications, setManagerApplications] = useState<ApplicationDocument[]>([]);
  const [activeScene, setActiveScene] = useState<SceneSnapshot>();
  const [applicationRevision, setApplicationRevision] = useState(0);
  const [sceneName, setSceneName] = useState("未命名场景");
  const [selected, setSelected] = useState<LoadedSceneModel>();
  const [measurements, setMeasurements] = useState<MeasurementState[]>([]);
  const [revision, setRevision] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [rvtConversionMode, setRvtConversionMode] = useState<RvtConversionMode>("native-glb");
  const [revitRuntime, setRevitRuntime] = useState<RevitRuntimeInfo>({
    installations: [],
    defaultVersion: "auto",
  });
  const [rvtRevitVersion, setRvtRevitVersion] = useState(() => window.localStorage.getItem(REVIT_VERSION_STORAGE_KEY) ?? "auto");
  const [busy, setBusy] = useState(false);
  const [viewerLoadState, setViewerLoadState] = useState<{
    loaded: number;
    total: number;
    current: string;
    phase: "shell" | "essential" | "streaming" | "ready";
  }>();
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(() => window.localStorage.getItem(AUTO_SAVE_STORAGE_KEY) !== "false");
  const lastAutoSavedSceneRevisionRef = useRef(0);
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
  const [navigationDiagnostics, setNavigationDiagnostics] = useState<NavigationCollisionDiagnostics>({
    debugVisible: false,
    blockingObjectCount: 0,
    raySamples: 0,
    lastSweepMs: 0,
  });
  const [measureMode, setMeasureMode] = useState<MeasureMode>("distance");
  const [route, setRoute] = useState<AppRoute>(() => readRoute());
  const dataReturnRouteRef = useRef<AppRoute | undefined>(undefined);
  const viewerRouteActive = route.view === "studio" || route.view === "view" || route.view === "published";
  const applicationState = useMemo(() => applicationSessionRef.current.store.getState(), [applicationRevision]);
  const activeApplication = applicationState.document;
  activeSceneIdRef.current = route.view === "studio" && route.applicationId ? activeScene?.id : undefined;
  const activeDashboardPage = route.view === "dashboard" && activeApplication && activeApplication.metadata.id === route.applicationId ? activeApplication.pages.find((page) => page.id === route.pageId) : undefined;
  const activeTopology = route.view === "topology" && activeApplication && activeApplication.metadata.id === route.applicationId ? activeApplication.topologies.find((topology) => topology.id === route.topologyId) : undefined;
  const [topologyDataProducts, setTopologyDataProducts] = useState<TopologyDataProductOption[]>([]);
  const [topologyRuntimeStates, setTopologyRuntimeStates] = useState<Record<string, TopologyScadaRuntimeState>>({});
  const [avatarVisible, setAvatarVisible] = useState(false);
  const [cameraInfo, setCameraInfo] = useState<CameraState>();
  const [pointerInfo, setPointerInfo] = useState<PointerInfo>();
  const [infoEnabled, setInfoEnabled] = useState(false);
  const [frameRate, setFrameRate] = useState(0);
  const [weather, setWeather] = useState<WeatherMode>("sunny");
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [lighting, setLighting] = useState<GlobalLightingState>(DEFAULT_LIGHTING);
  const [sceneEnvironment, setSceneEnvironment] = useState<SceneEnvironmentState>(DEFAULT_ENVIRONMENT);
  const [sceneCoordinates, setSceneCoordinates] = useState<SceneCoordinateSystemState>(DEFAULT_SCENE_COORDINATES);
  const configuredDefaultEnvironment = useMemo<SceneEnvironmentState>(
    () => ({ ...DEFAULT_ENVIRONMENT, backgroundColor: branding.defaultSceneBackground, gridVisible: branding.defaultGridVisible, }),
    [branding.defaultGridVisible, branding.defaultSceneBackground],
  );
  const [postProcessing, setPostProcessing] = useState<ScenePostProcessingState>(DEFAULT_POST_PROCESSING);
  const [physics, setPhysics] = useState<ScenePhysicsState>(DEFAULT_PHYSICS);
  const [physicsOpen, setPhysicsOpen] = useState(false);
  const [selectedLightId, setSelectedLightId] = useState("sun-default");
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [digitalTwinOpen, setDigitalTwinOpen] = useState(false);
  const [sceneDataStatus, setSceneDataStatus] = useState<SceneDataBridgeStatus>("offline");
  const [sceneDataReceived, setSceneDataReceived] = useState(0);
  const [aiAssistantOpen, setAiAssistantOpen] = useState(false);
  const [sceneDashboard, setSceneDashboard] = useState<SceneDashboardState>(() => structuredClone(DEFAULT_DASHBOARD_STATE));
  const [sceneDataBindings, setSceneDataBindings] = useState<SceneDataBindingState[]>([]);
  const [sceneAssetBindings, setSceneAssetBindings] = useState<SceneAssetBindingState[]>([]);
  const [sceneDataBindingRuntime, setSceneDataBindingRuntime] = useState<Record<string, SceneDataBindingRuntimeState>>({});
  const [sceneInteractions, setSceneInteractions] = useState<SceneInteractionScriptState[]>([]);
  const [viewerToolsOpen, setViewerToolsOpen] = useState(false);
  const [xrPanelOpen, setXrPanelOpen] = useState(false);
  const [xrActiveMode, setXrActiveMode] = useState<"immersive-vr" | "immersive-ar">();
  const [xrCapabilities, setXrCapabilities] = useState<{
    checking: boolean;
    secure: boolean;
    webxr: boolean;
    vr: boolean;
    ar: boolean;
  }>({
    checking: false,
    secure: window.isSecureContext,
    webxr: Boolean(navigator.xr),
    vr: false,
    ar: false,
  });
  const [locale, setLocale] = useState<AppLocale>(() => readLocale());
  const [sceneAnimation, setSceneAnimation] = useState<SceneAnimationState>(DEFAULT_ANIMATION);
  const [cameraViews, setCameraViews] = useState<CameraViewState[]>([]);
  const [cameraConstraints, setCameraConstraints] = useState<CameraConstraintsState>(DEFAULT_CAMERA_CONSTRAINTS);
  const [navigationSettings, setNavigationSettings] = useState<NavigationSettingsState>(DEFAULT_NAVIGATION_SETTINGS);
  const [defaultCameraViewId, setDefaultCameraViewId] = useState<string>();
  const [cameraViewsOpen, setCameraViewsOpen] = useState(false);
  const [animationTime, setAnimationTime] = useState(0);
  const [animationPlaying, setAnimationPlaying] = useState(false);
  const [animationOpen, setAnimationOpen] = useState(false);
  const [componentQuery, setComponentQuery] = useState("");
  const [componentLevel, setComponentLevel] = useState("");
  const [componentCategory, setComponentCategory] = useState("");
  const [floorExpansionByModel, setFloorExpansionByModel] = useState<Record<string, number>>({});
  const [clipping, setClippingState] = useState<ClippingState>(DEFAULT_CLIPPING);
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());
  const [sceneOrganizationOpen, setSceneOrganizationOpen] = useState(false);
  const [sceneImportOpen, setSceneImportOpen] = useState(false);
  const [sceneBehaviorOpen, setSceneBehaviorOpen] = useState(false);
  const [sceneBehaviorActive, setSceneBehaviorActive] = useState(false);
  const [sceneBehaviorPaused, setSceneBehaviorPaused] = useState(false);
  const [sceneBehaviorEntries, setSceneBehaviorEntries] = useState<SceneBehaviorManagerEntry[]>([]);
  const [sceneBehaviorLogs, setSceneBehaviorLogs] = useState<SceneBehaviorLogEntry[]>([]);
  const [inspectorTab, setInspectorTab] = useState<"overview" | "data" | "behavior">("overview");
  const [sceneOrganizationSelection, setSceneOrganizationSelection] = useState<Set<string>>(new Set());
  const [selectionSets, setSelectionSets] = useState<SceneSelectionSetState[]>([]);
  const [lastDeletedSelectionSet, setLastDeletedSelectionSet] = useState<SceneSelectionSetState>();
  const [projectDialogMode, setProjectDialogMode] = useState<"create" | "rename">();
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDescription, setNewProjectDescription] = useState("");
  const primitiveColors = useRef(new Map<string, string>());
  const interactionTargetOptions = useMemo<InteractionTargetOption[]>(() => {
    if (!engine) return [];
    const options: InteractionTargetOption[] = [];
    for (const model of engine.listModels()) {
      options.push({ label: model.name, target: { kind: "object", modelId: model.id }, });
      const tree = engine.getLayerTree(model.id);
      if (tree) appendInteractionLayerOptions(options, tree, model.name, 0, 2_500);
      if (options.length >= 2_500) break;
    }
    return options;
  }, [engine, revision]);

  const showError = useCallback((reason: unknown) => { setError(reason instanceof Error ? reason.message : "操作失败"); window.setTimeout(() => setError(undefined), 5000); }, []);
  const rendererPostProcessingRequired = useMemo(
    () => requiresWebGlPostProcessing(
      postProcessing,
      engine?.listModels().some((model) => engine.getModelEffects(model.id).outline) ?? false
    ),
    [engine, postProcessing, revision]
  );
  const rendererDiagnostics = useRendererDiagnostics(engine, rendererDiagnosticsOpen, rendererPostProcessingRequired, showError);
  return {
    initialPathRef, defaultEntryAppliedRef, viewportRef, uploadRef,
    importRef, environmentMapRef, materialTextureRef, materialTextureKindRef,
    sceneNameCommitRef, sceneApplyVersionRef, sceneWorkspaceLoadRef, rendererSnapshotRef,
    webGpuSceneReplacementCountRef,
    applicationSessionRef, activeSceneIdRef, pendingSceneFocusRef, visionEventCursorRef,
    behaviorManagerRef, behaviorCommandQueueRef, engine, setEngine,
    currentUser, setCurrentUser, branding, setBranding,
    authReady, setAuthReady, rendererBackend, setRendererBackend,
    rendererSwitching, setRendererSwitching, rendererGeneration, setRendererGeneration,
    rendererDiagnosticsOpen, setRendererDiagnosticsOpen,
    systemInitialTab, setSystemInitialTab, studioPublishMode, setStudioPublishMode,
    studioPublishPerformance, setStudioPublishPerformance, studioPublishOpen, setStudioPublishOpen,
    studioCloudConfigured, setStudioCloudConfigured, projects, setProjects,
    project, setProject, scenes, setScenes,
    managerApplications, setManagerApplications, activeScene, setActiveScene,
    applicationRevision, setApplicationRevision, sceneName, setSceneName,
    selected, setSelected, measurements, setMeasurements,
    revision, setRevision, uploading, setUploading,
    rvtConversionMode, setRvtConversionMode, revitRuntime, setRevitRuntime,
    rvtRevitVersion, setRvtRevitVersion, busy, setBusy,
    viewerLoadState, setViewerLoadState, autoSaveEnabled, setAutoSaveEnabled,
    lastAutoSavedSceneRevisionRef, message, setMessage, error,
    setError, measureEnabled, setMeasureEnabled, annotationEnabled,
    setAnnotationEnabled, annotations, setAnnotations, selectedAnnotationId,
    setSelectedAnnotationId, selectedSpace, setSelectedSpace, transformMode,
    setTransformMode, selectionScope, setSelectionScope, navigationMode,
    setNavigationMode, navigationDiagnostics, setNavigationDiagnostics, measureMode,
    setMeasureMode, route, setRoute, dataReturnRouteRef,
    viewerRouteActive, applicationState, activeApplication, activeDashboardPage,
    activeTopology, topologyDataProducts, setTopologyDataProducts, topologyRuntimeStates,
    setTopologyRuntimeStates, avatarVisible, setAvatarVisible, cameraInfo,
    setCameraInfo, pointerInfo, setPointerInfo, infoEnabled,
    setInfoEnabled, frameRate, setFrameRate, weather,
    setWeather, environmentOpen, setEnvironmentOpen, lighting,
    setLighting, sceneEnvironment, setSceneEnvironment, sceneCoordinates,
    setSceneCoordinates, configuredDefaultEnvironment, postProcessing, setPostProcessing,
    physics, setPhysics, physicsOpen, setPhysicsOpen,
    selectedLightId, setSelectedLightId, creditsOpen, setCreditsOpen,
    digitalTwinOpen, setDigitalTwinOpen, sceneDataStatus, setSceneDataStatus,
    sceneDataReceived, setSceneDataReceived, aiAssistantOpen, setAiAssistantOpen,
    sceneDashboard, setSceneDashboard, sceneDataBindings, setSceneDataBindings, sceneAssetBindings, setSceneAssetBindings,
    sceneDataBindingRuntime, setSceneDataBindingRuntime, sceneInteractions, setSceneInteractions,
    viewerToolsOpen, setViewerToolsOpen, xrPanelOpen, setXrPanelOpen,
    xrActiveMode, setXrActiveMode, xrCapabilities, setXrCapabilities,
    locale, setLocale, sceneAnimation, setSceneAnimation,
    cameraViews, setCameraViews, cameraConstraints, setCameraConstraints,
    navigationSettings, setNavigationSettings, defaultCameraViewId, setDefaultCameraViewId,
    cameraViewsOpen, setCameraViewsOpen, animationTime, setAnimationTime,
    animationPlaying, setAnimationPlaying, animationOpen, setAnimationOpen,
    componentQuery, setComponentQuery, componentLevel, setComponentLevel,
    componentCategory, setComponentCategory, floorExpansionByModel, setFloorExpansionByModel,
    clipping, setClippingState, expandedModels, setExpandedModels,
    sceneOrganizationOpen, setSceneOrganizationOpen, sceneImportOpen, setSceneImportOpen,
    sceneBehaviorOpen, setSceneBehaviorOpen, sceneBehaviorActive, setSceneBehaviorActive,
    sceneBehaviorPaused, setSceneBehaviorPaused, sceneBehaviorEntries, setSceneBehaviorEntries,
    sceneBehaviorLogs, setSceneBehaviorLogs, inspectorTab, setInspectorTab,
    sceneOrganizationSelection, setSceneOrganizationSelection, selectionSets, setSelectionSets,
    lastDeletedSelectionSet, setLastDeletedSelectionSet, projectDialogMode, setProjectDialogMode,
    newProjectName, setNewProjectName, newProjectDescription, setNewProjectDescription,
    primitiveColors, interactionTargetOptions, showError, rendererDiagnostics,
  };
}

export type AppState = ReturnType<typeof useAppState>;
