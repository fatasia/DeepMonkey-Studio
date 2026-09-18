import { useEffect, type Dispatch, type SetStateAction } from "react";
import type {
  ApplicationDocument,
  ApplicationObjectRef,
  CameraViewState,
  SceneInteractionActionState,
  SceneSnapshot,
} from "@bim-studio/contracts";
import { routePath, type AppRoute } from "../appRoute";
import { runSceneNavigationTransition } from "../sceneTransitionOverlay";
import { publishLocalSceneData } from "../sceneDataBridge";
import { subscribeApplicationInteractionEffects } from "../studio/applicationInteractionHost";
import { DEFAULT_DASHBOARD_VIEW } from "../studio/workspaceRoute";
import type { ViewerEngine } from "../viewer/ViewerEngine";

type Setter<T> = Dispatch<SetStateAction<T>>;

interface AppInteractionEffectsOptions {
  activeApplication: ApplicationDocument | undefined;
  cameraViews: CameraViewState[];
  engine: ViewerEngine | undefined;
  route: AppRoute;
  scenes: SceneSnapshot[];
  navigate: (route: AppRoute, replace?: boolean) => void;
  showError: (reason: unknown) => void;
  setMessage: Setter<string>;
}

/** 将二维、三维与旧事件总线的动作收敛到同一条可取消的应用交互路径。 */
export function useAppInteractionEffects({
  activeApplication,
  cameraViews,
  engine,
  route,
  scenes,
  navigate,
  showError,
  setMessage,
}: AppInteractionEffectsOptions): void {
  useEffect(() => {
    const handleInteractionAction = (action: SceneInteractionActionState, source?: ApplicationObjectRef) => {
      if (!action) return;
      if (action.type === "unityAction") {
        const widgetId = source?.kind === "widget" ? source.id : undefined;
        if (!widgetId || !action.unityAction?.trim()) return showError(new Error("Unity 动作缺少目标 Unity 组件或动作名"));
        window.dispatchEvent(
          new CustomEvent("bim-studio:unity-action", {
            detail: {
              widgetId,
              action: action.unityAction.trim(),
              ...(action.unityObjectId?.trim() ? { objectId: action.unityObjectId.trim() } : {}),
              ...(action.value !== undefined ? { value: action.value } : {}),
            },
          }),
        );
      } else if (action.type === "dashboard" && action.dashboardPageId && activeApplication) {
        const page = activeApplication.pages.find((candidate) => candidate.id === action.dashboardPageId);
        if (!page) return showError(new Error("目标二维页面不存在"));
        navigate({
          view: "dashboard",
          projectId: activeApplication.metadata.projectId,
          applicationId: activeApplication.metadata.id,
          pageId: page.id,
          dashboardView: DEFAULT_DASHBOARD_VIEW,
        });
      } else if (action.type === "navigateScene" && action.sceneId) {
        const targetScene = activeApplication?.scenes.find((candidate) => candidate.id === action.sceneId);
        if (activeApplication && !targetScene) return showError(new Error("目标三维场景不存在，已阻止跳转"));
        if (!activeApplication && !scenes.some((candidate) => candidate.id === action.sceneId)) return showError(new Error("目标三维场景不存在，已阻止跳转"));
        const view = route.view === "studio" ? "studio" : "view";
        const destination: AppRoute = view === "studio" ? { ...route, view, sceneId: action.sceneId } : { view, sceneId: action.sceneId };
        if (action.newTab) window.open(routePath(destination), "_blank", "noopener,noreferrer");
        else void runSceneNavigationTransition(action.transition, () => navigate(destination)).catch(showError);
      } else if (action.type === "cameraView" && action.cameraViewId) {
        const cameraView = cameraViews.find((item) => item.id === action.cameraViewId);
        if (cameraView) engine?.applyCamera(cameraView.camera);
      } else if (action.type === "message") {
        setMessage(action.message?.trim() || "事件已触发");
      } else if (action.type === "setData") {
        publishLocalSceneData({
          source: "interaction",
          key: action.dataKey?.trim() || "value",
          value: action.value,
          timestamp: new Date().toISOString(),
          ...(route.sceneId ? { sceneId: route.sceneId } : {}),
        });
      } else if (action.type === "openUrl") {
        const url = action.url?.trim();
        if (!url || !/^(https?:\/\/|\/)/i.test(url)) return showError(new Error("网页地址必须以 http://、https:// 或 / 开头"));
        if (action.newTab !== false) window.open(url, "_blank", "noopener,noreferrer");
        else window.location.assign(url);
      }
    };
    const handleLegacyInteractionAction = (event: Event) => handleInteractionAction((event as CustomEvent<SceneInteractionActionState>).detail);
    const unsubscribe = subscribeApplicationInteractionEffects((effect) => handleInteractionAction(effect.action, effect.source));
    window.addEventListener("bim-studio:interaction-action", handleLegacyInteractionAction);
    return () => {
      unsubscribe();
      window.removeEventListener("bim-studio:interaction-action", handleLegacyInteractionAction);
    };
  }, [activeApplication, cameraViews, engine, route, scenes, showError]);
}
