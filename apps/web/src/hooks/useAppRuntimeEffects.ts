import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import type {
  ApplicationDocument,
  ApplicationObjectRef,
  CameraState,
  CameraViewState,
  ClippingState,
  GlobalLightingState,
  MeasurementState,
  ProjectRecord,
  SceneAnnotationState,
  JsonValue,
  SceneDataBindingState,
  SceneInteractionActionState,
  SceneInteractionScriptState,
  SceneInteractionTrigger,
  SceneSnapshot,
  SystemUserRecord,
} from "@bim-studio/contracts";
import { api } from "../api";
import { RENDERER_BACKEND_STORAGE_KEY } from "../appDefaults";
import type { SceneDataBindingRuntimeState } from "../components/SceneDataBindingEditor";
import { dataBindingProduct, directSceneDataBindingMessage, sceneDataBindingMessage } from "../sceneDataBindings";
import { DirectBindingRuntime } from "../directBindingRuntime";
import { DEFAULT_DASHBOARD_VIEW } from "../studio/workspaceRoute";
import { publishApplicationInteractionEffects, subscribeApplicationInteractionEffects } from "../studio/applicationInteractionHost";
import { publishLocalSceneData, subscribeSceneData, type SceneDataBridgeStatus } from "../sceneDataBridge";
import { readRoute, routePath, type AppRoute } from "../appRoute";
import { translate as tr, type AppLocale } from "../i18n";
import { ApplicationSession } from "../studio/applicationSession";
import { SceneBehaviorManager, type SceneBehaviorManagerEntry } from "../behavior/SceneBehaviorManager";
import type { BimSpaceRecord, LoadedSceneModel, NavigationCollisionDiagnostics, PointerInfo, RendererBackend, ViewerEngine } from "../viewer/ViewerEngine";
import type { RendererRecoveryState } from "../viewer/rendererRecoveryState";
import { runSceneNavigationTransition } from "../sceneTransitionOverlay";
import { isSceneViewerDeliveryRuntime } from "../delivery/sceneViewerDelivery";
import { synchronizeSelectionFromViewport } from "../controllers/sceneSelectionSynchronization";

type Setter<T> = Dispatch<SetStateAction<T>>;
interface XrCapabilities {
  checking: boolean;
  secure: boolean;
  webxr: boolean;
  vr: boolean;
  ar: boolean;
}

