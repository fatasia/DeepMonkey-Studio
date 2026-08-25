import { useEffect, useRef, useState } from "react";
import type { ApplicationObjectRef, ProjectRecord, SceneDocument, SceneViewportWidgetNode } from "@bim-studio/contracts";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import type { RendererBackend, ViewerEngine } from "../viewer/ViewerEngine";
import { translate as tr, type AppLocale } from "../i18n";

export function SceneViewportPreview({ locale, node, scene, project, rendererBackend, onSelectionChange }: {
  locale: AppLocale;
  node: SceneViewportWidgetNode;
  scene: SceneDocument;
  project: ProjectRecord;
  rendererBackend: RendererBackend;
  onSelectionChange: (selection: readonly ApplicationObjectRef[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [activated, setActivated] = useState(node.renderMode === "realtime");
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const resourceRevision = scene.models.map(({ modelId }) => {
    const record = project.models.find((candidate) => candidate.id === modelId);
    return record ? `${record.id}:${record.status}:${record.updatedAt}:${record.manifest?.createdAt ?? ""}` : `${modelId}:missing`;
  }).join("|");

  useEffect(() => {
    setActivated(node.renderMode === "realtime");
    setVisible(false);
    setStatus("idle");
  }, [node.id, node.renderMode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || node.renderMode === "static-placeholder") return;
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(Boolean(entry?.isIntersecting));
    }, { rootMargin: "160px", threshold: 0.01 });
    observer.observe(container);
    return () => observer.disconnect();
  }, [node.id, node.renderMode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !visible || !activated || node.renderMode === "static-placeholder") return;
    let cancelled = false;
    let runtime: ViewerEngine | undefined;
    setStatus("loading");
    setError("");
    void import("../viewer/ViewerEngine").then(async ({ ViewerEngine }) => {
      if (rendererBackend === "webgl") return ViewerEngine.create(container, "webgl");
      try {
        return await ViewerEngine.create(container, "webgpu");
      } catch {
        return ViewerEngine.create(container, "webgl");
      }
    }).then(async (engine) => {
      if (cancelled) {
        engine.dispose();
        return;
      }
      runtime = engine;
      engine.setReadOnly(true);
      engine.setInteractionScripts([]);
      engine.onSelectionChange = (model) => onSelectionChange(model
        ? [{ kind: "object", sceneId: scene.id, modelId: model.id }]
        : []);

      for (const item of scene.models) {
        const record = project.models.find((candidate) => candidate.id === item.modelId);
        if (!record?.manifest || record.status !== "ready") continue;
        await engine.loadManifest(record.manifest);
        if (cancelled) return;
        engine.applyModelState(item.modelId, item);
        engine.rename(item.modelId, item.name);
      }
      for (const primitive of scene.primitives) {
        engine.createPrimitive(primitive.modelId, primitive.name, primitive.kind ?? "box", primitive.color);
        engine.applyModelState(primitive.modelId, primitive);
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
      }
      if (scene.clipping) engine.setClipping(scene.clipping);
      const camera = scene.cameraViews?.find((item) => item.id === node.cameraViewId)?.camera ?? scene.camera;
      engine.applyCamera(camera);
      if (node.interactionPolicy !== "display-only") engine.select(scene.selectedModelId);
      if (!cancelled) setStatus("ready");
    }).catch((reason) => {
      if (cancelled) return;
      setStatus("error");
      setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      cancelled = true;
      runtime?.dispose();
    };
  }, [visible, activated, rendererBackend, node.id, node.sceneId, node.cameraViewId, node.interactionPolicy, node.renderMode, scene, resourceRevision]);

  const waitingForInteraction = node.renderMode === "load-on-interaction" && !activated;
  return <div
    className={`scene-viewport-preview ${status} interaction-${node.interactionPolicy}`}
    ref={containerRef}
    onClick={(event) => { if (node.interactionPolicy !== "display-only") event.stopPropagation(); }}
  >
    {waitingForInteraction && <div className="scene-viewport-preview-state"><button onClick={() => setActivated(true)}>{tr(locale, "载入实时三维", "Load live 3D")}</button></div>}
    {!waitingForInteraction && node.renderMode !== "static-placeholder" && (status === "idle" || status === "loading") && <div className="scene-viewport-preview-state"><LoaderCircle className="spin" size={22} /><span>{tr(locale, "正在载入三维预览", "Loading 3D preview")}</span></div>}
    {status === "error" && <div className="scene-viewport-preview-state error"><TriangleAlert size={22} /><span>{tr(locale, "三维预览载入失败", "3D preview failed")}</span><small>{error}</small></div>}
  </div>;
}
