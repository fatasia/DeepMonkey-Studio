import { lazy, Suspense } from "react";
import { LoaderCircle } from "lucide-react";
import { LoginPage } from "../components/LoginPage";
import type { AppViewBindings } from "./appViewBindings";

const DocsCenter = lazy(() => import("../components/DocsCenter").then((module) => ({ default: module.DocsCenter })));
const AppOverlays = lazy(() => import("./AppOverlays").then((module) => ({ default: module.AppOverlays })));
const AppPlatformRoutes = lazy(() => import("./AppPlatformRoutes").then((module) => ({ default: module.AppPlatformRoutes })));
const AppStudioShell = lazy(() => import("./AppStudioShell").then((module) => ({ default: module.AppStudioShell })));
const AppBehaviorOverlay = lazy(() => import("./AppBehaviorOverlay").then((module) => ({ default: module.AppBehaviorOverlay })));

interface AppRootViewProps {
  bindings: AppViewBindings;
  onOpenDocs: (documentId?: string, sectionId?: string) => void;
  onCloseDocs: () => void;
}

/** 只负责根路由的可见页面选择，不持有应用业务状态。 */
export function AppRootView({ bindings, onOpenDocs, onCloseDocs }: AppRootViewProps) {
  const { authReady, branding, currentUser, locale, route, setCurrentUser } = bindings.state;

  if (route.view === "docs") {
    return (
      <Suspense
        fallback={
          <div className="optimizer-loading">
            <LoaderCircle className="spin" size={25} /> 正在加载使用文档
          </div>
        }
      >
        <DocsCenter {...(route.documentId ? { documentId: route.documentId } : {})} onNavigate={onOpenDocs} onClose={onCloseDocs} />
      </Suspense>
    );
  }

  if (!authReady) {
    return (
      <div className="app-auth-loading">
        <LoaderCircle className="spin" size={24} /> 正在验证本地会话
      </div>
    );
  }
  if (!currentUser) return <LoginPage branding={branding} locale={locale} onLogin={setCurrentUser} />;

  return (
    <Suspense fallback={<div className="app-auth-loading"><LoaderCircle className="spin" size={24} />正在加载项目工作台</div>}>
      <div className={`app-workspace-frame ${bindings.state.sceneBehaviorOpen ? `behavior-${bindings.state.sceneBehaviorLayout} behavior-from-${route.view}` : ""}`}>
        <div className="app-workspace-surface">
          <AppPlatformRoutes bindings={bindings} />
          <AppStudioShell bindings={bindings} />
        </div>
        <AppBehaviorOverlay bindings={bindings} />
      </div>
      <AppOverlays bindings={bindings} />
    </Suspense>
  );
}
