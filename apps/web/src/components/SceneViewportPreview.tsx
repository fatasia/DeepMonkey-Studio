import { useEffect, useMemo, useRef, useState } from "react";
import type { ApplicationObjectRef, ProjectRecord, SceneDocument, SceneInteractionTarget, SceneInteractionTrigger, SceneViewportWidgetNode } from "@bim-studio/contracts";
import { LoaderCircle, Pause, Play, RotateCcw, TriangleAlert } from "lucide-react";
import type { RendererBackend, ViewerEngine } from "../viewer/ViewerEngine";
import { translate as tr, type AppLocale } from "../i18n";
import { subscribeApplicationInteractionEffects } from "../studio/applicationInteractionHost";
import { directSceneDataBindingMessage } from "../sceneDataBindings";
import { DirectBindingRuntime } from "../directBindingRuntime";
import { sceneViewportRevision } from "./sceneViewportRevision";
import { registerStudioSceneRuntime } from "../studio/studioSceneRuntimeRegistry";
import { createBrowserCooperativeWorkScheduler } from "../cooperativeWorkScheduler";

const OBJECT_ACTION_TYPES = new Set(["focus", "visibility", "color", "opacity", "animation"]);

export function SceneViewportPreview({
  locale,
  node,
  scene,
  project,
  rendererBackend,
  runtime: runtimeMode = false,
  onSelectionChange,
  onObjectInteraction,
}: {
  locale: AppLocale;
  node: SceneViewportWidgetNode;
  scene: SceneDocument;
  project: ProjectRecord;
  rendererBackend: RendererBackend;
  runtime?: boolean;
  onSelectionChange: (selection: readonly ApplicationObjectRef[]) => void;
  onObjectInteraction: (trigger: SceneInteractionTrigger, target: SceneInteractionTarget) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ViewerEngine | undefined>(undefined);
  const [visible, setVisible] = useState(false);
  const [activated, setActivated] = useState(node.renderMode === "realtime");
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const [animationPlaying, setAnimationPlaying] = useState(false);
  // Application commands create a new application object even when only a 2D
  // node changed. Key the expensive viewer lifecycle to semantic 3D content so
  // editing a title, frame or chart never tears down the live canvas.
  const sceneRevision = useMemo(() => sceneViewportRevision(scene), [scene]);
  const resourceRevision = scene.models
    .map(({ modelId }) => {
      const record = project.models.find((candidate) => candidate.id === modelId);
      return record ? `${record.id}:${record.status}:${record.updatedAt}:${record.manifest?.createdAt ?? ""}` : `${modelId}:missing`;
    })
    .join("|");

  useEffect(() => {
    setActivated(node.renderMode === "realtime");
    setVisible(false);
    setStatus("idle");
  }, [node.id, node.renderMode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || node.renderMode === "static-placeholder") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setVisible(Boolean(entry?.isIntersecting));
      },
      { rootMargin: "160px", threshold: 0.01 },
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, [node.id, node.renderMode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !visible || !activated || node.renderMode === "static-placeholder") return;
    let cancelled = false;
    let runtime: ViewerEngine | undefined;
    let unsubscribeEffects: (() => void) | undefined;
    let unregisterRuntime: (() => void) | undefined;
    const stopBindings: Array<() => void> = [];
    setStatus("loading");
    setError("");
    void import("../viewer/ViewerEngine")
      .then(async ({ ViewerEngine }) => {
        if (rendererBackend === "webgl") return ViewerEngine.create(container, "webgl");
        try {
          return await ViewerEngine.create(container, "webgpu");
        } catch {
          return ViewerEngine.create(container, "webgl");
        }
      })
      .then(async (engine) => {
        if (cancelled) {
          engine.dispose();
          return;
        }
        runtime = engine;
        engineRef.current = engine;
        unregisterRuntime = registerStudioSceneRuntime(scene.id, engine);
        engine.setReadOnly(true);
        engine.setInteractionScripts([]);
        engine.onSelectionChange = (model) => onSelectionChange(model ? [{ kind: "object", sceneId: scene.id, modelId: model.id }] : []);
        engine.onInteractionTrigger = onObjectInteraction;
        unsubscribeEffects = subscribeApplicationInteractionEffects((effect) => {
          const action = effect.action;
          if (action.sceneId && action.sceneId !== scene.id) return;
          if (action.type === "cameraView" && action.cameraViewId) {
            const camera = scene.cameraViews?.find((item) => item.id === action.cameraViewId)?.camera;
            if (camera) engine.applyCamera(camera);
            return;
          }
          if (!OBJECT_ACTION_TYPES.has(action.type)) return;
          const target =
            action.target ??
            (effect.source.kind === "object" && effect.source.sceneId === scene.id
              ? { kind: "object" as const, modelId: effect.source.modelId, ...(effect.source.layerId ? { layerId: effect.source.layerId } : {}) }
              : undefined);
          if (!target || !engine.listModels().some((model) => model.id === target.modelId)) return;
          void engine.executeInteractionAction(target, action).catch((reason) => console.error("二维到三维联动执行失败", reason));
        });

        for (const item of scene.models) {
          const record = project.models.find((candidate) => candidate.id === item.modelId);
          if (!record?.manifest || record.status !== "ready") continue;
          await engine.loadManifest(record.manifest);
          if (cancelled) return;
          engine.applyModelState(item.modelId, item);
          engine.rename(item.modelId, item.name);
        }
        const primitiveScheduler = createBrowserCooperativeWorkScheduler();
        for (const primitive of scene.primitives) {
          engine.createPrimitive(primitive.modelId, primitive.name, primitive.kind ?? "box", primitive.color);
          engine.applyModelState(primitive.modelId, primitive);
          if ((await primitiveScheduler.checkpoint()) && cancelled) return;
        }
        for (const measurement of scene.measurements) engine.addMeasurementVisual(measurement);
        for (const annotation of scene.annotations ?? []) engine.addAnnotation(annotation);
        if (scene.weather) engine.setWeather(scene.weather);
        if (scene.lighting) engine.setGlobalLighting(scene.lighting);
        if (scene.environment) engine.setSceneEnvironment(scene.environment);
        if (scene.floors) engine.applyFloorStates(scene.floors);
        if (scene.postProcessing) engine.setPostProcessing(scene.postProcessing);
        if (scene.animation) {
          engine.setSceneAnimation(scene.animation);
          engine.seekSceneAnimation(0);
          if (runtimeMode && scene.animation.autoplay !== false && scene.animation.models.length + scene.animation.camera.length > 0) {
            engine.playSceneAnimation();
            setAnimationPlaying(true);
          }
        }
        if (scene.clipping) engine.setClipping(scene.clipping);
        const camera = scene.cameraViews?.find((item) => item.id === node.cameraViewId)?.camera ?? scene.camera;
        engine.applyCamera(camera);
        for (const binding of scene.dataBindings ?? []) {
          if (!binding.enabled || !binding.directBinding) continue;
          stopBindings.push(
            new DirectBindingRuntime(
              binding.directBinding,
              {},
              {
                onValue: (value) => {
                  try {
                    engine.applySceneDataMessage(directSceneDataBindingMessage(binding, value, scene.id));
                  } catch (reason) {
                    console.warn(`三维直接绑定 ${binding.name} 数据无效`, reason);
                  }
                },
                onError: (message) => console.warn(`三维直接绑定 ${binding.name} 失败：${message}`),
              },
            ).start(),
          );
        }
        if (node.interactionPolicy !== "display-only") engine.select(scene.selectedModelId);
        if (!cancelled) setStatus("ready");
      })
      .catch((reason) => {
        if (cancelled) return;
        setStatus("error");
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
      stopBindings.forEach((stop) => stop());
      unsubscribeEffects?.();
      unregisterRuntime?.();
      if (engineRef.current === runtime) engineRef.current = undefined;
      runtime?.dispose();
      setAnimationPlaying(false);
    };
  }, [visible, activated, rendererBackend, node.id, node.sceneId, node.cameraViewId, node.interactionPolicy, node.renderMode, runtimeMode, sceneRevision, resourceRevision]);

  const waitingForInteraction = node.renderMode === "load-on-interaction" && !activated;
  return (
    <div
      className={`scene-viewport-preview ${status} interaction-${node.interactionPolicy}`}
      ref={containerRef}
      onClick={(event) => {
        if (node.interactionPolicy !== "display-only") event.stopPropagation();
      }}
    >
      {waitingForInteraction && (
        <div className="scene-viewport-preview-state">
          <button onClick={() => setActivated(true)}>{tr(locale, "载入实时三维", "Load live 3D")}</button>
        </div>
      )}
      {!waitingForInteraction && node.renderMode !== "static-placeholder" && (status === "idle" || status === "loading") && (
        <div className="scene-viewport-preview-state">
          <LoaderCircle className="spin" size={22} />
          <span>{tr(locale, "正在载入三维预览", "Loading 3D preview")}</span>
        </div>
      )}
      {status === "error" && (
        <div className="scene-viewport-preview-state error">
          <TriangleAlert size={22} />
          <span>{tr(locale, "三维预览载入失败", "3D preview failed")}</span>
          <small>{error}</small>
        </div>
      )}
      {runtimeMode && status === "ready" && (scene.animation?.models.length || scene.animation?.camera.length) ? (
        <div className="scene-viewport-animation-controls" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
          <button
            title={animationPlaying ? tr(locale, "暂停拆解动画", "Pause animation") : tr(locale, "播放拆解动画", "Play animation")}
            onClick={() => {
              const engine = engineRef.current;
              if (!engine) return;
              if (engine.isSceneAnimationPlaying()) engine.pauseSceneAnimation();
              else engine.playSceneAnimation();
              setAnimationPlaying(engine.isSceneAnimationPlaying());
            }}
          >
            {animationPlaying ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            title={tr(locale, "复位拆解动画", "Reset animation")}
            onClick={() => {
              const engine = engineRef.current;
              if (!engine) return;
              engine.pauseSceneAnimation();
              engine.seekSceneAnimation(0);
              setAnimationPlaying(false);
            }}
          >
            <RotateCcw size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
