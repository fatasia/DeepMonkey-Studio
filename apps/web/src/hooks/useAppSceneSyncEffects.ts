import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { api } from "../api";
import type { AppRoute } from "../appRoute";
import { derivePipelineRefreshSeconds, normalizeDataRefreshSeconds } from "../components/dataRefreshPolicy";
import type { AppState } from "./useAppState";
import { createTopologyRuntimeFailure, createTopologyRuntimeSnapshot, groupTopologyRuntimeBindings, mergeTopologyRuntimeAcknowledgements } from "../topologyRuntime";
import { focusViewerTargetWhenReady } from "../studio/workspaceTargetNavigation";
import { deleteWorkspaceRecoveryDraft, hasRecoverableWorkspaceChanges, readWorkspaceRecoveryDraft, type WorkspaceRecoveryDraft } from "../studio/workspaceRecoveryStore";
import type { createScenePersistenceController } from "../controllers/scenePersistenceController";

type PersistenceController = ReturnType<typeof createScenePersistenceController>;

interface AppSceneSyncEffectsOptions {
  state: AppState;
  recoveryDecisionRef: RefObject<string | undefined>;
  setRecoveryDraft: Dispatch<SetStateAction<WorkspaceRecoveryDraft | undefined>>;
  refreshProject: () => Promise<void>;
  navigate: (next: AppRoute, replace?: boolean) => void;
  applyScene: PersistenceController["applyScene"];
  openSceneDashboard: PersistenceController["openSceneDashboard"];
}

