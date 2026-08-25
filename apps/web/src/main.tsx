import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DesktopConnectionGate } from "./components/DesktopConnectionGate";
import "./styles.css";

const DashboardVisualQa = import.meta.env.DEV ? lazy(() => import("./visualQa/DashboardVisualQa")) : undefined;
const visualQaMode = import.meta.env.DEV && new URLSearchParams(window.location.search).get("__visualQa") === "dashboard";
const standaloneDocsMode = /^\/docs(?:\/|$)/.test(window.location.pathname);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {visualQaMode && DashboardVisualQa
      ? <Suspense fallback={<div className="app-auth-loading">正在加载大屏验收页</div>}><DashboardVisualQa /></Suspense>
      : standaloneDocsMode ? <App /> : <DesktopConnectionGate><App /></DesktopConnectionGate>}
  </StrictMode>
);
