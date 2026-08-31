import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import {
  initializeSceneViewerDelivery,
  isSceneViewerDeliveryRuntime,
} from "./delivery/sceneViewerDelivery";
import { loadSceneViewerDeliveryManifest } from "./api";

const sceneViewerBuild = import.meta.env.VITE_SCENE_VIEWER_BUILD === "true";

async function bootstrap(): Promise<void> {
  await initializeSceneViewerDelivery(loadSceneViewerDeliveryManifest);
  if (sceneViewerBuild) {
    if (!isSceneViewerDeliveryRuntime()) throw new Error("只读客户端缺少发布器清单，已阻止进入工作台");
    await import("./delivery/sceneViewerStyles");
    const { SceneViewerRoot } = await import("./delivery/SceneViewerRoot");
    createRoot(document.getElementById("root")!).render(<StrictMode><SceneViewerRoot /></StrictMode>);
    return;
  }
  await renderStudioApplication();
}

async function renderStudioApplication(): Promise<void> {
  await import("./editorStyles");
  const [{ App }, { DesktopConnectionGate }] = await Promise.all([
    import("./App"),
    import("./components/DesktopConnectionGate"),
  ]);
  // 视觉验收页默认不进入生产入口；CI 通过一次性构建变量显式启用。
  const visualQaEnabled = import.meta.env.DEV || import.meta.env.VITE_VISUAL_QA === "true";
  const DashboardVisualQa = visualQaEnabled ? lazy(() => import("./visualQa/DashboardVisualQa")) : undefined;
  const ViewerVisualQa = visualQaEnabled ? lazy(() => import("./visualQa/ViewerVisualQa")) : undefined;
  const CommissioningVisualQa = visualQaEnabled ? lazy(() => import("./visualQa/CommissioningVisualQa")) : undefined;
  const visualQaMode = visualQaEnabled ? new URLSearchParams(window.location.search).get("__visualQa") : undefined;
  const standaloneDocsMode = /^\/docs(?:\/|$)/.test(window.location.pathname);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      {visualQaMode === "dashboard" && DashboardVisualQa
        ? <Suspense fallback={<div className="app-auth-loading">正在加载大屏验收页</div>}><DashboardVisualQa /></Suspense>
        : visualQaMode === "viewer" && ViewerVisualQa
          ? <Suspense fallback={<div className="app-auth-loading">正在加载三维验收页</div>}><ViewerVisualQa /></Suspense>
          : visualQaMode === "commissioning" && CommissioningVisualQa
            ? <Suspense fallback={<div className="app-auth-loading">正在加载工位验收页</div>}><CommissioningVisualQa /></Suspense>
            : standaloneDocsMode ? <App /> : <DesktopConnectionGate><App /></DesktopConnectionGate>}
    </StrictMode>,
  );
}

void bootstrap().catch((reason) => {
  const message = reason instanceof Error ? reason.message : "应用启动失败";
  createRoot(document.getElementById("root")!).render(
    <div style={{ display: "grid", width: "100%", height: "100%", placeItems: "center", padding: 32, color: "#f0d4d2", background: "#111416" }} role="alert">
      {message}
    </div>,
  );
});
