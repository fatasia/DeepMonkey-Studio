import { useEffect } from "react";
import type { ApplicationObjectRef } from "@bim-studio/contracts";
import { api, getAuthToken, setAuthToken } from "../api";
import { localDesktopUser } from "../adapters/desktopLocalApi";
import { currentDesktopRuntimeMode, isDesktopRuntime } from "../adapters/runtimeHost";
import { RENDERER_BACKEND_STORAGE_KEY, REVIT_VERSION_STORAGE_KEY } from "../appDefaults";
import { storeLocale } from "../i18n";
import {
  probeRendererCapabilities,
  rendererRequirementsForScene,
  selectPublishedRenderer,
} from "../rendererCapabilities";
import type { createApplicationRuntimeController } from "../controllers/applicationRuntimeController";
import type { createScenePersistenceController } from "../controllers/scenePersistenceController";
import type { useAppNavigationController } from "./useAppNavigationController";
import type { AppState } from "./useAppState";
import {
  isSceneViewerDeliveryRuntime,
  sceneViewerDeliveryRendererMode,
  sceneViewerDeliveryUser,
} from "../delivery/sceneViewerDelivery";
import { applyDocumentBranding } from "../branding/documentBranding";

type ApplicationController = ReturnType<typeof createApplicationRuntimeController>;
type PersistenceController = ReturnType<typeof createScenePersistenceController>;
type NavigationController = ReturnType<typeof useAppNavigationController>;

interface AppLifecycleEffectsOptions {
  state: AppState;
  saveActiveApplication: ApplicationController["saveActiveApplication"];
  saveScene: PersistenceController["saveScene"];
  changeRendererBackend: NavigationController["changeRendererBackend"];
}

