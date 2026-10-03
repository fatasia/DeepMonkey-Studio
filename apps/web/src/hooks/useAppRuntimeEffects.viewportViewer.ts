import { useEffect, useState, type MutableRefObject } from "react";
import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { synchronizeSelectionFromViewport } from "../controllers/sceneSelectionSynchronization";
import { commitRendererPreference } from "../viewer/rendererBackendPreference";
import { readAnimationPlayheadSec } from "../viewer/animationPlayheadReader";
import type { NavigationCollisionDiagnostics, ViewerEngine } from "../viewer/ViewerEngine";
import { translate as tr } from "../i18n";
import type { AppRuntimeEffectsContext, RendererRecoveryContext } from "./useAppRuntimeEffects.context";

/** 视口挂载与作者 Viewer 生命周期:引擎创建、引擎回调接线、设备丢失恢复快照。 */
export function useViewportViewerLifecycle(context: AppRuntimeEffectsContext,
  rendererRecoveryContextRef: MutableRefObject<RendererRecoveryContext>): void {
  const {
    authReady,
    currentUser,
    viewerRouteActive,
    viewportRef,
    rendererGeneration,
    rendererBackend,
    activeSceneIdRef,
    rendererSnapshotRef,
    rendererPreferenceCommitRef,
    webGpuSceneReplacementCountRef,
    behaviorManagerRef,
    primitiveColors,
    dispatchApplicationInteraction,
    recordSceneEdit,
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
    setAnimationTime,
    setAnimationPlaying,
    setXrActiveMode,
    setRendererActiveBackend,
    setRendererSwitchPhase,
    setRendererSwitchMessage,
    setRendererBackend,
    setNavigationDiagnostics,
    setMessage,
    locale,
  } = context;
  const [viewportMountRetry, setViewportMountRetry] = useState(0);
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
    // 碰撞/模型变换回调在拖拽期逐帧触发(gizmo 拖拽每帧 applySelectionTransform 后
    // 经 onModelChange 到达这里);revision 的消费方(交互目标列表、后处理判定)只
    // 需要"拖拽静止后"的收敛值,逐帧推进实测只产生全壳空渲染(DOM 0 变更)。
    let revisionSettleTimer: number | undefined;
    let diagnosticsTimer: number | undefined;
    let diagnosticsLastFlush = Number.NEGATIVE_INFINITY;
    let pendingDiagnostics: NavigationCollisionDiagnostics | undefined;
    const scheduleRevisionSettle = () => {
      if (revisionSettleTimer !== undefined) window.clearTimeout(revisionSettleTimer);
      revisionSettleTimer = window.setTimeout(() => {
        revisionSettleTimer = undefined;
        setRevision((value) => value + 1);
      }, 250);
    };
    const requestRevisionOnCollisionSettle = () => {
      viewer?.requestRender();
      scheduleRevisionSettle();
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
          viewer?.requestRender();
          scheduleRevisionSettle();
          recordSceneEdit("编辑三维对象");
        };
        viewer.onLightingChange = (nextLighting) => {
          setLighting(nextLighting);
          requestRevision();
          recordSceneEdit("调整场景灯光");
        };
        viewer.onXRSessionChange = (mode) => setXrActiveMode(mode);
        viewer.onCollisionChange = requestRevisionOnCollisionSettle;
        viewer.onNavigationRecovery = () =>
          queueMicrotask(() => setMessage(tr(locale, "出生点与模型重叠，已自动移动到最近安全位置", "The spawn overlapped geometry and was moved to the nearest safe position")));
        // 引擎逐帧产出内容变化的诊断读数(ms 计时),信息面板不需要逐帧精度:
        // 200ms 节流(首沿立即,单次变化零延迟)+ 内容浅比较,未变化时保持原引用,
        // React 对相同引用 bail out,拖拽期最多 5Hz 更新。
        const flushDiagnostics = () => {
          const next = pendingDiagnostics;
          pendingDiagnostics = undefined;
          if (!next) return;
          setNavigationDiagnostics((current) => sameNavigationDiagnostics(current, next) ? current : next);
        };
        viewer.onNavigationDiagnosticsChange = (next) => {
          pendingDiagnostics = next;
          const elapsed = performance.now() - diagnosticsLastFlush;
          if (elapsed >= 200) {
            diagnosticsLastFlush = performance.now();
            flushDiagnostics();
          } else if (diagnosticsTimer === undefined) {
            diagnosticsTimer = window.setTimeout(() => {
              diagnosticsTimer = undefined;
              diagnosticsLastFlush = performance.now();
              flushDiagnostics();
            }, 200 - elapsed);
          }
        };
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
              // J3-E：设备丢失瞬间的编辑器播放头随快照一起保留，恢复时经 applyScene 回 seek。
              animationPlayheadSec: readAnimationPlayheadSec(viewer),
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
          // 播放头只在时间线面板局部订阅；暂停/seek 时保留一次稳定回退值。
          const animationChannel = viewer?.transientChannels.channel<{ time: number; playing: boolean }>("animation", { shallow: true });
          animationChannel?.publish({ time, playing });
          if (!playing) setAnimationTime(time);
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
      if (revisionSettleTimer !== undefined) window.clearTimeout(revisionSettleTimer);
      if (diagnosticsTimer !== undefined) window.clearTimeout(diagnosticsTimer);
      viewer?.dispose();
      setEngine((current) => (current === viewer ? undefined : current));
    };
  }, [authReady, currentUser?.id, rendererGeneration, viewerRouteActive, viewportMountRetry, showError]);

/** 碰撞诊断是信息性读数;逐字段全等时保持原引用,避免拖拽期逐帧全壳重渲染。 */
function sameNavigationDiagnostics(a: NavigationCollisionDiagnostics, b: NavigationCollisionDiagnostics): boolean {
  return a.debugVisible === b.debugVisible && a.blockingObjectCount === b.blockingObjectCount
    && a.raySamples === b.raySamples && a.lastSweepMs === b.lastSweepMs;
}
}
