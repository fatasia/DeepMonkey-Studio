import { lazy, Suspense, useEffect, useRef, useState, type ComponentProps, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, LoaderCircle, PanelRightOpen } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import { BEHAVIOR_FLOAT_RECT_STORAGE_KEY, BEHAVIOR_LAYOUT_STORAGE_KEY, BEHAVIOR_SPLIT_WIDTH_STORAGE_KEY, BEHAVIOR_WINDOW_RECT_STORAGE_KEY, type BehaviorLayoutMode } from "../appDefaults";
import {
  clampBehaviorFloatRect,
  defaultBehaviorFloatRect,
  moveBehaviorFloatRect,
  parseBehaviorFloatRect,
  resizeBehaviorFloatRect,
  type BehaviorFloatRect,
} from "../behavior/behaviorFloatLayout";
import { DEFAULT_DASHBOARD_VIEW } from "../studio/workspaceRoute";
import { resolvePreferredScriptTarget } from "../studio/sceneScriptContext";
import { findScriptTargetLocation } from "../studio/workspaceTargetNavigation";
import type { AppViewBindings } from "./appViewBindings";
import { useAuthorBehaviorRun } from "../behavior/useAuthorBehaviorRun";
import type { SdkExampleInsertRequest } from "../behavior/sdkExampleInsertion";
import { readBehaviorScriptSelection, rememberBehaviorScriptSelection } from "../behavior/behaviorScriptSelection";

const SceneBehaviorPanel = lazy(() => import("../components/SceneBehaviorPanel").then((module) => ({ default: module.SceneBehaviorPanel })));
const AuthorBehaviorPreview = lazy(() => import("../components/AuthorBehaviorPreview").then(module => ({ default: module.AuthorBehaviorPreview })));