/** 集中处理会话、自动保存、品牌和发布渲染策略等应用生命周期副作用。 */
export function useAppLifecycleEffects({ state, saveActiveApplication, saveScene, changeRendererBackend }: AppLifecycleEffectsOptions) {
  const {
    activeApplication,
    activeScene,
    applicationRevision,
    applicationSessionRef,
    applicationState,
    autoSaveEnabled,
    branding,
    busy,
    currentUser,
    engine,
    lastAutoSavedSceneRevisionRef,
    locale,
    rendererBackend,
    rendererSwitching,
    revision,
    route,
    rvtRevitVersion,
    selected,
    setApplicationRevision,
    setAuthReady,
    setBranding,
    setCurrentUser,
    setLocale,
    setRevitRuntime,
    setRvtRevitVersion,
  } = state;

  useEffect(
    () =>
      applicationSessionRef.current.store.subscribe(() => {
        setApplicationRevision((value) => value + 1);
      }),
    [],
  );

  useEffect(() => {
    if (!autoSaveEnabled || !applicationState.dirty || busy || !activeApplication) return;
    const timer = window.setTimeout(() => void saveActiveApplication(true), 1_200);
    return () => window.clearTimeout(timer);
  }, [autoSaveEnabled, applicationRevision, applicationState.dirty, activeApplication?.metadata.id, busy]);

  useEffect(() => {
    lastAutoSavedSceneRevisionRef.current = revision;
  }, [activeScene?.id]);

  useEffect(() => {
    if (!autoSaveEnabled || route.view !== "studio" || !activeScene || !engine || busy || revision <= lastAutoSavedSceneRevisionRef.current) return;
    const timer = window.setTimeout(() => void saveScene(true), 1_500);
    return () => window.clearTimeout(timer);
  }, [autoSaveEnabled, route.view, activeScene?.id, engine, revision, busy]);

  useEffect(() => {
    if (route.view !== "studio" || !route.applicationId || !activeScene) return;
    const selection: ApplicationObjectRef[] = selected ? [{ kind: "object", sceneId: activeScene.id, modelId: selected.id }] : [];
    applicationSessionRef.current.store.setSelection(selection);
  }, [route.view, route.applicationId, activeScene?.id, selected?.id]);

  useEffect(() => {
    let cancelled = false;
    void api
      .getBranding()
      .then((settings) => {
        if (!cancelled) {
          setBranding(settings);
          if (!window.localStorage.getItem("bim-studio.locale")) setLocale(settings.defaultLocale);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!currentUser || isSceneViewerDeliveryRuntime()) return;
    let cancelled = false;
    void api
      .listRevitInstallations()
      .then((runtime) => {
        if (cancelled) return;
        setRevitRuntime(runtime);
        if (rvtRevitVersion !== "auto" && !runtime.installations.some((item) => item.version === rvtRevitVersion)) {
          setRvtRevitVersion("auto");
          window.localStorage.setItem(REVIT_VERSION_STORAGE_KEY, "auto");
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [currentUser?.id]);

  useEffect(() => {
    applyDocumentBranding(branding);
  }, [branding]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;
    const requireLogin = () => {
      setAuthToken();
      setCurrentUser(undefined);
      setAuthReady(true);
    };
    window.addEventListener("bim-studio-auth-required", requireLogin);
    const deliveryUser = sceneViewerDeliveryUser();
    if (deliveryUser) {
      setCurrentUser(deliveryUser);
      setAuthReady(true);
    } else if (isDesktopRuntime() && currentDesktopRuntimeMode() === "local") {
      setCurrentUser(localDesktopUser());
      setAuthReady(true);
    } else if (!getAuthToken()) setAuthReady(true);
    else {
      const restoreSession = () => {
        void api.me().then((user) => {
          if (cancelled) return;
          setCurrentUser(user);
          setAuthReady(true);
        }).catch(() => {
          if (cancelled) return;
          // 401 交给统一二次复核；断网和 5xx 保持凭据并等待服务恢复，不跳回登录页。
          if (!getAuthToken()) {
            setAuthReady(true);
            return;
          }
          retryTimer = window.setTimeout(restoreSession, 2_000);
        });
      };
      restoreSession();
    }
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      window.removeEventListener("bim-studio-auth-required", requireLogin);
    };
  }, []);

  useEffect(() => storeLocale(locale), [locale]);

  useEffect(() => {
    if (route.view !== "published" || !activeScene || !engine || rendererSwitching) return;
    let cancelled = false;
    // 不能只检查 navigator.gpu：部分设备会暴露 API，但无法取得适配器。
    // 真实预检可避免发布页在 WebGPU 初始化失败与 WebGL 回退之间反复切换。
    void probeRendererCapabilities().then((probe) => {
      if (cancelled) return;
      const webGpuAvailable = probe.secureContext && probe.webgpuApi && probe.webgpuAdapter;
      const decision = selectPublishedRenderer(
        sceneViewerDeliveryRendererMode() ?? activeScene.publicationMode,
        webGpuAvailable,
        rendererRequirementsForScene(activeScene),
      );
      if (decision.backend === rendererBackend) return;
      const fallbackMessage =
        decision.reason === "preserve-authored-effects"
          ? "为保持作者后处理与真实轮廓效果，发布页已自动使用 WebGL"
          : decision.reason === "webgpu-unavailable"
            ? "当前设备无法使用 WebGPU，发布页已自动使用 WebGL"
            : undefined;
      changeRendererBackend(decision.backend, {
        persistPreference: false,
        ...(fallbackMessage ? { message: fallbackMessage } : {}),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [activeScene, engine, rendererBackend, rendererSwitching, route.view]);

  useEffect(() => {
    if (!engine || rendererSwitching || route.view === "published") return;
    const stored = window.localStorage.getItem(RENDERER_BACKEND_STORAGE_KEY) === "webgpu" ? "webgpu" : "webgl";
    if (stored !== rendererBackend) {
      void changeRendererBackend(stored, { persistPreference: false, message: `已恢复用户渲染偏好：${stored === "webgpu" ? "WebGPU（实验）" : "WebGL"}` });
    }
  }, [engine, rendererBackend, rendererSwitching, route.view]);
}
