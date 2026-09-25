import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { api } from "../api";
import { createUpsertScriptModuleCommand } from "@bim-studio/studio-core";
import { flushPendingBehaviorDraft } from "../behavior/behaviorDraftNavigation";
import { lockedBehaviorScriptChange } from "../behavior/behaviorScriptLockPolicy";
import { docsPath } from "../docs/docsRoute";
import { REVIT_VERSION_STORAGE_KEY } from "../appDefaults";
import { readRoute, routeHistoryState, routePath, type AppRoute } from "../appRoute";
import type { RendererBackend } from "../viewer/ViewerEngine";
import type { DashboardViewState } from "../studio/workspaceRoute";
import type { AppState } from "./useAppState";
import { sceneViewerDeliveryRoute } from "../delivery/sceneViewerDelivery";
import { useManagerDirectoryController } from "./useManagerDirectoryController";
import { carriesProjectContext, rememberProjectContext } from "../projectNavigationContext";
import { stageRendererPreference } from "../viewer/rendererBackendPreference";
import { rendererBackendLabel } from "../viewer/rendererBackendLabel";

interface AppNavigationControllerOptions {
  state: AppState;
  sceneSnapshotFactoryRef: RefObject<(() => SceneSnapshot | undefined) | undefined>;
}

/** 管理应用路由、项目生命周期和渲染后端切换，避免入口组件承担导航细节。 */
export function useAppNavigationController({ state, sceneSnapshotFactoryRef }: AppNavigationControllerOptions) {
  const managerDirectory = useManagerDirectoryController(state);
  const {
    activeScene,
    authReady,
    currentUser,
    dataReturnRouteRef,
    engine,
    message,
    newProjectDescription,
    newProjectName,
    project,
    projectDialogMode,
    projects,
    rendererBackend,
    rendererActiveBackend,
    rendererPreferenceCommitRef,
    rendererSnapshotRef,
    rendererSwitching,
    route,
    sceneApplyVersionRef,
    setActiveScene,
    setAnnotations,
    setBusy,
    setDigitalTwinOpen,
    setExpandedModels,
    setError,
    setMeasurements,
    setMessage,
    setNewProjectDescription,
    setNewProjectName,
    setProject,
    setProjectDialogMode,
    setProjects,
    setRendererBackend,
    setRendererSwitchMessage,
    setRendererSwitchPhase,
    setRendererSwitching,
    setRevision,
    setRoute,
    setSceneName,
    setScenes,
    setSelected,
    setSelectedAnnotationId,
    setSelectedSpace,
    showError,
  } = state;
  const activeProjectId = useRef(project?.id);
  const projectSubmitting = useRef(false);
  const docsReturnRoute = useRef<AppRoute | undefined>(undefined);
  activeProjectId.current = project?.id;

  useEffect(() => {
    if (authReady && currentUser && route.view === "branding" && currentUser.role !== "admin") navigate({ view: "manager" }, true);
  }, [authReady, currentUser?.id, currentUser?.role, route.view]);

  function navigate(next: AppRoute, replace = false) {
    if (carriesProjectContext(next.view) && !next.projectId && project) next = { ...next, projectId: project.id };
    const deliveryRoute = sceneViewerDeliveryRoute();
    if (deliveryRoute) next = deliveryRoute;
    // 数据桥是当前工作区的临时抽屉；跨路由保留会遮挡目标页面操作。
    setDigitalTwinOpen(false);
    window.history[replace ? "replaceState" : "pushState"](routeHistoryState(next), "", routePath(next));
    setRoute(next);
  }

  function openDataCenter() {
    if (route.view !== "data") dataReturnRouteRef.current = structuredClone(route);
    navigate({ view: "data" });
  }

  function closeDataCenter() {
    const destination = dataReturnRouteRef.current;
    dataReturnRouteRef.current = undefined;
    navigate(destination ?? { view: "manager" });
  }

  function openDocs(documentId?: string, sectionId?: string) {
    if (sceneViewerDeliveryRoute()) {
      navigate(sceneViewerDeliveryRoute()!, true);
      return;
    }
    if (route.view !== "docs") {
      try {
        const result = flushPendingBehaviorDraft(state.pendingBehaviorDraftRef, draft => {
          const document = state.applicationSessionRef.current.store.getState().document;
          if (document && lockedBehaviorScriptChange(document, [...document.scripts.filter(script => script.id !== draft.id), draft], engine, activeScene?.id)) {
            setError("挂载对象已锁定，草稿已保留，请先解锁");
            return false;
          }
          state.applicationSessionRef.current.store.dispatch(createUpsertScriptModuleCommand(draft));
        });
        if (result === "write-rejected") return;
        if (result === "name-required") {
          setError("请先填写脚本名称，再离开脚本编辑器");
          return;
        }
      } catch (reason) {
        showError(reason);
        return;
      }
      docsReturnRoute.current = structuredClone(route);
      if (route.view === "studio") {
        const snapshot = sceneSnapshotFactoryRef.current?.();
        if (snapshot) {
          setActiveScene(snapshot);
          rendererSnapshotRef.current = { scene: snapshot, readOnly: false, fastRuntime: false, recoveryMessage: "已返回编辑器，场景修改已保留" };
        }
      }
    }
    setError(undefined);
    const next: AppRoute = { view: "docs", ...(documentId ? { documentId } : {}) };
    window.history.pushState(routeHistoryState(next), "", docsPath(documentId, sectionId));
    setRoute(next);
  }

  function closeDocs() {
    if (sceneViewerDeliveryRoute()) {
      navigate(sceneViewerDeliveryRoute()!, true);
      return;
    }
    const destination = docsReturnRoute.current;
    docsReturnRoute.current = undefined;
    navigate(destination ?? { view: "manager" });
  }

  function replaceDashboardView(view: DashboardViewState) {
    if (route.view !== "dashboard") return;
    const next = { ...route, dashboardView: view };
    window.history.replaceState(routeHistoryState(next), "", routePath(next));
  }

  function changeRendererBackend(next: RendererBackend, options: { persistPreference?: boolean; message?: string } = {}) {
    if (next === rendererBackend || rendererSwitching || !engine) return;
    if (next !== "webgl" && (!("gpu" in navigator) || !window.isSecureContext)) {
      showError(new Error("当前浏览器、显卡或访问地址不支持 WebGPU，请使用新版 Chrome/Edge 和 HTTPS"));
      return;
    }
    stageRendererPreference(rendererPreferenceCommitRef, next, options.persistPreference !== false);
    setRendererSwitchPhase("preparing");
    setRendererSwitchMessage(`正在准备 ${rendererBackendLabel(next)}；当前画布仍在使用 ${rendererBackendLabel(rendererActiveBackend)}`);
    setRendererBackend(next);
    setRendererSwitching(true);
    setMessage(options.message ?? `正在切换到 ${rendererBackendLabel(next)}`);
  }

  useEffect(() => {
    if (!carriesProjectContext(route.view) || !route.projectId) return;
    const requested = projects.find(item => item.id === route.projectId);
    if (requested && requested.id !== project?.id) switchProject(requested, false);
  }, [route.view, route.projectId, projects, project?.id]);

  function switchProject(next: ProjectRecord, updateLocation = true) {
    if (next.id === project?.id) return;
    sceneApplyVersionRef.current += 1;
    engine?.clearSceneModels();
    setProject(next);
    if (currentUser) rememberProjectContext(currentUser.id, next.id);
    setActiveScene(undefined);
    setSceneName("未命名场景");
    setSelected(undefined);
    setMeasurements([]);
    setAnnotations([]);
    setSelectedAnnotationId(undefined);
    setSelectedSpace(undefined);
    setExpandedModels(new Set());
    if (route.view === "studio" || route.view === "view" || route.view === "published") navigate({ view: "manager", projectId: next.id });
    else if (updateLocation && carriesProjectContext(route.view)) navigate({ ...route, projectId: next.id }, true);
    setMessage(`已切换到项目“${next.name}”`);
    setRevision((value) => value + 1);
  }

  function switchProjectById(projectId: string) {
    const next = projects.find((item) => item.id === projectId);
    if (next) switchProject(next);
  }

  function openProjectDialog(mode: "create" | "rename") {
    setProjectDialogMode(mode);
    setNewProjectName(mode === "rename" ? (project?.name ?? "") : "");
    setNewProjectDescription(mode === "rename" ? (project?.description ?? "") : "");
  }

  async function submitProjectDialog() {
    const name = newProjectName.trim();
    if (!name || projectSubmitting.current) return;
    projectSubmitting.current = true;
    // 显式重试属于一次新操作，旧失败提示不能与后续成功反馈并存。
    setError(undefined);
    setBusy(true);
    try {
      if (projectDialogMode === "rename" && project) {
        const updated = await api.updateProject(project.id, name, newProjectDescription.trim());
        setProjects((items) => items.map((item) => (item.id === updated.id ? updated : item)));
        setProject(updated);
        setMessage(`项目已重命名为“${updated.name}”`);
      } else {
        const created = await api.createProject(name, newProjectDescription.trim());
        setProjects((items) => [...items, created]);
        switchProject(created);
        setMessage(`项目“${created.name}”已创建`);
      }
      setNewProjectName("");
      setNewProjectDescription("");
      setProjectDialogMode(undefined);
    } catch (reason) {
      showError(reason);
    } finally {
      projectSubmitting.current = false;
      setBusy(false);
    }
  }

  async function deleteCurrentProject() {
    if (!project || !window.confirm(`确定删除项目“${project.name}”吗？\n项目内的模型文件和场景也会被删除，此操作不可撤销。`)) return;
    setBusy(true);
    try {
      await api.deleteProject(project.id);
      const remaining = projects.filter((item) => item.id !== project.id);
      setProjects(remaining);
      sceneApplyVersionRef.current += 1;
      engine?.clearSceneModels();
      setActiveScene(undefined);
      setScenes([]);
      setSelected(undefined);
      setMeasurements([]);
      setAnnotations([]);
      setProject(remaining[0]);
      setSceneName("未命名场景");
      if (route.view === "studio" || route.view === "view" || route.view === "published") navigate({ view: "manager" });
      setMessage(`项目“${project.name}”已删除`);
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  }

  const refreshProject = useCallback(async () => {
    if (!project) return;
    const next = await api.getProject(project.id);
    if (activeProjectId.current !== project.id) return;
    setProject(next);
    setProjects((items) => items.map((item) => (item.id === next.id ? next : item)));
  }, [project?.id]);

  return {
    managerDirectory,
    navigate,
    openDataCenter,
    closeDataCenter,
    openDocs,
    closeDocs,
    replaceDashboardView,
    changeRendererBackend,
    switchProject,
    switchProjectById,
    openProjectDialog,
    submitProjectDialog,
    deleteCurrentProject,
    refreshProject,
  };
}

function sortScenesByTime(items: SceneSnapshot[]): SceneSnapshot[] {
  return [...items].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}