interface AppRuntimeEffectsContext {
  authReady: boolean;
  currentUser: SystemUserRecord | undefined;
  viewerRouteActive: boolean;
  viewportRef: RefObject<HTMLDivElement | null>;
  rendererBackend: RendererBackend;
  rendererGeneration: number;
  engine: ViewerEngine | undefined;
  route: AppRoute;
  locale: AppLocale;
  project: ProjectRecord | undefined;
  activeScene: SceneSnapshot | undefined;
  activeApplication: ApplicationDocument | undefined;
  applicationState: ReturnType<ApplicationSession["store"]["getState"]>;
  scenes: SceneSnapshot[];
  cameraViews: CameraViewState[];
  infoEnabled: boolean;
  xrPanelOpen: boolean;
  studioPublishOpen: boolean;
  sceneBehaviorActive: boolean;
  sceneBehaviorPaused: boolean;
  sceneDataBindings: SceneDataBindingState[];
  sceneInteractions: SceneInteractionScriptState[];
  activeSceneIdRef: MutableRefObject<string | undefined>;
  rendererSnapshotRef: MutableRefObject<RendererRecoveryState | undefined>;
  webGpuSceneReplacementCountRef: MutableRefObject<number>;
  visionEventCursorRef: MutableRefObject<{ scope: string; id: string }>;
  behaviorManagerRef: MutableRefObject<SceneBehaviorManager | undefined>;
  primitiveColors: MutableRefObject<Map<string, string>>;
  navigate: (route: AppRoute, replace?: boolean) => void;
  applyScene: (scene: SceneSnapshot, updateRoute?: boolean, sceneProject?: ProjectRecord, readOnly?: boolean, fastRuntime?: boolean) => Promise<void>;
  dispatchApplicationInteraction: (source: ApplicationObjectRef, trigger: SceneInteractionTrigger, selectSource?: boolean, payload?: JsonValue) => unknown;
  recordSceneEdit: (label: string) => void;
  captureSceneSnapshot: () => SceneSnapshot | undefined;
  showError: (reason: unknown) => void;
  setEngine: Setter<ViewerEngine | undefined>;
  setRendererSwitching: Setter<boolean>;
  setRevision: Setter<number>;
  setSelected: Setter<LoadedSceneModel | undefined>;
  setSceneOrganizationSelection: Setter<Set<string>>;
  setSelectedSpace: Setter<BimSpaceRecord | undefined>;
  setMeasurements: Setter<MeasurementState[]>;
  setAnnotations: Setter<SceneAnnotationState[]>;
  setSelectedAnnotationId: Setter<string | undefined>;
  setLighting: Setter<GlobalLightingState>;
  setClippingState: Setter<ClippingState>;
  setCameraInfo: Setter<CameraState | undefined>;
  setPointerInfo: Setter<PointerInfo | undefined>;
  setNavigationDiagnostics: Setter<NavigationCollisionDiagnostics>;
  setFrameRate: Setter<number>;
  setAnimationTime: Setter<number>;
  setAnimationPlaying: Setter<boolean>;
  setXrActiveMode: Setter<"immersive-vr" | "immersive-ar" | undefined>;
  setXrCapabilities: Setter<XrCapabilities>;
  setStudioCloudConfigured: Setter<boolean | undefined>;
  setSceneDataStatus: Setter<SceneDataBridgeStatus>;
  setSceneDataReceived: Setter<number>;
  setSceneDataBindingRuntime: Setter<Record<string, SceneDataBindingRuntimeState>>;
  setSceneBehaviorActive: Setter<boolean>;
  setSceneBehaviorPaused: Setter<boolean>;
  setSceneBehaviorEntries: Setter<SceneBehaviorManagerEntry[]>;
  setViewerToolsOpen: Setter<boolean>;
  setMessage: Setter<string>;
  setRoute: Setter<AppRoute>;
  setRendererBackend: Setter<RendererBackend>;
}

