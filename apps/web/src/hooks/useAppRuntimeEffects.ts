import { startTransition, useEffect, useRef } from "react";
import { api } from "../api";
import { writeLastWorkspace } from "../studio/lastWorkspacePreference";
import { createCameraInfoPublisher } from "./cameraInfoPublisher";
import { readRoute } from "../appRoute";
import { commitRendererPreference } from "../viewer/rendererBackendPreference";
import { restoreRendererRecoveryState } from "../controllers/restoreRendererRecoveryState";
import { rendererBackendLabel } from "../viewer/rendererBackendLabel";
import { deepSupportsObjectOutline } from "../viewer/deepOutlineSupport";
import type { StudioDeepWebGpuBridge } from "../viewer/StudioDeepWebGpuBridge";
import type { StudioDeepWasmBridge } from "../viewer/StudioDeepWasmBridge";
import { useAppInteractionEffects } from "./useAppInteractionEffects";
import type { AppRuntimeEffectsContext, RendererRecoveryContext } from "./useAppRuntimeEffects.context";
import { useViewportViewerLifecycle } from "./useAppRuntimeEffects.viewportViewer";
import { useDeepBridgesSetup } from "./useAppRuntimeEffects.deepBridges";
import { useSceneDataRuntimeEffects } from "./useAppRuntimeEffects.sceneData";

/** 集中管理渲染器、实时数据、WebXR 与交互总线的生命周期副作用。 */
export function useAppRuntimeEffects(context: AppRuntimeEffectsContext): void {
  const {
    authReady,
    currentUser,
    viewerRouteActive,
    viewportRef,
    rendererBackend,
    rendererActiveBackend,
    rendererOutlineRequired,
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
  const deepBridgeRef = useRef<StudioDeepWebGpuBridge | undefined>(undefined);
  const wasmBridgeRef = useRef<StudioDeepWasmBridge | undefined>(undefined);
  const wasmRefreshRevisionRef = useRef(-1);
  const rendererSwitchOwnerRef = useRef<symbol | undefined>(undefined);
  const deformationNoticeRef = useRef<string | undefined>(undefined);
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
  // 独立 effect 组拆分到 useAppRuntimeEffects.* 子模块;调用顺序与拆分前的
  // hook 序列一一对应(useState 随视口组后移一档,槽位序在每次渲染间保持稳定)。
  useViewportViewerLifecycle(context, rendererRecoveryContextRef);
  useEffect(() => {
    const pending = rendererSnapshotRef.current;
    if (!engine || !pending || !project) return;
    rendererSnapshotRef.current = undefined;
    void restoreRendererRecoveryState(pending, project, applyScene)
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
        if (rendererSnapshotRef.current === undefined) rendererSnapshotRef.current = pending;
        setRendererSwitchPhase("failed");
        setRendererSwitchMessage(`场景恢复失败：${reason instanceof Error ? reason.message : String(reason)}`);
        showError(reason);
      })
      .finally(() => setRendererSwitching(false));
  }, [engine]);
  useDeepBridgesSetup(context, { deepBridgeRef, wasmBridgeRef, deformationNoticeRef, rendererRecoveryContextRef });
  useEffect(() => {
    const bridge = deepBridgeRef.current;
    const wasmBridge = wasmBridgeRef.current;
    if (!engine || !bridge || !wasmBridge) return;
    // 对象级描边已由 Deep(WebGPU)实现(材质账本 bit 256 对账 + 掩码/边缘/合成 pass);只有引擎包缺失
    // 该能力声明时才保留 WebGL 并给出可操作原因(fail-closed),用户关闭描边后即可切换。
    if (rendererBackend === "webgpu" && rendererOutlineRequired && !deepSupportsObjectOutline()) {
      setRendererBackend("webgl");
      setRendererActiveBackend("webgl");
      setRendererSwitchPhase("failed");
      setRendererSwitchMessage("场景包含描边(outline)效果，当前 Deep 引擎不具备描边能力；已保留 WebGL，关闭描边后可切换");
      setMessage("已保留 WebGL：当前 Deep 引擎不具备描边能力");
      return;
    }
    const actuallyActive = engine.getAuthorRendererBackend() === "webgl"
      && (rendererBackend === "webgpu"
        ? bridge.activeBackend === "webgpu" && wasmBridge.activeBackend === "webgl"
        : rendererBackend === "wasm"
          ? wasmBridge.activeBackend === "wasm" && bridge.activeBackend === "webgl"
          : bridge.activeBackend === "webgl" && wasmBridge.activeBackend === "webgl");
    if (rendererBackend === rendererActiveBackend && actuallyActive) {
      // A cancelled request may return to an already active surface without a new candidate.
      if (rendererSwitchOwnerRef.current !== undefined) {
        rendererSwitchOwnerRef.current = undefined;
        setRendererSwitching(false);
        setRendererSwitchPhase("idle");
        setRendererSwitchMessage(undefined);
      }
      return;
    }
    let cancelled = false;
    const owner = Symbol("renderer switch");
    rendererSwitchOwnerRef.current = owner;
    const finishLoading = () => {
      if (rendererSwitchOwnerRef.current !== owner) return;
      rendererSwitchOwnerRef.current = undefined;
      setRendererSwitching(false);
    };
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
        // Settling the active backend can run this effect's cleanup before finally.
        finishLoading();
        if (result.activeBackend === "wasm") wasmRefreshRevisionRef.current = revision;
        setRendererActiveBackend(result.activeBackend);
        try { commitRendererPreference(rendererPreferenceCommitRef, result.activeBackend); }
        catch (reason) { showError(reason); }
        setRendererSwitchPhase("idle");
        setRendererSwitchMessage(undefined);
        setMessage(result.activeBackend === "webgpu" && deformationNoticeRef.current
          ? `${rendererBackendLabel(result.activeBackend)} 已启用 · ${deformationNoticeRef.current}`
          : `${rendererBackendLabel(result.activeBackend)} 已启用`);
      } else if (result.status === "failed") {
        finishLoading();
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
      if (!cancelled) finishLoading();
    });
    return () => { cancelled = true; bridge.cancelPendingSwitch(); wasmBridge.cancelPendingSwitch(); };
  }, [engine, rendererBackend, rendererActiveBackend, rendererOutlineRequired, revision, showError]);

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
  useSceneDataRuntimeEffects(context);
  useAppInteractionEffects({ activeApplication, cameraViews, engine, route, scenes, navigate, showError, setMessage });

  useEffect(() => {
    const preventContextMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", preventContextMenu);
    return () => document.removeEventListener("contextmenu", preventContextMenu);
  }, []);
}
