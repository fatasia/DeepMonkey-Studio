import { startTransition, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
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
  SceneInteractionScriptState,
  SceneInteractionTrigger,
  SceneSnapshot,
  SystemUserRecord,
} from "@bim-studio/contracts";
import { getSceneModelAssetId } from "@bim-studio/contracts";
import { api } from "../api";
import type { SceneDataBindingRuntimeState } from "../components/SceneDataBindingEditor";
import { dataBindingProduct, directSceneDataBindingMessage, sceneDataBindingMessage } from "../sceneDataBindings";
import { DirectBindingRuntime } from "../directBindingRuntime";
import { writeLastWorkspace } from "../studio/lastWorkspacePreference";
import { publishApplicationInteractionEffects } from "../studio/applicationInteractionHost";
import { publishLocalSceneData, subscribeSceneData, type SceneDataBridgeStatus } from "../sceneDataBridge";
import { createCameraInfoPublisher } from "./cameraInfoPublisher";
import { readRoute, type AppRoute } from "../appRoute";
import { translate as tr, type AppLocale } from "../i18n";
import { ApplicationSession } from "../studio/applicationSession";
import { SceneBehaviorManager, type SceneBehaviorManagerEntry } from "../behavior/SceneBehaviorManager";
import type { BimSpaceRecord, LoadedSceneModel, NavigationCollisionDiagnostics, PointerInfo, RendererBackend, ViewerEngine } from "../viewer/ViewerEngine";
import type { RendererRecoveryState } from "../viewer/rendererRecoveryState";
import { isSceneViewerDeliveryRuntime } from "../delivery/sceneViewerDelivery";
import { synchronizeSelectionFromViewport } from "../controllers/sceneSelectionSynchronization";
import { commitRendererPreference, type PendingRendererPreference } from "../viewer/rendererBackendPreference";
import { StudioDeepWebGpuBridge } from "../viewer/StudioDeepWebGpuBridge";
import { StudioDeepWasmBridge } from "../viewer/StudioDeepWasmBridge";
import { compileStudioWasmRuntimePackage } from "../viewer/studioWasmRuntimePackage";
import { compileSceneRenderPacket } from "../delivery/compileSceneRenderPacket";
import { browserImageDecoder } from "../delivery/browserImageDecoder";
import { loadViewerAssetBuffer } from "../viewer/viewerAssetTransport";
import { collectDeepOverlayPrimitives } from "../viewer/deepOverlayPrimitiveSource";
import { mergeDeepOverlayVertices } from "../viewer/deepOverlayPrimitives";
import { projectStudioEditorOverlay } from "../viewer/studioDeepEditorOverlay";
import { rendererBackendLabel } from "../viewer/rendererBackendLabel";
import { useAppInteractionEffects } from "./useAppInteractionEffects";

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
  rendererActiveBackend: RendererBackend;
  rendererGeneration: number;
  revision: number;
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
  rendererPreferenceCommitRef: PendingRendererPreference;
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
  setSelectedLightId: Setter<string>;
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
  setStudioCloudHint: Setter<string | undefined>;
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
  setRendererActiveBackend: Setter<RendererBackend>;
  setRendererSwitchPhase: Setter<"idle" | "preparing" | "recovering" | "failed">;
  setRendererSwitchMessage: Setter<string | undefined>;
}

