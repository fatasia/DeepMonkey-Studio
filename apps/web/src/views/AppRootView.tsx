import { lazy, Suspense } from "react";
import { LoaderCircle } from "lucide-react";
import { LoginPage } from "../components/LoginPage";
import type { AppViewBindings } from "./appViewBindings";
import { StartupInteractiveMark } from "./StartupInteractiveMark";
import { useSdkExampleNavigation } from "../hooks/useSdkExampleNavigation";

const DocsCenter = lazy(() => import("../components/DocsCenter").then((module) => ({ default: module.DocsCenter })));
const AppOverlays = lazy(() => import("./AppOverlays").then((module) => ({ default: module.AppOverlays })));
const AppPlatformRoutes = lazy(() => import("./AppPlatformRoutes").then((module) => ({ default: module.AppPlatformRoutes })));
const AppStudioShell = lazy(() => import("./AppStudioShell").then((module) => ({ default: module.AppStudioShell })));
const AppBehaviorOverlay = lazy(() => import("./AppBehaviorOverlay").then((module) => ({ default: module.AppBehaviorOverlay })));
const PublishedSceneViewerRoot = lazy(() => import("../delivery/PublishedSceneViewerRoot").then((module) => ({ default: module.PublishedSceneViewerRoot })));

interface AppRootViewProps {
  bindings: AppViewBindings;
  onOpenDocs: (documentId?: string, sectionId?: string) => void;
  onCloseDocs: () => void;
}

/** 只负责根路由的可见页面选择，不持有应用业务状态。 */
export function AppRootView({ bindings, onOpenDocs, onCloseDocs }: AppRootViewProps) {
  const { authReady, branding, currentUser, locale, route, setCurrentUser } = bindings.state;
  const sdkExamples = useSdkExampleNavigation(bindings);

  if (route.view === "docs") {
    return (
      <Suspense
        fallback={
          <div className="optimizer-loading">
            <LoaderCircle className="spin" size={25} /> 正在加载使用文档
          </div>
        }
      >
        <DocsCenter systemName={branding.systemName} {...(route.documentId ? { documentId: route.documentId } : {})} onNavigate={onOpenDocs} onClose={onCloseDocs} sdkExampleContext={sdkExamples.context} onInsertSdkExample={sdkExamples.insert} />
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
  // 发布场景链接（/published/:sceneId）允许匿名访问：服务端公开只读端点已就绪，
  // 未登录访客进入独立只读查看页，登录用户仍走完整工作台发布视图。
  if (route.view === "published" && !currentUser) {
    return (
      <Suspense
        fallback={
          <div className="app-auth-loading">
            <LoaderCircle className="spin" size={24} /> 正在加载发布场景
          </div>
        }
      >
        <PublishedSceneViewerRoot {...(route.sceneId ? { sceneId: route.sceneId } : {})} />
      </Suspense>
    );
  }
  if (!currentUser) return <LoginPage branding={branding} locale={locale} onLogin={setCurrentUser} />;

  return (
    <Suspense fallback={<div className="app-auth-loading"><LoaderCircle className="spin" size={24} />正在加载项目工作台</div>}>
      <StartupInteractiveMark />
      <div className={`app-workspace-frame ${bindings.state.sceneBehaviorOpen ? `behavior-${bindings.state.sceneBehaviorLayout} behavior-from-${route.view}` : ""}`}>
        <div className="app-workspace-surface">
          <AppPlatformRoutes bindings={bindings} />
          <AppStudioShell bindings={bindings} />
        </div>
        <AppBehaviorOverlay bindings={bindings} {...(sdkExamples.request ? { sdkExampleRequest: sdkExamples.request } : {})} onSdkExampleConsumed={sdkExamples.consumed} />
      </div>
      <AppOverlays bindings={bindings} />
    </Suspense>
  );
}
