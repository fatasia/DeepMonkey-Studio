import { translate as tr } from "../i18n";
import { SceneBehaviorPanel } from "../components/SceneBehaviorPanel";
import { DEFAULT_DASHBOARD_VIEW } from "../studio/workspaceRoute";
import { resolvePreferredScriptTarget } from "../studio/sceneScriptContext";
import { findScriptTargetLocation } from "../studio/workspaceTargetNavigation";
import type { AppViewBindings } from "./appViewBindings";

export function AppBehaviorOverlay({ bindings }: { bindings: AppViewBindings }) {
  const { state, derived, sceneEditor, scenePersistence, applicationRuntime, actions } = bindings;
  const { activeApplication, activeDashboardPage, activeScene, applicationState, locale, route } = state;
  if (!state.sceneBehaviorOpen || !activeApplication || (route.view !== "studio" && route.view !== "dashboard")) {
    return null;
  }

  const linkedViewport = activeDashboardPage?.nodes.find((node) => node.kind === "scene-viewport");
  const linkedSceneId = linkedViewport && "sceneId" in linkedViewport ? linkedViewport.sceneId : activeScene?.id;
  const workspaceContextLabel = route.view === "dashboard"
    ? `${tr(locale, "二维页面", "2D page")} · ${activeDashboardPage?.name ?? activeApplication.metadata.name}`
    : `${tr(locale, "三维场景", "3D scene")} · ${activeScene?.name ?? activeApplication.metadata.name}`;
  const preferredTarget = resolvePreferredScriptTarget(
    derived.behaviorCodeTargets,
    route.view === "dashboard" ? applicationState.selection : [],
    derived.selectedBehaviorTarget,
  );

  const focusTarget: React.ComponentProps<typeof SceneBehaviorPanel>["onFocusTarget"] = async (target) => {
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

  return (
    <SceneBehaviorPanel
      locale={locale}
      projectId={activeApplication.metadata.projectId}
      scripts={activeApplication.scripts}
      codeTargets={derived.behaviorCodeTargets}
      {...(preferredTarget ? { preferredTarget } : {})}
      intelligence={derived.behaviorScriptContext}
      workspaceNavigation={{
        contextLabel: workspaceContextLabel,
        sceneAvailable: route.view === "studio" || Boolean(linkedSceneId),
        onSelect2D: async () => {
          if (route.view !== "studio" || !(await applicationRuntime.saveActiveApplication())) return;
          if (!(await scenePersistence.commitSceneName())) return;
          state.setSceneBehaviorOpen(false);
          applicationRuntime.returnFromSceneEditor();
        },
        onSelect3D: async () => {
          if (route.view !== "dashboard" || !linkedSceneId || !(await applicationRuntime.saveActiveApplication())) return;
          state.setSceneBehaviorOpen(false);
          applicationRuntime.enterSceneFromDashboard(linkedSceneId, route.dashboardView ?? DEFAULT_DASHBOARD_VIEW);
        },
      }}
      runtimeEntries={state.sceneBehaviorEntries}
      logs={state.sceneBehaviorLogs}
      paused={state.sceneBehaviorPaused}
      resolveSceneId={(target) => {
        if (target.kind === "component") return linkedSceneId;
        const location = findScriptTargetLocation(
          activeApplication,
          target,
          derived.selectedBehaviorTarget?.id === target.id ? activeScene?.id : undefined,
        );
        return location?.kind === "object" ? location.sceneId : undefined;
      }}
      onUpsert={applicationRuntime.upsertBehaviorScript}
      onDelete={applicationRuntime.deleteBehaviorScript}
      onRun={applicationRuntime.runSceneBehaviors}
      onPauseResume={applicationRuntime.pauseResumeSceneBehaviors}
      onStop={applicationRuntime.stopSceneBehaviors}
      onClearLogs={() => state.setSceneBehaviorLogs([])}
      onOpenDocs={actions.openDocs}
      onFocusTarget={focusTarget}
      onClose={() => state.setSceneBehaviorOpen(false)}
    />
  );
}
