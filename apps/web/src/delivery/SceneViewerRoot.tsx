import { useEffect, useRef, useState } from "react";
import { getSceneModelAssetId, type ClippingState } from "@bim-studio/contracts";
import { DEFAULT_CLIPPING } from "../appDefaults";
import { PublishedViewerObjectPanel } from "../components/PublishedViewerObjectPanel";
import { PublishedViewerToolDock } from "../components/PublishedViewerToolDock";
import type { LoadedSceneModel, NavigationMode, RendererBackend, ViewerEngine } from "../viewer/ViewerEngine";
import {
  probeRendererCapabilities,
  rendererRequirementsForScene,
  selectPublishedRenderer,
} from "../rendererCapabilities";
import { applySceneViewerSnapshot } from "./applySceneViewerSnapshot";
import { sceneViewerDeliveryManifest } from "./sceneViewerDelivery";
import { applyDocumentBranding } from "../branding/documentBranding";
import { PublishedModelCredits } from "./PublishedModelCredits";

/** 独立的单场景浏览入口：不挂载项目、脚本、二维或三维编辑器。 */
export function SceneViewerRoot() {
  const manifest = sceneViewerDeliveryManifest();
  if (!manifest) return <div className="scene-viewer-fatal">只读场景清单未初始化</div>;
  const viewportRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<ViewerEngine>();
  const [backend, setBackend] = useState<RendererBackend>();
  const [models, setModels] = useState<LoadedSceneModel[]>([]);
  const [selected, setSelected] = useState<LoadedSceneModel>();
  const [status, setStatus] = useState("正在检查图形能力");
  const [error, setError] = useState<string>();
  const [toolsOpen, setToolsOpen] = useState(true);
  const [objectPanelOpen, setObjectPanelOpen] = useState(false);
  const [navigationMode, setNavigationMode] = useState<NavigationMode>(manifest.publication.snapshot.camera.mode);
  const [measureEnabled, setMeasureEnabled] = useState(false);
  const [clipping, setClipping] = useState<ClippingState>(manifest.publication.snapshot.clipping ?? DEFAULT_CLIPPING);
  const [explosionActive, setExplosionActive] = useState(false);
  const [avatarVisible, setAvatarVisible] = useState(manifest.publication.snapshot.camera.avatarVisible ?? false);
  const [infoEnabled, setInfoEnabled] = useState(false);
  const locale = manifest.branding.defaultLocale;

  useEffect(() => {
    applyDocumentBranding({
      ...manifest.branding,
      browserTitle: manifest.branding.browserTitle || manifest.publication.name,
    });
    let cancelled = false;
    void probeRendererCapabilities().then((probe) => {
      if (cancelled) return;
      const webGpuAvailable = probe.secureContext && probe.webgpuApi && probe.webgpuAdapter;
      const decision = selectPublishedRenderer(manifest.rendererMode, webGpuAvailable, rendererRequirementsForScene(manifest.publication.snapshot));
      setBackend(decision.backend);
      if (decision.reason === "webgpu-unavailable") setStatus("WebGPU 不可用，已自动回退 WebGL");
      else if (decision.reason === "preserve-authored-effects") setStatus("为保持发布效果，已自动使用 WebGL");
      else setStatus(`正在初始化 ${decision.backend === "webgpu" ? "WebGPU" : "WebGL"}`);
    }).catch((reason) => setError(message(reason)));
    return () => { cancelled = true; };
  }, [manifest.packageId]);

  useEffect(() => {
    if (!backend || !viewportRef.current) return;
    let cancelled = false;
    let viewer: ViewerEngine | undefined;
    setError(undefined);
    void import("../viewer/ViewerEngine")
      .then(({ ViewerEngine }) => ViewerEngine.create(viewportRef.current!, backend))
      .then(async (created) => {
        if (cancelled) return created.dispose();
        viewer = created;
        created.onSelectionChange = (value) => setSelected(value);
        await applySceneViewerSnapshot(created, manifest.publication.snapshot, manifest.project, {
          isCancelled: () => cancelled,
        });
        if (cancelled) return created.dispose();
        setEngine(created);
        setModels(created.listModels());
        setStatus("场景已就绪");
      })
      .catch((reason) => {
        if (backend === "webgpu") {
          setStatus("WebGPU 初始化失败，正在回退 WebGL");
          setBackend("webgl");
        } else setError(message(reason));
      });
    return () => {
      cancelled = true;
      viewer?.dispose();
      setEngine(undefined);
    };
  }, [backend, manifest.packageId]);

  function changeNavigation(mode: NavigationMode) {
    engine?.setNavigationMode(mode);
    engine?.setMeasureEnabled(false);
    setNavigationMode(mode);
    setMeasureEnabled(false);
  }

  function toggleMeasurement() {
    const enabled = !measureEnabled;
    engine?.setMeasureEnabled(enabled);
    setMeasureEnabled(enabled);
  }

  function toggleClipping() {
    if (!engine) return;
    const range = engine.getClippingRange(clipping.axis);
    const next = { ...clipping, enabled: !clipping.enabled, offset: (range.min + range.max) / 2 };
    engine.setClipping(next);
    engine.setMeasureEnabled(false);
    setClipping(next);
    setMeasureEnabled(false);
  }

  function toggleExplosion() {
    if (!engine) return;
    const factor = explosionActive ? 0 : 0.55;
    for (const model of engine.listModels().filter((item) => item.kind === "model")) engine.setExplosion(model.id, factor);
    setExplosionActive(!explosionActive);
  }

  function refreshModels() {
    if (engine) setModels([...engine.listModels()]);
  }

  const statistics = engine?.getSceneStatistics();
  return (
    <main className="scene-viewer-delivery-shell">
      <div className="scene-viewer-viewport" ref={viewportRef} />
      <header className="scene-viewer-status">
        <strong>{manifest.publication.name}</strong>
        <span>{status} · {backend?.toUpperCase() ?? "检测中"}</span>
      </header>
      {manifest.toolbarVisible && (
        <PublishedViewerToolDock
          locale={locale}
          open={toolsOpen}
          navigationMode={navigationMode}
          measureEnabled={measureEnabled}
          clippingEnabled={clipping.enabled}
          explosionActive={explosionActive}
          avatarVisible={avatarVisible}
          infoEnabled={infoEnabled}
          objectPanelOpen={objectPanelOpen}
          onOpenChange={setToolsOpen}
          onFitAll={() => engine?.fitAll()}
          fitSelectedEnabled={selected?.kind === "model"}
          onFitSelected={() => {
            if (selected?.kind === "model") engine?.focusModel(selected.id);
          }}
          onNavigationChange={changeNavigation}
          onMeasurementToggle={toggleMeasurement}
          onClippingToggle={toggleClipping}
          onExplosionToggle={toggleExplosion}
          onAvatarToggle={() => { const next = !avatarVisible; engine?.setAvatarVisible(next); setAvatarVisible(next); }}
          onInfoToggle={() => setInfoEnabled((value) => !value)}
          onObjectPanelOpenChange={setObjectPanelOpen}
          onStandardView={(view) => engine?.setStandardView(view)}
          onFullscreen={() => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())}
          onStartXR={(mode) => void engine?.startXR(mode).catch((reason) => setError(message(reason)))}
        />
      )}
      {objectPanelOpen && engine && (
        <PublishedViewerObjectPanel
          locale={locale}
          models={models}
          selected={selected}
          properties={engine.getSelectionProperties()}
          isolationActive={engine.isIsolationActive()}
          onSelect={(id) => engine.select(id)}
          onFocus={(id) => engine.focusModel(id)}
          onVisibilityChange={(id, visible) => { engine.setVisible(id, visible); refreshModels(); }}
          onIsolate={(id) => { engine.isolateModels([id]); refreshModels(); }}
          onRestoreIsolation={() => { engine.clearIsolation(); refreshModels(); }}
          onShowAll={() => { for (const model of engine.listModels()) engine.setVisible(model.id, true); refreshModels(); }}
          onClose={() => setObjectPanelOpen(false)}
        />
      )}
      {infoEnabled && statistics && (
        <aside className="scene-viewer-info">
          <strong>场景信息</strong>
          <span>模型 {statistics.modelCount} · 基础元素 {statistics.primitiveCount}</span>
          <span>三角面 {statistics.triangleCount.toLocaleString(locale)}</span>
        </aside>
      )}
      {error && <div className="scene-viewer-fatal" role="alert">{error}</div>}
      <PublishedModelCredits locale={locale} models={manifest.project.models} modelIds={manifest.publication.snapshot.models.map(getSceneModelAssetId)} />
    </main>
  );
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "只读场景加载失败";
}
