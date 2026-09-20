import { lazy, StrictMode, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/base.css";
import { ApplicationErrorBoundary, ApplicationErrorFallback } from "./components/ApplicationErrorBoundary";
import {
  initializeSceneViewerDelivery,
  isSceneViewerDeliveryRuntime,
} from "./delivery/sceneViewerDelivery";
import { loadSceneViewerDeliveryManifest } from "./api";
import { markStartup } from "./startupTimeline";
import { exposeStartupEvidenceCollector } from "./startupEvidence";
import { DesktopWindowFrame } from "./components/DesktopWindowFrame";

const sceneViewerBuild = import.meta.env.VITE_SCENE_VIEWER_BUILD === "true";
const root = createRoot(document.getElementById("root")!);
function renderRoot(children: ReactNode) {
  root.render(
    <StrictMode>
      <ApplicationErrorBoundary>{sceneViewerBuild ? children : <DesktopWindowFrame>{children}</DesktopWindowFrame>}</ApplicationErrorBoundary>
    </StrictMode>
  );
}

async function bootstrap(): Promise<void> {
  markStartup("bootstrap-start");
  await initializeSceneViewerDelivery(loadSceneViewerDeliveryManifest);
  markStartup("delivery-manifest-loaded");
  if (sceneViewerBuild) {
    if (!isSceneViewerDeliveryRuntime()) throw Error("只读客户端缺少发布器清单，已阻止进入工作台");
    // 样式与渲染根并行加载：CSS 不阻塞 JS 求值，任一失败仍整体抛错（语义不变）。
    const [, { SceneViewerRoot }] = await Promise.all([
      import("./delivery/sceneViewerStyles"),
      import("./delivery/SceneViewerRoot"),
    ]);
    markStartup("scene-viewer-render-start");
    renderRoot(<SceneViewerRoot />);
    return;
  }
  await renderStudioApplication();
}

async function renderStudioApplication(): Promise<void> {
  const [, { PublishedApplicationRoot }] = await Promise.all([
    import("./editorStyles"),
    import("./delivery/PublishedApplicationRoot"),
  ]);
  markStartup("editor-styles-loaded");
  if (/^\/apps(?:\/|$)/.test(window.location.pathname)) {
    markStartup("studio-render-start");
    renderRoot(<PublishedApplicationRoot />);
    return;
  }
  // 视觉验收页默认不进入生产入口；CI 通过一次性构建变量显式启用。
  const visualQaEnabled = import.meta.env.DEV || import.meta.env.VITE_VISUAL_QA === "true";
  const DashboardVisualQa = visualQaEnabled ? lazy(() => import("./visualQa/DashboardVisualQa")) : undefined;
  const ViewerVisualQa = visualQaEnabled ? lazy(() => import("./visualQa/ViewerVisualQa")) : undefined;
  const CommissioningVisualQa = visualQaEnabled ? lazy(() => import("./visualQa/CommissioningVisualQa")) : undefined;
  const OperationsPlanningVisualQa = visualQaEnabled ? lazy(() => import("./visualQa/OperationsPlanningVisualQa")) : undefined;
  const SceneSimulationVisualQa = visualQaEnabled ? lazy(() => import("./visualQa/SceneSimulationVisualQa")) : undefined;
  const DeviceSignalVisualQa = visualQaEnabled ? lazy(() => import("./visualQa/DeviceSignalVisualQa")) : undefined;
  const TopologyVisualQa = visualQaEnabled ? lazy(() => import("./visualQa/TopologyVisualQa")) : undefined;
  const ParametricVisualQa = visualQaEnabled ? lazy(() => import("./visualQa/ParametricVisualQa")) : undefined;
  const BrandingVisualQa = visualQaEnabled ? lazy(() => import("./visualQa/BrandingVisualQa")) : undefined;
  const SceneDrillVisualQa = visualQaEnabled ? lazy(() => import("./visualQa/SceneDrillVisualQa")) : undefined;
  const ObjectTreeVisualQa = visualQaEnabled ? lazy(() => import("./visualQa/ObjectTreeVisualQa")) : undefined;
  const WorkspaceChromeVisualQa = visualQaEnabled ? lazy(() => import("./visualQa/WorkspaceChromeVisualQa")) : undefined;
  const ModelDiffVisualQa = visualQaEnabled ? lazy(() => import("./visualQa/ModelDiffVisualQa")) : undefined;
  const visualQaMode = visualQaEnabled ? new URLSearchParams(window.location.search).get("__visualQa") : undefined;
  if (visualQaMode && DashboardVisualQa && ViewerVisualQa && CommissioningVisualQa && OperationsPlanningVisualQa && SceneSimulationVisualQa && ModelDiffVisualQa) {
    const VisualQaPage = visualQaMode === "device-signal" ? DeviceSignalVisualQa : visualQaMode === "dashboard"
      ? DashboardVisualQa
      : visualQaMode === "viewer"
        ? ViewerVisualQa
        : visualQaMode === "commissioning"
          ? CommissioningVisualQa
          : visualQaMode === "operations-planning"
            ? OperationsPlanningVisualQa
          : visualQaMode === "scene-simulation"
            ? SceneSimulationVisualQa
          : visualQaMode === "topology"
            ? TopologyVisualQa
          : visualQaMode === "parametric"
            ? ParametricVisualQa
          : visualQaMode === "branding"
            ? BrandingVisualQa
          : visualQaMode === "scene-drill"
            ? SceneDrillVisualQa
          : visualQaMode === "object-tree"
            ? ObjectTreeVisualQa
          : visualQaMode === "workspace-chrome"
            ? WorkspaceChromeVisualQa
          : visualQaMode === "model-diff"
            ? ModelDiffVisualQa
          : undefined;
    if (VisualQaPage) {
      // 仅视觉验收入口允许 URL 指定主题；不改用户偏好或平台品牌设置。
      const qaTheme = new URLSearchParams(window.location.search).get("theme");
      if (qaTheme === "light" || qaTheme === "dark") document.documentElement.dataset.theme = qaTheme;
      renderRoot(
          <Suspense fallback={<div className="app-auth-loading">正在加载视觉验收页</div>}>
            <VisualQaPage />
          </Suspense>
      );
      return;
    }
  }

  // 编辑器主路径：样式与应用包并行加载（样式原本串行阻塞在此处之前）。
  const [, { App }, { DesktopConnectionGate }] = await Promise.all([
    import("./editorStyles"),
    import("./App"),
    import("./components/DesktopConnectionGate"),
  ]);
  const standaloneDocsMode = /^\/docs(?:\/|$)/.test(window.location.pathname);
  markStartup("studio-render-start");
  renderRoot(standaloneDocsMode ? <App /> : <DesktopConnectionGate><App /></DesktopConnectionGate>);
}

exposeStartupEvidenceCollector();
void bootstrap().catch((reason) => {
  console.error("STUDIO_STARTUP_FAILED", reason);
  root.render(<ApplicationErrorFallback startup />);
});
