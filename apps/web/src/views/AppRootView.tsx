import { lazy, Suspense } from "react";
import { LoaderCircle } from "lucide-react";
import { LoginPage } from "../components/LoginPage";
import { AppOverlays } from "./AppOverlays";
import { AppPlatformRoutes } from "./AppPlatformRoutes";
import { AppStudioShell } from "./AppStudioShell";
import type { AppViewBindings } from "./appViewBindings";

const DocsCenter = lazy(() => import("../components/DocsCenter").then((module) => ({ default: module.DocsCenter })));

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
    <>
      <AppPlatformRoutes bindings={bindings} />
      <AppStudioShell bindings={bindings} />
      <AppOverlays bindings={bindings} />
    </>
  );
}