export function AppBehaviorOverlay({ bindings, sdkExampleRequest, onSdkExampleConsumed }: {
  bindings: AppViewBindings;
  sdkExampleRequest?: SdkExampleInsertRequest;
  onSdkExampleConsumed?: (requestId: string) => void;
}) {
  const { state, derived, sceneEditor, applicationRuntime, actions } = bindings;
  const { activeApplication, activeDashboardPage, activeScene, applicationState, locale, route } = state;
  const authorRun = useAuthorBehaviorRun({
    enabled: state.sceneBehaviorOpen && (route.view === "studio" || route.view === "dashboard"),
    ...(activeApplication ? { application: activeApplication } : {}), ...(state.project ? { project: state.project } : {}),
    ...(route.view === "dashboard" && activeDashboardPage ? { pageId: activeDashboardPage.id } : {}),
    ...(route.view === "studio" && activeScene ? { sceneId: activeScene.id } : {}),
    variables: applicationState.variables, filters: applicationState.filters,
  });
  const [splitWidth, setSplitWidth] = useState(readSplitWidth);
  const [floatRect, setFloatRect] = useState(readFloatRect);
  const [portalHost] = useState(createBehaviorPortalHost);
  const [portalReady, setPortalReady] = useState(false);
  const [popupWindow, setPopupWindow] = useState<Window>();
  const portalAnchorRef = useRef<HTMLDivElement>(null);
  const selectedScripts = useRef(new Map<string, string>());
  const layoutMode = state.sceneBehaviorLayout ?? "split";
  const workspaceLabel = activeScene?.name ?? activeDashboardPage?.name ?? activeApplication?.metadata.name ?? tr(locale, "未命名场景", "Untitled scene");
  useEffect(() => {
    const clampToViewport = () => setFloatRect((current) => clampBehaviorFloatRect(current, currentViewport()));
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, []);
  useEffect(() => {
    if (!portalHost || layoutMode === "window" || !portalAnchorRef.current) return;
    portalHost.classList.remove("app-shell");
    portalAnchorRef.current.appendChild(portalHost);
    setPortalReady(true);
  }, [layoutMode, portalHost, state.sceneBehaviorOpen]);
  useEffect(() => {
    if (!popupWindow) return;
    const checkClosed = window.setInterval(() => {
      if (!popupWindow.closed) return;
      window.clearInterval(checkClosed);
      if (portalHost && portalAnchorRef.current) {
        portalHost.classList.remove("app-shell");
        portalAnchorRef.current.appendChild(portalHost);
      }
      setPopupWindow(undefined);
      persistPreference(BEHAVIOR_LAYOUT_STORAGE_KEY, "float");
      state.setSceneBehaviorLayout("float");
    }, 300);
    return () => window.clearInterval(checkClosed);
  }, [popupWindow, portalHost, state.setSceneBehaviorLayout]);
  useEffect(() => {
    if (state.sceneBehaviorOpen) return;
    closeBehaviorWindow(popupWindow);
    setPopupWindow(undefined);
    if (layoutMode === "window") state.setSceneBehaviorLayout("float");
  }, [state.sceneBehaviorOpen, popupWindow, layoutMode]);
  if (!state.sceneBehaviorOpen || !activeApplication || (route.view !== "studio" && route.view !== "dashboard")) {
    return null;
  }

  const linkedViewport = activeDashboardPage?.nodes.find((node) => node.kind === "scene-viewport");
  const selectionKey = `${state.currentUser?.id ?? ""}:${activeApplication.metadata.id}`;
  const rememberedScriptId = selectedScripts.current.get(selectionKey)
    ?? readBehaviorScriptSelection(state.currentUser?.id ?? "", activeApplication.metadata.id);
  const linkedSceneId = linkedViewport && "sceneId" in linkedViewport ? linkedViewport.sceneId : activeScene?.id;
  const preferredTarget = resolvePreferredScriptTarget(
    derived.behaviorCodeTargets,
    route.view === "dashboard" ? applicationState.selection : [],
    derived.selectedBehaviorTarget,
  );

  const focusTarget: ComponentProps<typeof SceneBehaviorPanel>["onFocusTarget"] = async (target) => {
    // 脚本切换会重新加载应用文档；先落盘，避免定位目标时恢复到服务端旧版本。
    if (!(await applicationRuntime.saveActiveApplication())) return;
    const location = findScriptTargetLocation(
      activeApplication,
      target,
      target.kind === "object" && derived.selectedBehaviorTarget?.id === target.id ? activeScene?.id : undefined,
    );
    if (!location) {
      state.setMessage(
        tr(locale, "目标已从当前应用移除，请重新选择挂载对象", "The target was removed; select a new attachment"),
      );
      return;
    }

    state.setSceneBehaviorOpen(false);
    if (location.kind === "component") {
      state.applicationSessionRef.current.store.setSelection([{ kind: "widget", id: target.id }]);
      actions.navigate({
        view: "dashboard",
        projectId: activeApplication.metadata.projectId,
        applicationId: activeApplication.metadata.id,
        pageId: location.pageId,
        dashboardView: {
          ...(route.view === "dashboard" ? (route.dashboardView ?? DEFAULT_DASHBOARD_VIEW) : DEFAULT_DASHBOARD_VIEW),
          selectedNodeIds: [target.id],
        },
      });
      state.setMessage(tr(locale, `已定位二维组件“${target.name}”`, `Focused 2D component “${target.name}”`));
      return;
    }

    if (derived.selectedComponent?.stableId === target.id && activeScene?.id === location.sceneId) {
      sceneEditor.focusComponent(derived.selectedComponent);
      state.setMessage(tr(locale, `已定位 BIM 构件“${target.name}”`, `Focused BIM component “${target.name}”`));
      return;
    }

    // 跨工作区定位要等待新场景和渲染器就绪，不能调用已经卸载的 Viewer。
    state.pendingSceneFocusRef.current = { sceneId: location.sceneId, objectId: target.id, label: target.name };
    actions.navigate({
      view: "studio",
      projectId: activeApplication.metadata.projectId,
      applicationId: activeApplication.metadata.id,
      sceneId: location.sceneId,
      ...(route.view === "dashboard" && route.projectId && route.applicationId && route.pageId
        ? {
            dashboardReturn: {
              kind: "dashboard" as const,
              projectId: route.projectId,
              applicationId: route.applicationId,
              pageId: route.pageId,
              view: route.dashboardView ?? DEFAULT_DASHBOARD_VIEW,
            },
          }
        : route.dashboardReturn
          ? { dashboardReturn: route.dashboardReturn }
          : {}),
    });
  };

  const changeLayout = (mode: BehaviorLayoutMode) => {
    if (mode === "window") {
      if (!portalHost) return;
      if (popupWindow && !popupWindow.closed) {
        popupWindow.focus();
        return;
      }
      const popup = openBehaviorWindow(locale, workspaceLabel, state.branding.systemName);
      if (!popup) {
        persistPreference(BEHAVIOR_LAYOUT_STORAGE_KEY, "float");
        state.setSceneBehaviorLayout("float");
        state.setMessage(tr(locale, "浏览器拦截了独立窗口，已保留内容并切换到悬浮模式", "The popup was blocked; content was preserved in float mode"));
        return;
      }
      portalHost.classList.add("app-shell");
      popup.document.body.appendChild(portalHost);
      setPopupWindow(popup);
      state.setSceneBehaviorLayout("window");
      return;
    }
    if (portalHost && portalAnchorRef.current) {
      portalHost.classList.remove("app-shell");
      portalAnchorRef.current.appendChild(portalHost);
    }
    closeBehaviorWindow(popupWindow);
    setPopupWindow(undefined);
    persistPreference(BEHAVIOR_LAYOUT_STORAGE_KEY, mode);
    state.setSceneBehaviorLayout(mode);
  };

  // 首次内联面板会被 portal 重挂载；一次性插入请求须等稳定挂载后才消费。
  const stableSdkExampleRequest = !portalHost || portalReady ? sdkExampleRequest : undefined;
  const panel = <Suspense fallback={<div className="behavior-panel-loading" role="status"><LoaderCircle className="spin" size={17} />{tr(locale, "正在加载脚本编辑器", "Loading script editor")}</div>}>
    <SceneBehaviorPanel
      key={activeApplication.metadata.id}
      locale={locale}
      projectId={activeApplication.metadata.projectId}
      applicationId={activeApplication.metadata.id}
      {...(rememberedScriptId ? { initialSelectedScriptId: rememberedScriptId } : {})}
      onSelectedScriptChange={id => {
        selectedScripts.current.set(selectionKey, id);
        rememberBehaviorScriptSelection(state.currentUser?.id ?? "", activeApplication.metadata.id, id);
      }}
      {...(stableSdkExampleRequest ? { sdkExampleRequest: stableSdkExampleRequest } : {})}
      {...(onSdkExampleConsumed ? { onSdkExampleConsumed } : {})}
      scripts={activeApplication.scripts}
      dependencies={activeApplication.scriptDependencies ?? []}
      codeTargets={derived.behaviorCodeTargets}
      {...(preferredTarget ? { preferredTarget } : {})}
      intelligence={derived.behaviorScriptContext}
      runtimeEntries={authorRun.session?.entries ?? []}
      logs={authorRun.logs}
      paused={authorRun.session?.paused ?? false}
      hasSession={Boolean(authorRun.session)}
      canStep={authorRun.session?.canStep ?? false}
      onStep={authorRun.step}
      resolveSceneId={(target) => {
        if (target.kind === "component") return linkedSceneId;
        const location = findScriptTargetLocation(activeApplication, target, derived.selectedBehaviorTarget?.id === target.id ? activeScene?.id : undefined);
        return location?.kind === "object" ? location.sceneId : undefined;
      }}
      onUpsert={applicationRuntime.upsertBehaviorScript}
      autoSaveEnabled={state.autoSaveEnabled}
      onAutoSaveChange={applicationRuntime.changeAutoSave}
      onSaveWorkspace={applicationRuntime.saveActiveApplication}
      onDelete={id => { authorRun.stop(); applicationRuntime.deleteBehaviorScript(id); }}
      onReplaceScripts={scripts => { authorRun.stop(); return applicationRuntime.replaceBehaviorScripts(scripts); }}
      onDependenciesChange={dependencies => { authorRun.stop(); return applicationRuntime.replaceScriptDependencies(dependencies); }}
      onRun={authorRun.run}
      onDebug={authorRun.debug}
      debugging={authorRun.session?.debugging ?? false}
      onPauseResume={authorRun.pauseResume}
      onStop={authorRun.stop}
      onClearLogs={authorRun.clearLogs}
      onOpenDocs={actions.openDocs}
      onFocusTarget={focusTarget}
      layoutMode={layoutMode}
      onLayoutModeChange={changeLayout}
      onPendingDraftChange={(draft) => { state.pendingBehaviorDraftRef.current = draft; bindings.applicationRecovery?.captureScriptDraft(draft); }}
      onClose={() => { closeBehaviorWindow(popupWindow); state.setSceneBehaviorOpen(false); }}
    />
  </Suspense>;

  return (
    <div
      className={`behavior-workspace-slot layout-${layoutMode}`}
      style={{
        "--behavior-split-width": `${splitWidth}px`,
        "--behavior-float-left": `${floatRect.x}px`,
        "--behavior-float-top": `${floatRect.y}px`,
        "--behavior-float-width": `${floatRect.width}px`,
        "--behavior-float-height": `${floatRect.height}px`,
      } as CSSProperties}
      onPointerDown={layoutMode === "float" ? (event) => startFloatDrag(event, floatRect, setFloatRect) : undefined}
      onDoubleClick={layoutMode === "float" ? (event) => {
        const target = event.target as HTMLElement;
        if (!target.closest(".behavior-panel-header") || target.closest("button,input,select,textarea,a,summary")) return;
        const next = defaultBehaviorFloatRect(currentViewport());
        setFloatRect(next);
        persistPreference(BEHAVIOR_FLOAT_RECT_STORAGE_KEY, JSON.stringify(next));
      } : undefined}
    >
      <div className="behavior-portal-anchor" ref={portalAnchorRef} />
      {layoutMode === "window" && <div className="behavior-window-return" role="region" aria-label={tr(locale, "脚本独立窗口", "Detached script window")}>
        <span>{tr(locale, "脚本已在独立窗口打开", "Scripts are open in another window")}</span>
        <button type="button" onClick={() => popupWindow?.focus()}><ExternalLink size={14} />{tr(locale, "显示窗口", "Show window")}</button>
        <button type="button" onClick={() => changeLayout("split")}><PanelRightOpen size={14} />{tr(locale, "回到分屏", "Return to split")}</button>
      </div>}
      {portalReady && portalHost ? createPortal(panel, portalHost) : panel}
      {authorRun.session && state.project && <Suspense fallback={null}><AuthorBehaviorPreview key={authorRun.id} session={authorRun.session} project={state.project} locale={locale} rendererBackend={state.rendererBackend} onStop={authorRun.stop} /></Suspense>}
      {layoutMode === "float" && (
        <button
          className="behavior-float-resizer"
          type="button"
          aria-label={tr(locale, "调整脚本编辑器大小", "Resize script editor")}
          title={tr(locale, "拖动调整大小；Shift + 方向键快速调整", "Drag to resize; use Shift + arrow keys for larger steps")}
          onPointerDown={(event) => startFloatResize(event, floatRect, setFloatRect)}
          onKeyDown={(event) => {
            if (!event.key.startsWith("Arrow")) return;
            event.preventDefault();
            const step = event.shiftKey ? 80 : 24;
            const next = resizeBehaviorFloatRect(
              floatRect,
              event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0,
              event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0,
              currentViewport(),
            );
            setFloatRect(next);
            persistPreference(BEHAVIOR_FLOAT_RECT_STORAGE_KEY, JSON.stringify(next));
          }}
        />
      )}
      {(state.sceneBehaviorLayout ?? "split") === "split" && (
        <button
          className="behavior-split-resizer"
          type="button"
          role="separator"
          aria-orientation="vertical"
          aria-label={tr(locale, "拖动调整代码与预览宽度", "Drag to resize code and preview")}
          title={tr(locale, "拖动调整代码与预览宽度", "Drag to resize code and preview")}
          onPointerDown={(event) => {
            const slot = event.currentTarget.parentElement;
            if (!slot) return;
            event.preventDefault();
            const startX = event.clientX;
            const startWidth = slot.getBoundingClientRect().width;
            let latestWidth = startWidth;
            slot.classList.add("is-resizing");
            const move = (next: PointerEvent) => {
              const width = Math.max(520, Math.min(window.innerWidth - 360, startWidth + next.clientX - startX));
              latestWidth = width;
              slot.style.setProperty("--behavior-split-width", `${width}px`);
            };
            const stop = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", stop);
              slot.classList.remove("is-resizing");
              setSplitWidth(latestWidth);
              persistPreference(BEHAVIOR_SPLIT_WIDTH_STORAGE_KEY, String(latestWidth));
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", stop, { once: true });
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            const slot = event.currentTarget.parentElement;
            if (!slot) return;
            event.preventDefault();
            const step = event.shiftKey ? 80 : 24;
            const width = slot.getBoundingClientRect().width + (event.key === "ArrowRight" ? step : -step);
            const nextWidth = Math.max(520, Math.min(window.innerWidth - 360, width));
            slot.style.setProperty("--behavior-split-width", `${nextWidth}px`);
            setSplitWidth(nextWidth);
            persistPreference(BEHAVIOR_SPLIT_WIDTH_STORAGE_KEY, String(nextWidth));
          }}
        />
      )}
    </div>
  );
}

export function behaviorWindowTitle(locale: AppLocale, workspaceLabel: string, systemName: string): string {
  return tr(locale, `${workspaceLabel} · 脚本编辑器 · ${systemName}`, `${workspaceLabel} · Script editor · ${systemName}`);
}

function openBehaviorWindow(locale: AppLocale, workspaceLabel: string, systemName: string): Window | undefined {
  const rect = readWindowRect();
  const popup = window.open("", "bim-studio-script-editor", `popup=yes,resizable=yes,scrollbars=yes,width=${rect.width},height=${rect.height},left=${rect.left},top=${rect.top}`) ?? undefined;
  if (!popup) return undefined;
  popup.document.documentElement.lang = locale === "zh-CN" ? "zh-CN" : "en";
  popup.document.documentElement.setAttribute("data-theme", document.documentElement.getAttribute("data-theme") ?? "dark");
  popup.document.documentElement.style.cssText = document.documentElement.style.cssText;
  const base = popup.document.createElement("base");
  base.href = document.baseURI;
  popup.document.head.replaceChildren(base, ...[...document.head.querySelectorAll('link[rel="stylesheet"],style')].map((node) => node.cloneNode(true)));
  popup.document.title = behaviorWindowTitle(locale, workspaceLabel, systemName);
  popup.document.body.className = `${document.body.className} behavior-popout-body`;
  popup.document.body.replaceChildren();
  popup.focus();
  return popup;
}

function createBehaviorPortalHost(): HTMLDivElement | undefined {
  if (typeof document === "undefined") return undefined;
  const host = document.createElement("div");
  host.className = "behavior-popout-root";
  return host;
}

function closeBehaviorWindow(popup: Window | undefined): void {
  if (!popup || popup.closed) return;
  try {
    persistPreference(BEHAVIOR_WINDOW_RECT_STORAGE_KEY, JSON.stringify({ left: popup.screenX, top: popup.screenY, width: popup.outerWidth, height: popup.outerHeight }));
    popup.close();
  } catch {
    // A browser can revoke access after opening; the main editor remains authoritative.
  }
}

function readWindowRect(): { left: number; top: number; width: number; height: number } {
  try {
    const value = JSON.parse(window.localStorage.getItem(BEHAVIOR_WINDOW_RECT_STORAGE_KEY) ?? "{}") as Partial<{ left: number; top: number; width: number; height: number }>;
    if ([value.left, value.top, value.width, value.height].every(Number.isFinite)) return { left: value.left!, top: value.top!, width: Math.max(760, value.width!), height: Math.max(560, value.height!) };
  } catch {
    // Ignore malformed preferences.
  }
  return { left: Math.max(0, window.screenX + 80), top: Math.max(0, window.screenY + 60), width: 1180, height: 780 };
}

function startFloatDrag(event: ReactPointerEvent<HTMLDivElement>, initial: BehaviorFloatRect, update: (rect: BehaviorFloatRect) => void): void {
  if (event.button !== 0) return;
  const target = event.target as HTMLElement;
  if (!target.closest(".behavior-panel-header") || target.closest("button,input,select,textarea,a,summary,nav")) return;
  beginFloatPointerGesture(event, event.currentTarget, initial, update, (rect, deltaX, deltaY) => moveBehaviorFloatRect(rect, deltaX, deltaY, currentViewport()));
}

function startFloatResize(event: ReactPointerEvent<HTMLButtonElement>, initial: BehaviorFloatRect, update: (rect: BehaviorFloatRect) => void): void {
  if (event.button !== 0) return;
  event.stopPropagation();
  const slot = event.currentTarget.parentElement;
  if (!slot) return;
  beginFloatPointerGesture(event, slot, initial, update, (rect, deltaX, deltaY) => resizeBehaviorFloatRect(rect, deltaX, deltaY, currentViewport()));
}

function beginFloatPointerGesture(
  event: ReactPointerEvent<HTMLElement>,
  slot: HTMLElement,
  initial: BehaviorFloatRect,
  update: (rect: BehaviorFloatRect) => void,
  transform: (rect: BehaviorFloatRect, deltaX: number, deltaY: number) => BehaviorFloatRect,
): void {
  event.preventDefault();
  const startX = event.clientX;
  const startY = event.clientY;
  let latest = initial;
  const move = (next: PointerEvent) => {
    latest = transform(initial, next.clientX - startX, next.clientY - startY);
    applyFloatRectStyles(slot, latest);
  };
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    window.removeEventListener("blur", stop);
    update(latest);
    persistPreference(BEHAVIOR_FLOAT_RECT_STORAGE_KEY, JSON.stringify(latest));
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop, { once: true });
  window.addEventListener("pointercancel", stop, { once: true });
  window.addEventListener("blur", stop, { once: true });
}