/** 统一同步 URL、项目、二维应用、拓扑与三维场景，入口组件只负责组装控制器。 */
export function useAppSceneSyncEffects({ state, recoveryDecisionRef, setRecoveryDraft, refreshProject, navigate, applyScene, openSceneDashboard }: AppSceneSyncEffectsOptions) {
  const {
    activeApplication,
    activeScene,
    activeTopology,
    applicationSessionRef,
    branding,
    currentUser,
    defaultEntryAppliedRef,
    engine,
    initialPathRef,
    pendingSceneFocusRef,
    project,
    route,
    sceneWorkspaceLoadRef,
    scenes,
    setManagerApplications,
    setMessage,
    setProject,
    setProjects,
    setScenes,
    setTopologyDataProducts,
    setTopologyRuntimeStates,
    showError,
    topologyDataProducts,
  } = state;

  useEffect(() => {
    if (!project) return;
    void api
      .listScenes(project.id)
      .then((items) => setScenes(sortScenesByTime(items)))
      .catch(showError);
    const timer = window.setInterval(() => void refreshProject().catch(showError), 2500);
    return () => window.clearInterval(timer);
  }, [project?.id, refreshProject, showError]);

  useEffect(() => {
    if (route.view !== "manager" || !project) return;
    let cancelled = false;
    void api
      .listApplications(project.id)
      .then((items) => {
        if (!cancelled) setManagerApplications(items);
      })
      .catch((reason) => {
        if (!cancelled) showError(reason);
      });
    return () => {
      cancelled = true;
    };
  }, [route.view, project?.id, scenes.length, showError]);

  useEffect(() => {
    if (defaultEntryAppliedRef.current || !currentUser || !project || initialPathRef.current !== "/") return;
    if (branding.defaultEntry === "studio" && scenes[0]) void openSceneDashboard(scenes[0], true);
    else if (branding.defaultEntry === "data") navigate({ view: "data" }, true);
    else if (branding.defaultEntry === "manager") navigate({ view: "manager" }, true);
    else return;
    defaultEntryAppliedRef.current = true;
  }, [branding.defaultEntry, currentUser?.id, project?.id, scenes]);

  useEffect(() => {
    if (route.view !== "dashboard" || !route.projectId || !route.applicationId || !route.pageId) return;
    const projectId = route.projectId;
    const applicationId = route.applicationId;
    const pageId = route.pageId;
    const openedApplication = applicationSessionRef.current.store.getState().document;
    if (openedApplication?.metadata.projectId === projectId && openedApplication.metadata.id === applicationId && openedApplication.pages.some((page) => page.id === pageId))
      return;
    let cancelled = false;
    void Promise.all([api.getProject(projectId), api.getApplication(projectId, applicationId)])
      .then(([nextProject, application]) => {
        if (cancelled) return;
        const page = application.pages.find((candidate) => candidate.id === pageId) ?? application.pages[0];
        if (!page) throw new Error("应用没有可编辑的二维页面");
        setProject(nextProject);
        setProjects((items) =>
          items.some((item) => item.id === nextProject.id) ? items.map((item) => (item.id === nextProject.id ? nextProject : item)) : [...items, nextProject],
        );
        applicationSessionRef.current.openDocument(application);
        if (page.id !== pageId)
          navigate({ view: "dashboard", projectId, applicationId, pageId: page.id, ...(route.dashboardView ? { dashboardView: route.dashboardView } : {}) }, true);
      })
      .catch((reason) => {
        if (!cancelled) showError(reason);
      });
    return () => {
      cancelled = true;
    };
  }, [route.view, route.projectId, route.applicationId, route.pageId]);

  useEffect(() => {
    if (route.view !== "topology" || !route.projectId || !route.applicationId || !route.topologyId) return;
    const { projectId, applicationId, topologyId } = route;
    const opened = applicationSessionRef.current.store.getState().document;
    let cancelled = false;
    const loadDocument = opened?.metadata.projectId === projectId && opened.metadata.id === applicationId ? Promise.resolve(opened) : api.getApplication(projectId, applicationId);
    void Promise.all([api.getProject(projectId), loadDocument, api.listDatasets(projectId), api.listDataPipelines(projectId)])
      .then(([nextProject, application, datasets, pipelines]) => {
        if (cancelled) return;
        const topology = application.topologies.find((candidate) => candidate.id === topologyId) ?? application.topologies[0];
        if (!topology) throw new Error("应用没有可编辑的拓扑文档");
        setProject(nextProject);
        setProjects((items) =>
          items.some((item) => item.id === nextProject.id) ? items.map((item) => (item.id === nextProject.id ? nextProject : item)) : [...items, nextProject],
        );
        if (applicationSessionRef.current.store.getState().document !== application) applicationSessionRef.current.openDocument(application);
        setTopologyDataProducts([
          ...datasets.map((dataset) => ({
            id: dataset.id,
            type: "dataset" as const,
            name: dataset.name,
            fields: dataset.fields.map((field) => field.key),
            refreshSeconds: dataset.refreshSeconds,
          })),
          ...pipelines.map((pipeline) => ({
            id: pipeline.id,
            type: "pipeline" as const,
            name: pipeline.name,
            refreshSeconds: derivePipelineRefreshSeconds(pipeline, datasets),
          })),
        ]);
        if (topology.id !== topologyId) navigate({ view: "topology", projectId, applicationId, topologyId: topology.id }, true);
      })
      .catch((reason) => {
        if (!cancelled) showError(reason);
      });
    return () => {
      cancelled = true;
    };
  }, [route.view, route.projectId, route.applicationId, route.topologyId]);

  useEffect(() => {
    if (route.view !== "topology" || !project || !activeTopology) {
      setTopologyRuntimeStates({});
      return;
    }
    const groups = groupTopologyRuntimeBindings(activeTopology.nodes);
    if (groups.length === 0) {
      setTopologyRuntimeStates({});
      return;
    }
    let cancelled = false;
    const timers: number[] = [];
    const activeNodeIds = new Set(groups.flatMap((group) => group.nodes.map((node) => node.id)));
    setTopologyRuntimeStates((current) => Object.fromEntries(Object.entries(current).filter(([nodeId]) => activeNodeIds.has(nodeId))));

    for (const group of groups) {
      const poll = async () => {
        try {
          const preview = group.productType === "dataset" ? await api.previewDataset(project.id, group.productId) : await api.previewDataPipeline(project.id, group.productId);
          if ("status" in preview && preview.status === "error") throw new Error(preview.error || "数据管道运行失败");
          if (cancelled) return;
          setTopologyRuntimeStates((current) => ({ ...current, ...mergeTopologyRuntimeAcknowledgements(current, createTopologyRuntimeSnapshot(group.nodes, preview)) }));
        } catch {
          if (!cancelled) setTopologyRuntimeStates((current) => ({ ...current, ...createTopologyRuntimeFailure(group.nodes) }));
        }
      };
      void poll();
      const configuredSeconds = topologyDataProducts.find((product) => product.type === group.productType && product.id === group.productId)?.refreshSeconds;
      if (configuredSeconds !== undefined) {
        const refreshSeconds = normalizeDataRefreshSeconds(configuredSeconds);
        if (refreshSeconds > 0) timers.push(window.setInterval(() => void poll(), refreshSeconds * 1_000));
      }
    }
    return () => {
      cancelled = true;
      for (const timer of timers) window.clearInterval(timer);
    };
  }, [activeTopology, project, route.view, topologyDataProducts]);

  useEffect(() => {
    if (route.view !== "studio" || !route.sceneId || !engine) return;
    const sceneId = route.sceneId;
    const workspaceKey = `${route.projectId ?? "browse"}:${route.applicationId ?? "scene"}:${sceneId}`;
    const applicationMatches = !route.applicationId || activeApplication?.metadata.id === route.applicationId;
    if (activeScene?.id === sceneId && applicationMatches) return;
    if (sceneWorkspaceLoadRef.current === workspaceKey) return;
    sceneWorkspaceLoadRef.current = workspaceKey;
    let cancelled = false;
    void (async () => {
      try {
        const [result, application] = await Promise.all([
          api.getSceneForBrowse(sceneId),
          route.projectId && route.applicationId ? api.getApplication(route.projectId, route.applicationId) : Promise.resolve(undefined),
        ]);
        if (cancelled) return;
        setProject(result.project);
        setProjects((items) =>
          items.some((item) => item.id === result.project.id) ? items.map((item) => (item.id === result.project.id ? result.project : item)) : [...items, result.project],
        );
        if (application) applicationSessionRef.current.openDocument(application);
        await applyScene(result.scene, false, result.project, false, false, true);
      } catch (reason) {
        if (!cancelled) {
          sceneWorkspaceLoadRef.current = undefined;
          showError(reason);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (activeScene?.id !== sceneId && sceneWorkspaceLoadRef.current === workspaceKey) sceneWorkspaceLoadRef.current = undefined;
    };
  }, [route.view, route.projectId, route.applicationId, route.sceneId, engine, activeScene?.id, showError]);

  useEffect(() => {
    const pending = pendingSceneFocusRef.current;
    if (!engine || !pending || route.view !== "studio" || activeScene?.id !== pending.sceneId) return;
    let cancelled = false;
    void focusViewerTargetWhenReady(() => engine.focusModel(pending.objectId)).then((focused) => {
      if (cancelled || pendingSceneFocusRef.current !== pending) return;
      pendingSceneFocusRef.current = undefined;
      setMessage(focused ? `已定位三维对象“${pending.label ?? pending.objectId}”` : `已打开目标场景，但对象“${pending.label ?? pending.objectId}”未能加载，请检查资源状态`);
    });
    return () => {
      cancelled = true;
    };
  }, [engine, activeScene?.id, route.view]);

  useEffect(() => {
    if (route.view !== "studio" || !route.projectId || !route.sceneId || activeScene?.id !== route.sceneId) return;
    let cancelled = false;
    void readWorkspaceRecoveryDraft(route.projectId, route.applicationId, route.sceneId).then((draft) => {
      if (cancelled || !draft || recoveryDecisionRef.current === draft.savedAt) return;
      if (!hasRecoverableWorkspaceChanges(draft, activeScene)) {
        void deleteWorkspaceRecoveryDraft(route.projectId!, route.applicationId, route.sceneId!);
        return;
      }
      if (Date.parse(draft.savedAt) > Date.parse(activeScene.updatedAt)) setRecoveryDraft(draft);
    });
    return () => {
      cancelled = true;
    };
  }, [route.view, route.projectId, route.applicationId, route.sceneId, activeScene?.id, activeScene?.updatedAt]);

  useEffect(() => {
    if ((route.view !== "view" && route.view !== "published") || !route.sceneId || !engine) return;
    const sceneId = route.sceneId;
    const browseView = route.view;
    let cancelled = false;
    void (async () => {
      try {
        const result =
          browseView === "published"
            ? await api.getPublishedSceneForBrowse(sceneId).then(({ publication, project }) => ({ scene: publication.snapshot, project }))
            : await api.getSceneForBrowse(sceneId);
        if (cancelled) return;
        setProject(result.project);
        setProjects((items) =>
          items.some((item) => item.id === result.project.id) ? items.map((item) => (item.id === result.project.id ? result.project : item)) : [...items, result.project],
        );
        await applyScene(result.scene, false, result.project, true, browseView === "published" && result.scene.publicationPerformance === "fast");
        if (!cancelled) setMessage(browseView === "published" ? "正在浏览已发布版本" : "正在浏览当前保存版本");
      } catch (reason) {
        if (!cancelled) showError(reason);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [route.view, route.sceneId, engine]);
}

function sortScenesByTime(items: SceneSnapshot[]): SceneSnapshot[] {
  return [...items].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}