/** 集中管理渲染器、实时数据、WebXR 与交互总线的生命周期副作用。 */
export function useAppRuntimeEffects(context: AppRuntimeEffectsContext): void {
  const {
    authReady,
    currentUser,
    viewerRouteActive,
    viewportRef,
    rendererBackend,
    rendererGeneration,
    engine,
    route,
    locale,
    project,
    activeScene,
    activeApplication,
    applicationState,
    scenes,
    cameraViews,
    infoEnabled,
    xrPanelOpen,
    studioPublishOpen,
    sceneBehaviorActive,
    sceneBehaviorPaused,
    sceneDataBindings,
    sceneInteractions,
    activeSceneIdRef,
    rendererSnapshotRef,
    webGpuSceneReplacementCountRef,
    visionEventCursorRef,
    behaviorManagerRef,
    primitiveColors,
    navigate,
    applyScene,
    dispatchApplicationInteraction,
    recordSceneEdit,
    captureSceneSnapshot,
    showError,
    setEngine,
    setRendererSwitching,
    setRevision,
    setSelected,
    setSceneOrganizationSelection,
    setSelectedSpace,
    setMeasurements,
    setAnnotations,
    setSelectedAnnotationId,
    setLighting,
    setClippingState,
    setCameraInfo,
    setPointerInfo,
    setNavigationDiagnostics,
    setFrameRate,
    setAnimationTime,
    setAnimationPlaying,
    setXrActiveMode,
    setXrCapabilities,
    setStudioCloudConfigured,
    setSceneDataStatus,
    setSceneDataReceived,
    setSceneDataBindingRuntime,
    setSceneBehaviorActive,
    setSceneBehaviorPaused,
    setSceneBehaviorEntries,
    setViewerToolsOpen,
    setMessage,
    setRoute,
    setRendererBackend,
  } = context;
  const [viewportMountRetry, setViewportMountRetry] = useState(0);
  const rendererRecoveryContextRef = useRef({
    activeScene,
    readOnly: route.view !== "studio",
    fastRuntime: route.view === "published" && activeScene?.publicationPerformance === "fast",
    captureSceneSnapshot,
  });
  rendererRecoveryContextRef.current = {
    activeScene,
    readOnly: route.view !== "studio",
    fastRuntime: route.view === "published" && activeScene?.publicationPerformance === "fast",
    captureSceneSnapshot,
  };

  useEffect(() => {
    if (!authReady || !currentUser || !viewerRouteActive) return;
    if (!viewportRef.current) {
      const frame = window.requestAnimationFrame(() => setViewportMountRetry((value) => value + 1));
      return () => window.cancelAnimationFrame(frame);
    }
    let viewer: ViewerEngine | undefined;
    let cancelled = false;
    let rendererLossHandled = false;
    let revisionFrame: number | undefined;
    const requestRevision = () => {
      if (revisionFrame !== undefined) return;
      revisionFrame = window.requestAnimationFrame(() => {
        revisionFrame = undefined;
        setRevision((value) => value + 1);
      });
    };
    setRendererSwitching(true);
    void import("../viewer/ViewerEngine")
      .then(({ ViewerEngine }) => ViewerEngine.create(viewportRef.current!, rendererBackend))
      .then((created) => {
        if (cancelled) {
          created.dispose();
          return;
        }
        viewer = created;
        webGpuSceneReplacementCountRef.current = 0;
        viewer.onSelectionChange = (model) => {
          synchronizeSelectionFromViewport(model, {
            setSelectedModel: setSelected,
            replaceObjectSelection: setSceneOrganizationSelection,
            clearSelectedSpace: () => setSelectedSpace(undefined),
            requestRender: () => setRevision((value) => value + 1),
          });
        };
        viewer.onModelChange = () => {
          requestRevision();
          recordSceneEdit("编辑三维对象");
        };
        viewer.onLightingChange = (nextLighting) => {
          setLighting(nextLighting);
          requestRevision();
          recordSceneEdit("调整场景灯光");
        };
        viewer.onXRSessionChange = (mode) => setXrActiveMode(mode);
        viewer.onCollisionChange = requestRevision;
        viewer.onNavigationRecovery = () =>
          queueMicrotask(() => setMessage(tr(locale, "出生点与模型重叠，已自动移动到最近安全位置", "The spawn overlapped geometry and was moved to the nearest safe position")));
        viewer.onNavigationDiagnosticsChange = setNavigationDiagnostics;
        setNavigationDiagnostics(viewer.getNavigationCollisionDiagnostics());
        viewer.onPrimitivePlaced = (model, _kind, color) => {
          primitiveColors.current.set(model.id, color);
          setSelected(model);
          setMessage(`${model.name} 已放置，可继续移动、旋转或缩放`);
          requestRevision();
          recordSceneEdit("放置基础元素");
        };
        viewer.onRendererDeviceLost = (info) => {
          if (rendererLossHandled) return;
          rendererLossHandled = true;
          const latest = rendererRecoveryContextRef.current;
          const snapshot = latest.captureSceneSnapshot() ?? latest.activeScene;
          if (snapshot) {
            rendererSnapshotRef.current = {
              scene: snapshot,
              readOnly: latest.readOnly,
              fastRuntime: latest.fastRuntime,
              recoveryMessage: `WebGPU 设备丢失（${info.reason ?? "unknown"}），已无损恢复到 WebGL`,
            };
          }
          window.localStorage.setItem(RENDERER_BACKEND_STORAGE_KEY, "webgl");
          setRendererSwitching(true);
          setMessage("检测到 GPU 设备丢失，正在保留现场并恢复 WebGL");
          setRendererBackend("webgl");
        };
        viewer.onAnimationChange = (time, playing) => {
          setAnimationTime(time);
          setAnimationPlaying(playing);
        };
        viewer.onInteractionScriptResult = (result) => {
          if (result.status === "error") {
            const detail = result.error instanceof Error ? result.error.message : String(result.error ?? "未知错误");
            showError(new Error(`事件“${result.script.name}”执行失败：${detail}`));
          } else if (result.test) {
            setMessage(`事件“${result.script.name}”运行成功 · ${result.durationMs.toFixed(1)}ms`);
          }
        };
        viewer.onInteractionTrigger = (trigger, target) => {
          const sceneId = activeSceneIdRef.current;
          if (sceneId && target.kind === "object") {
            dispatchApplicationInteraction({ kind: "object", sceneId, modelId: target.modelId, ...(target.layerId ? { layerId: target.layerId } : {}) }, trigger);
            behaviorManagerRef.current?.dispatchEvent({
              type: "object.event",
              name: trigger,
              target: { kind: "object", sceneId, objectId: target.modelId },
              timestamp: new Date().toISOString(),
            });
          }
        };
        viewer.onMeasurement = (measurement) => {
          setMeasurements((items) => [...items, measurement]);
          setRevision((value) => value + 1);
          recordSceneEdit("添加三维测量");
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
          recordSceneEdit("添加模型标签");
        };
        viewer.onAnnotationChange = (annotation) => {
          setAnnotations((items) => items.map((item) => (item.id === annotation.id ? annotation : item)));
          setRevision((value) => value + 1);
          setMessage(`已关闭“${annotation.name}”标签；重新进入场景会按保存版本恢复`);
        };
        viewer.onAnnotationSelectionChange = (annotationId) => {
          setSelectedAnnotationId(annotationId);
          if (annotationId) setSelectedSpace(undefined);
          setRevision((value) => value + 1);
        };
        viewer.onClippingFacePicked = (state) => {
          setClippingState(state);
          recordSceneEdit("设置剖切面");
          setMessage("已按拾取面建立剖切面，可反向或重新拾取");
        };
        const restoringSnapshot = Boolean(rendererSnapshotRef.current);
        setEngine(viewer);
        if (!restoringSnapshot) {
          setRendererSwitching(false);
          setMessage(`${viewer.getRendererBackend() === "webgpu" ? "WebGPU（实验）" : "WebGL"} 已启用`);
        }
      })
      .catch((reason) => {
        if (cancelled) return;
        if (rendererBackend === "webgpu") {
          if (!rendererSnapshotRef.current?.temporaryBackend) window.localStorage.setItem(RENDERER_BACKEND_STORAGE_KEY, "webgl");
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
      setEngine((current) => (current === viewer ? undefined : current));
    };
  }, [authReady, currentUser?.id, rendererBackend, rendererGeneration, viewerRouteActive, viewportMountRetry, showError]);

  useEffect(() => {
    const pending = rendererSnapshotRef.current;
    if (!engine || !pending || !project) return;
    rendererSnapshotRef.current = undefined;
    void applyScene(pending.scene, false, project, pending.readOnly, pending.fastRuntime)
      .then(() => {
        setMessage(pending.recoveryMessage ?? `已切换到 ${engine.getRendererBackend() === "webgpu" ? "WebGPU（实验）" : "WebGL"}，场景状态已恢复`);
      })
      .finally(() => setRendererSwitching(false));
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
    engine?.setInteractionScripts(sceneInteractions);
  }, [engine, sceneInteractions]);

  useEffect(() => {
    if (!sceneBehaviorActive || sceneBehaviorPaused) return;
    let frame: number | undefined;
    let previous = performance.now();
    const advance = (now: number) => {
      behaviorManagerRef.current?.advance(now - previous);
      previous = now;
      frame = window.requestAnimationFrame(advance);
    };
    frame = window.requestAnimationFrame(advance);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [sceneBehaviorActive, sceneBehaviorPaused]);

  useEffect(() => {
    if (!sceneBehaviorActive) return;
    behaviorManagerRef.current?.dispatchData(applicationState.variables);
  }, [applicationState.variables, sceneBehaviorActive]);

  useEffect(() => {
    behaviorManagerRef.current?.dispose();
    behaviorManagerRef.current = undefined;
    setSceneBehaviorEntries([]);
    setSceneBehaviorActive(false);
    setSceneBehaviorPaused(false);
    return () => {
      behaviorManagerRef.current?.dispose();
      behaviorManagerRef.current = undefined;
    };
  }, [engine, activeScene?.id]);

  useEffect(() => {
    if (!xrPanelOpen || !engine) return;
    let cancelled = false;
    setXrCapabilities((current) => ({ ...current, checking: true, secure: window.isSecureContext, webxr: Boolean(navigator.xr) }));
    void Promise.all([engine.isXRSupported("immersive-vr"), engine.isXRSupported("immersive-ar")]).then(([vr, ar]) => {
      if (!cancelled) setXrCapabilities({ checking: false, secure: window.isSecureContext, webxr: Boolean(navigator.xr), vr, ar });
    });
    return () => {
      cancelled = true;
    };
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
    const handlePopState = () => {
      const next = readRoute();
      if (next.fallback === "not-found") {
        window.history.replaceState({}, "", "/manager");
      } else if (next.view === "manager" && window.location.pathname === "/") {
        window.history.replaceState({}, "", "/manager");
      }
      setRoute(next);
    };
    const initial = readRoute();
    if (initial.fallback || (initial.view === "manager" && window.location.pathname === "/")) handlePopState();
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    setViewerToolsOpen(false);
  }, [route.view, route.sceneId]);

  useEffect(() => {
    if (!studioPublishOpen) return;
    let cancelled = false;
    setStudioCloudConfigured(undefined);
    void api
      .getCloudRenderOverview()
      .then((overview) => {
        if (!cancelled) setStudioCloudConfigured(overview.configured);
      })
      .catch(() => {
        if (!cancelled) setStudioCloudConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, [studioPublishOpen]);

  useEffect(() => {
    if (isSceneViewerDeliveryRuntime() || !engine || !project || !["studio", "view", "published"].includes(route.view)) return;
    return subscribeSceneData(
      project.id,
      (data) => {
        if (data.sceneId && data.sceneId !== route.sceneId) return;
        setSceneDataReceived((value) => value + 1);
        if (engine.applySceneDataMessage(data)) {
          if (!data.source.startsWith("pipeline:") && !data.source.startsWith("dataset:")) setMessage(`数据 ${data.source}/${data.key} 已映射到场景`);
          setRevision((value) => value + 1);
        }
      },
      setSceneDataStatus,
    );
  }, [engine, project, route.sceneId, route.view]);

  useEffect(() => {
    if (isSceneViewerDeliveryRuntime() || !project || !route.sceneId || !["studio", "view", "published"].includes(route.view)) return;
    const enabled = sceneDataBindings.filter((binding) => binding.enabled);
    if (enabled.length === 0) {
      setSceneDataBindingRuntime({});
      return;
    }
    let cancelled = false;
    const timers: number[] = [];
    const directStops: Array<() => void> = [];
    const groups = new Map<string, { bindings: SceneDataBindingState[]; kind: "dataset" | "pipeline"; productId: string; seconds: number }>();
    for (const binding of enabled) {
      if (binding.directBinding) continue;
      const product = dataBindingProduct(binding);
      const key = `${product.kind}:${product.id}:${binding.refreshSeconds}`;
      const group = groups.get(key) ?? { bindings: [], kind: product.kind, productId: product.id, seconds: binding.refreshSeconds };
      group.bindings.push(binding);
      groups.set(key, group);
    }
    const updateBindings = (
      bindings: readonly SceneDataBindingState[],
      state: SceneDataBindingRuntimeState | ((binding: SceneDataBindingState) => SceneDataBindingRuntimeState),
    ) => {
      if (cancelled) return;
      setSceneDataBindingRuntime((current) => ({
        ...current,
        ...Object.fromEntries(bindings.map((binding) => [binding.id, typeof state === "function" ? state(binding) : state])),
      }));
    };
    for (const binding of enabled.filter((candidate) => candidate.directBinding)) {
      const stop = new DirectBindingRuntime(
        binding.directBinding!,
        {},
        {
          onValue: (value) => {
            const message = directSceneDataBindingMessage(binding, value, route.sceneId!);
            publishLocalSceneData(message);
            updateBindings([binding], { status: "ready", value: message.value, updatedAt: message.timestamp });
          },
          onStatus: (status) => {
            if (["loading", "connecting", "reconnecting"].includes(status)) {
              setSceneDataBindingRuntime((current) => ({ ...current, [binding.id]: current[binding.id] ?? { status: "loading" } }));
            }
          },
          onError: (error) => updateBindings([binding], { status: "error", error }),
        },
      ).start();
      directStops.push(stop);
    }
    for (const group of groups.values()) {
      const poll = async () => {
        if (!cancelled)
          setSceneDataBindingRuntime((current) => ({
            ...current,
            ...Object.fromEntries(group.bindings.map((binding) => [binding.id, current[binding.id] ?? { status: "loading" }])),
          }));
        try {
          const preview = group.kind === "dataset" ? await api.previewDataset(project.id, group.productId) : await api.previewDataPipeline(project.id, group.productId);
          if ("status" in preview && preview.status === "error") throw new Error(preview.error || "数据管道运行失败");
          const messages = new Map<string, ReturnType<typeof sceneDataBindingMessage>>();
          for (const binding of group.bindings) {
            const message = sceneDataBindingMessage(binding, preview, route.sceneId!);
            messages.set(binding.id, message);
            publishLocalSceneData(message);
          }
          updateBindings(group.bindings, (binding) => {
            const message = messages.get(binding.id)!;
            return { status: "ready", value: message.value, updatedAt: message.timestamp };
          });
        } catch (reason) {
          updateBindings(group.bindings, { status: "error", error: reason instanceof Error ? reason.message : "数据绑定刷新失败" });
        }
      };
      void poll();
      timers.push(window.setInterval(() => void poll(), Math.max(2, group.seconds) * 1_000));
    }
    return () => {
      cancelled = true;
      for (const timer of timers) window.clearInterval(timer);
      for (const stop of directStops) stop();
    };
  }, [project?.id, route.sceneId, route.view, sceneDataBindings]);

  useEffect(() => {
    if (isSceneViewerDeliveryRuntime() || !engine || !project || !route.sceneId || !["studio", "view", "published"].includes(route.view)) return;
    let cancelled = false;
    const sceneId = route.sceneId;
    const scope = `${project.id}:${sceneId}`;
    const poll = async () => {
      const events = (await api.listVisionEvents(project.id, 30)).filter((event) => event.sceneId === sceneId);
      if (cancelled) return;
      const cursor = visionEventCursorRef.current;
      if (cursor.scope !== scope) {
        visionEventCursorRef.current = { scope, id: events[0]?.id ?? "" };
        return;
      }
      if (!events.length || events[0]?.id === cursor.id) return;
      const previousIndex = cursor.id ? events.findIndex((event) => event.id === cursor.id) : -1;
      const fresh = events.slice(0, previousIndex >= 0 ? previousIndex : 1).reverse();
      visionEventCursorRef.current = { scope, id: events[0]?.id ?? "" };
      for (const event of fresh) {
        for (const [index, objectId] of event.objectIds.entries()) {
          const [modelId, ...layerParts] = objectId.split("/");
          if (!modelId) continue;
          const target = { modelId, ...(layerParts.length ? { layerId: layerParts.join("/") } : {}) };
          publishLocalSceneData({
            source: "vision",
            key: event.id,
            value: { outline: true, glow: true, color: "#ff3b30", intensity: 1.35 },
            timestamp: event.createdAt,
            sceneId,
            target,
            action: "effects",
          });
          if (index === 0)
            publishLocalSceneData({
              source: "vision",
              key: `${event.id}:focus`,
              value: true,
              timestamp: event.createdAt,
              sceneId,
              target,
              action: "focus",
            });
        }
        setMessage(
          `视觉告警：${
            event.detections
              .slice(0, 3)
              .map((item) => item.label)
              .join("、") || "检测到异常"
          }`,
        );
      }
    };
    void poll().catch(() => undefined);
    const timer = window.setInterval(() => void poll().catch(() => undefined), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [engine, project?.id, route.sceneId, route.view]);

  useEffect(() => {
    const handleInteractionAction = (action: SceneInteractionActionState, source?: ApplicationObjectRef) => {
      if (!action) return;
      if (action.type === "unityAction") {
        const widgetId = source?.kind === "widget" ? source.id : undefined;
        if (!widgetId || !action.unityAction?.trim()) return showError(new Error("Unity 动作缺少目标 Unity 组件或动作名"));
        window.dispatchEvent(
          new CustomEvent("bim-studio:unity-action", {
            detail: {
              widgetId,
              action: action.unityAction.trim(),
              ...(action.unityObjectId?.trim() ? { objectId: action.unityObjectId.trim() } : {}),
              ...(action.value !== undefined ? { value: action.value } : {}),
            },
          }),
        );
      } else if (action.type === "dashboard" && action.dashboardPageId && activeApplication) {
        const page = activeApplication.pages.find((candidate) => candidate.id === action.dashboardPageId);
        if (!page) return showError(new Error("目标二维页面不存在"));
        navigate({
          view: "dashboard",
          projectId: activeApplication.metadata.projectId,
          applicationId: activeApplication.metadata.id,
          pageId: page.id,
          dashboardView: DEFAULT_DASHBOARD_VIEW,
        });
      } else if (action.type === "navigateScene" && action.sceneId) {
        const targetScene = activeApplication?.scenes.find((candidate) => candidate.id === action.sceneId);
        if (activeApplication && !targetScene) return showError(new Error("目标三维场景不存在，已阻止跳转"));
        if (!activeApplication && !scenes.some((candidate) => candidate.id === action.sceneId)) return showError(new Error("目标三维场景不存在，已阻止跳转"));
        const view = route.view === "studio" ? "studio" : "view";
        const destination: AppRoute = view === "studio" ? { ...route, view, sceneId: action.sceneId } : { view, sceneId: action.sceneId };
        if (action.newTab) window.open(routePath(destination), "_blank", "noopener,noreferrer");
        else void runSceneNavigationTransition(action.transition, () => navigate(destination)).catch(showError);
      } else if (action.type === "cameraView" && action.cameraViewId) {
        const cameraView = cameraViews.find((item) => item.id === action.cameraViewId);
        if (cameraView) engine?.applyCamera(cameraView.camera);
      } else if (action.type === "message") {
        setMessage(action.message?.trim() || "事件已触发");
      } else if (action.type === "setData") {
        publishLocalSceneData({
          source: "interaction",
          key: action.dataKey?.trim() || "value",
          value: action.value,
          timestamp: new Date().toISOString(),
          ...(route.sceneId ? { sceneId: route.sceneId } : {}),
        });
      } else if (action.type === "openUrl") {
        const url = action.url?.trim();
        if (!url || !/^(https?:\/\/|\/)/i.test(url)) return showError(new Error("网页地址必须以 http://、https:// 或 / 开头"));
        if (action.newTab !== false) window.open(url, "_blank", "noopener,noreferrer");
        else window.location.assign(url);
      }
    };
    const handleLegacyInteractionAction = (event: Event) => handleInteractionAction((event as CustomEvent<SceneInteractionActionState>).detail);
    const unsubscribe = subscribeApplicationInteractionEffects((effect) => handleInteractionAction(effect.action, effect.source));
    window.addEventListener("bim-studio:interaction-action", handleLegacyInteractionAction);
    return () => {
      unsubscribe();
      window.removeEventListener("bim-studio:interaction-action", handleLegacyInteractionAction);
    };
  }, [activeApplication, activeScene?.id, cameraViews, engine, route.sceneId, route.view, scenes, showError]);

  useEffect(() => {
    const preventContextMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", preventContextMenu);
    return () => document.removeEventListener("contextmenu", preventContextMenu);
  }, []);
}