/** 集中管理渲染器、实时数据、WebXR 与交互总线的生命周期副作用。 */
export function useAppRuntimeEffects(context: AppRuntimeEffectsContext): void {
  const {
    authReady,
    currentUser,
    viewerRouteActive,
    viewportRef,
    rendererBackend,
    rendererActiveBackend,
    rendererGeneration,
    revision,
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
    rendererPreferenceCommitRef,
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
    setSelectedLightId,
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
    setStudioCloudHint,
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
    setRendererActiveBackend,
    setRendererSwitchPhase,
    setRendererSwitchMessage,
  } = context;
  const [viewportMountRetry, setViewportMountRetry] = useState(0);
  const deepBridgeRef = useRef<StudioDeepWebGpuBridge | undefined>(undefined);
  const wasmBridgeRef = useRef<StudioDeepWasmBridge | undefined>(undefined);
  const wasmRefreshRevisionRef = useRef(-1);
  const rendererRecoveryContextRef = useRef({
    activeScene,
    project,
    readOnly: route.view !== "studio",
    fastRuntime: route.view === "published" && activeScene?.publicationPerformance === "fast",
    captureSceneSnapshot,
  });
  rendererRecoveryContextRef.current = {
    activeScene,
    project,
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
      viewer?.requestRender();
      if (revisionFrame !== undefined) return;
      revisionFrame = window.requestAnimationFrame(() => {
        revisionFrame = undefined;
        setRevision((value) => value + 1);
      });
    };
    setRendererSwitching(true);
    void import("../viewer/ViewerEngine")
      // Studio 作者 Viewer 固定为 WebGL；Deep 是同一作者状态的独立输出表面。
      .then(({ ViewerEngine }) => ViewerEngine.create(viewportRef.current!, "webgl"))
      .then((created) => {
        if (cancelled) {
          created.dispose();
          return;
        }
        viewer = created;
        webGpuSceneReplacementCountRef.current = 0;
        viewer.onSelectionChange = (model) => {
          // Any viewport selection transition ends the outliner-only light selection.
          // Light-row actions set their id again after the engine clears model selection.
          setSelectedLightId("");
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
          rendererPreferenceCommitRef.current = "webgl";
          setRendererSwitchPhase("recovering");
          setRendererSwitchMessage(`WebGPU 设备丢失（${info.reason ?? "unknown"}），正在恢复 WebGL 2`);
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
        setRendererActiveBackend("webgl");
        if (!restoringSnapshot) {
          setRendererSwitching(false);
          setRendererSwitchPhase("idle");
          setRendererSwitchMessage(undefined);
          if (rendererBackend === "webgl") {
            try {
              commitRendererPreference(rendererPreferenceCommitRef, "webgl");
            } catch (reason) {
              showError(new Error(`渲染后端已启用，但偏好保存失败：${reason instanceof Error ? reason.message : String(reason)}`));
            }
            setMessage("WebGL 已启用");
          }
        }
      })
      .catch((reason) => {
        if (cancelled) return;
        rendererPreferenceCommitRef.current = undefined;
        setRendererSwitching(false);
        setRendererSwitchPhase("failed");
        setRendererSwitchMessage(`WebGL 2 作者视口初始化失败：${reason instanceof Error ? reason.message : String(reason)}`);
        showError(reason);
      });
    return () => {
      cancelled = true;
      if (revisionFrame !== undefined) window.cancelAnimationFrame(revisionFrame);
      viewer?.dispose();
      setEngine((current) => (current === viewer ? undefined : current));
    };
  }, [authReady, currentUser?.id, rendererGeneration, viewerRouteActive, viewportMountRetry, showError]);

  useEffect(() => {
    const pending = rendererSnapshotRef.current;
    if (!engine || !pending || !project) return;
    rendererSnapshotRef.current = undefined;
    void applyScene(pending.scene, false, project, pending.readOnly, pending.fastRuntime)
      .then(() => {
        try {
          commitRendererPreference(rendererPreferenceCommitRef, engine.getRendererBackend());
        } catch (reason) {
          showError(new Error(`渲染后端已启用，但偏好保存失败：${reason instanceof Error ? reason.message : String(reason)}`));
        }
        setMessage(pending.recoveryMessage ?? `已切换到 ${rendererBackendLabel(engine.getRendererBackend())}，场景状态已恢复`);
      })
      .then(() => {
        setRendererActiveBackend(engine.getRendererBackend());
        setRendererSwitchPhase("idle");
        setRendererSwitchMessage(undefined);
      })
      .catch((reason) => {
        setRendererSwitchPhase("failed");
        setRendererSwitchMessage(`场景恢复失败：${reason instanceof Error ? reason.message : String(reason)}`);
        showError(reason);
      })
      .finally(() => setRendererSwitching(false));
  }, [engine]);

  useEffect(() => {
    if (!engine || !viewportRef.current) return;
    const bridge = new StudioDeepWebGpuBridge(engine, viewportRef.current, {
      authorRenderPacket: async (signal) => {
        const latest = rendererRecoveryContextRef.current;
        const scene = latest.captureSceneSnapshot() ?? latest.activeScene;
        const project = latest.project;
        if (!scene || !project) return undefined;
        const compiled = await compileSceneRenderPacket(scene, {
          signal,
          imageDecoder: browserImageDecoder,
          loadModel: async (assetId, loadSignal) => {
            loadSignal.throwIfAborted();
            const instance = scene.models.find((model) => getSceneModelAssetId(model) === assetId || model.modelId === assetId);
            const resolvedAssetId = instance ? getSceneModelAssetId(instance) : assetId;
            const model = project.models.find((candidate) => candidate.id === resolvedAssetId);
            const url = model?.manifest?.geometryUrl;
            if (!model || !url || model.status !== "ready") throw new Error(`Deep 编译缺少模型资源：${assetId}`);
            return new Uint8Array(await loadViewerAssetBuffer(url, model.name, { signal: loadSignal, timeoutMs: 120_000 }));
          },
        });
        signal.throwIfAborted();
        return compiled.packet;
      },
      onRuntimeFailure: (reason) => {
        rendererPreferenceCommitRef.current = "webgl";
        try { commitRendererPreference(rendererPreferenceCommitRef, "webgl"); }
        catch (error) { showError(error); }
        setRendererBackend("webgl");
        setRendererActiveBackend("webgl");
        setRendererSwitching(false);
        setRendererSwitchPhase("failed");
        setRendererSwitchMessage(`Deep WebGPU 运行失败，已保留作者状态并回到 WebGL 2：${reason.message}`);
        setMessage("Deep WebGPU 运行失败，已回到 WebGL");
      },
    });
    let wasmOverlayRevision = 0;
    let wasmPreviousOverlay: Float32Array | undefined;
    const wasmBridge = new StudioDeepWasmBridge(engine, viewportRef.current, {
      readEditorOverlay: (width, height, pixelRatio) => {
        const vertices = mergeDeepOverlayVertices(
          projectStudioEditorOverlay(engine.getDeepEditorOverlayRoots(), engine.camera, width * pixelRatio, height * pixelRatio, pixelRatio),
          collectDeepOverlayPrimitives(engine, width, height, pixelRatio));
        if (wasmPreviousOverlay && wasmPreviousOverlay.length === vertices.length
          && wasmPreviousOverlay.every((value, index) => value === vertices[index])) {
          return { revision: wasmOverlayRevision, vertices: wasmPreviousOverlay };
        }
        wasmPreviousOverlay = vertices;
        return { revision: ++wasmOverlayRevision, vertices };
      },
      compilePackage: (signal) => {
        const latest = rendererRecoveryContextRef.current;
        const scene = latest.captureSceneSnapshot() ?? latest.activeScene;
        if (!scene || !latest.project) throw new Error("当前工作区没有可编译的场景或项目资源");
        return compileStudioWasmRuntimePackage(scene, latest.project, signal);
      },
      onRuntimeFailure: (reason) => {
        rendererPreferenceCommitRef.current = "webgl";
        try { commitRendererPreference(rendererPreferenceCommitRef, "webgl"); }
        catch (error) { showError(error); }
        setRendererBackend("webgl");
        setRendererActiveBackend("webgl");
        setRendererSwitching(false);
        setRendererSwitchPhase("failed");
        setRendererSwitchMessage(`Deep WASM 运行失败，已保留作者状态并回到 WebGL 2：${reason.message}`);
        setMessage("Deep WASM 运行失败，已回到 WebGL");
      },
    });
    deepBridgeRef.current = bridge;
    wasmBridgeRef.current = wasmBridge;
    return () => {
      if (deepBridgeRef.current === bridge) deepBridgeRef.current = undefined;
      if (wasmBridgeRef.current === wasmBridge) wasmBridgeRef.current = undefined;
      wasmBridge.dispose();
      bridge.dispose();
    };
  }, [engine, showError]);

  useEffect(() => {
    const bridge = deepBridgeRef.current;
    const wasmBridge = wasmBridgeRef.current;
    if (!engine || !bridge || !wasmBridge || rendererBackend === rendererActiveBackend) return;
    let cancelled = false;
    setRendererSwitching(true);
    setRendererSwitchPhase("preparing");
    setRendererSwitchMessage(`正在准备 ${rendererBackendLabel(rendererBackend)}；当前画布仍可用`);
    const switchRenderer = async () => {
      if (rendererBackend === "wasm") {
        const retired = await bridge.switchTo("webgl");
        if (retired.status === "failed") return retired;
        return wasmBridge.switchTo("wasm");
      }
      const retired = await wasmBridge.switchTo("webgl");
      if (retired.status === "failed") return retired;
      return bridge.switchTo(rendererBackend);
    };
    void switchRenderer().then((result) => {
      if (cancelled) return;
      if (result.status === "switched" || result.status === "unchanged") {
        if (result.activeBackend === "wasm") wasmRefreshRevisionRef.current = revision;
        setRendererActiveBackend(result.activeBackend);
        try { commitRendererPreference(rendererPreferenceCommitRef, result.activeBackend); }
        catch (reason) { showError(reason); }
        setRendererSwitchPhase("idle");
        setRendererSwitchMessage(undefined);
        setMessage(`${rendererBackendLabel(result.activeBackend)} 已启用`);
      } else if (result.status === "failed") {
        const persistFallback = rendererPreferenceCommitRef.current === rendererBackend;
        rendererPreferenceCommitRef.current = persistFallback ? "webgl" : undefined;
        if (persistFallback) {
          try { commitRendererPreference(rendererPreferenceCommitRef, "webgl"); }
          catch (reason) { showError(reason); }
        }
        setRendererBackend("webgl");
        setRendererActiveBackend("webgl");
        setRendererSwitchPhase("failed");
        setRendererSwitchMessage(`${rendererBackendLabel(rendererBackend)} 准备失败，WebGL 2 未中断：${result.error ?? "未知错误"}`);
        setMessage(`${rendererBackendLabel(rendererBackend)} 准备失败，已保留 WebGL 画布`);
      }
    }).catch((reason) => {
      if (!cancelled) showError(reason);
    }).finally(() => {
      if (!cancelled) setRendererSwitching(false);
    });
    return () => { cancelled = true; bridge.cancelPendingSwitch(); wasmBridge.cancelPendingSwitch(); };
  }, [engine, rendererBackend, rendererActiveBackend, revision, showError]);

  useEffect(() => {
    const bridge = wasmBridgeRef.current;
    if (!bridge || rendererActiveBackend !== "wasm" || wasmRefreshRevisionRef.current === revision) return;
    const timer = window.setTimeout(() => {
      void bridge.refresh().then((result) => {
        if (result.status === "switched" || result.status === "unchanged") {
          wasmRefreshRevisionRef.current = revision;
          return;
        }
        if (result.status === "failed") {
          setRendererBackend("webgl");
          setRendererActiveBackend("webgl");
        }
      }).catch(showError);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [rendererActiveBackend, revision, showError]);

  useEffect(() => {
    if (!engine) return;
    // Camera input and viewport chrome subscribe directly to the engine. Only
    // the optional inspector readout crosses top-level App state, at a low rate.
    const cameraInfoPublisher = infoEnabled ? createCameraInfoPublisher((state) => {
      startTransition(() => setCameraInfo(state));
    }, 250) : undefined;
    if (cameraInfoPublisher) {
      engine.onCameraChange = cameraInfoPublisher.push;
      setCameraInfo(engine.getCameraState());
    } else {
      delete engine.onCameraChange;
      setCameraInfo(undefined);
    }
    if (infoEnabled) {
      engine.onPointerInfoChange = setPointerInfo;
    } else {
      delete engine.onPointerInfoChange;
      setPointerInfo(undefined);
    }
    return () => {
      cameraInfoPublisher?.dispose();
      delete engine.onCameraChange;
      delete engine.onPointerInfoChange;
    };
  }, [engine, infoEnabled]);

  useEffect(() => {
    engine?.setInteractionScripts(sceneInteractions);
  }, [engine, sceneInteractions]);

  // 记忆每个项目最近使用的工作区(2D/3D),"编辑场景"入口按记忆落点(见 S8)。
  useEffect(() => {
    if (!route.projectId) return;
    if (route.view === "studio" || route.view === "dashboard") writeLastWorkspace(route.projectId, route.view);
  }, [route.projectId, route.view]);

  useEffect(() => { engine?.requestRender(); }, [engine, applicationState]);

  useEffect(() => {
    engine?.setContinuousRender("scene-behavior", sceneBehaviorActive && !sceneBehaviorPaused);
    return () => engine?.setContinuousRender("scene-behavior", false);
  }, [engine, sceneBehaviorActive, sceneBehaviorPaused]);

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
    const settle = (vr: boolean, ar: boolean) => {
      if (!cancelled) setXrCapabilities({ checking: false, secure: window.isSecureContext, webxr: Boolean(navigator.xr), vr, ar });
    };
    void Promise.all([engine.isXRSupported("immersive-vr"), engine.isXRSupported("immersive-ar")])
      .then(([vr, ar]) => settle(vr, ar))
      // isSessionSupported 异常（设备枚举失败等）不能让面板永远停在 checking。
      .catch(() => settle(false, false));
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
    setStudioCloudHint(undefined);
    void api
      .getCloudRenderCapability()
      .then((capability) => {
        if (cancelled) return;
        if (!capability.configured) {
          setStudioCloudConfigured(false);
          setStudioCloudHint("云渲染尚未配置：需要管理员在系统设置的云渲染页完成 GPU Worker 配置。");
          return;
        }
        if (capability.workerReady === false) {
          setStudioCloudConfigured(false);
          setStudioCloudHint(`云渲染 Worker 暂不可用：${capability.workerError ?? "健康检查未通过"}。可稍后重试或联系管理员。`);
          return;
        }
        setStudioCloudConfigured(true);
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
            publishLocalSceneData(message, project.id);
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
            publishLocalSceneData(message, project.id);
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

  useAppInteractionEffects({ activeApplication, cameraViews, engine, route, scenes, navigate, showError, setMessage });

  useEffect(() => {
    const preventContextMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", preventContextMenu);
    return () => document.removeEventListener("contextmenu", preventContextMenu);
  }, []);
}