function applyFloatRectStyles(slot: HTMLElement, rect: BehaviorFloatRect): void {
  slot.style.setProperty("--behavior-float-left", `${rect.x}px`);
  slot.style.setProperty("--behavior-float-top", `${rect.y}px`);
  slot.style.setProperty("--behavior-float-width", `${rect.width}px`);
  slot.style.setProperty("--behavior-float-height", `${rect.height}px`);
}

function readSplitWidth(): number {
  const viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth;
  try {
    const value = Number(window.localStorage.getItem(BEHAVIOR_SPLIT_WIDTH_STORAGE_KEY));
    if (Number.isFinite(value) && value >= 520) return Math.min(value, Math.max(520, viewportWidth - 360));
  } catch {
    // Browser storage is optional; the product remains usable in restricted webviews.
  }
  return Math.min(900, Math.max(520, viewportWidth * 0.62));
}

function readFloatRect(): BehaviorFloatRect {
  try {
    return parseBehaviorFloatRect(window.localStorage.getItem(BEHAVIOR_FLOAT_RECT_STORAGE_KEY), currentViewport());
  } catch {
    return defaultBehaviorFloatRect(currentViewport());
  }
}

function currentViewport() {
  return {
    width: typeof window === "undefined" ? 1_440 : window.innerWidth,
    height: typeof window === "undefined" ? 900 : window.innerHeight,
  };
}

function persistPreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Preference persistence must never block the editor.
  }
}
