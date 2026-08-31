import { migrateSceneSnapshotV1, type ApplicationDocument, type SceneSnapshot } from "@bim-studio/contracts";
import { createUpsertTopologyCommand } from "@bim-studio/studio-core";
import { api } from "../api";
import { DEFAULT_DASHBOARD_VIEW } from "../studio/workspaceRoute";
import { applicationForScene } from "../studio/sceneApplicationSync";
import type { ScenePersistenceControllerContext } from "./scenePersistenceControllerContext";

type WorkspaceNavigationContext = Pick<
  ScenePersistenceControllerContext,
  | "project"
  | "scenes"
  | "applicationSessionRef"
  | "navigate"
  | "saveActiveApplication"
  | "dispatchApplicationCommand"
  | "showError"
  | "setActiveScene"
  | "setBusy"
  | "setMessage"
>;

/** 二维、拓扑和三维场景共用应用文档，入口切换前先建立或恢复这个稳定锚点。 */
export function createSceneWorkspaceNavigationActions(context: WorkspaceNavigationContext) {
  const {
    project,
    scenes,
    applicationSessionRef,
    navigate,
    saveActiveApplication,
    dispatchApplicationCommand,
    showError,
    setActiveScene,
    setBusy,
    setMessage,
  } = context;

  async function ensureApplicationForScene(scene: SceneSnapshot): Promise<ApplicationDocument> {
    const applications = await api.listApplications(scene.projectId);
    const existing = applicationForScene(applications, scene.id);
    const application = existing ?? (await api.createApplication(migrateSceneSnapshotV1(scene)));
    applicationSessionRef.current.openDocument(application);
    return application;
  }

  async function openSceneDashboard(scene: SceneSnapshot, replace = false): Promise<void> {
    setBusy(true);
    try {
      const application = await ensureApplicationForScene(scene);
      const page =
        application.pages.find((candidate) => candidate.nodes.some((node) => node.kind === "scene-viewport" && node.sceneId === scene.id)) ??
        application.pages[0];
      if (!page) throw new Error("应用没有可编辑的二维页面");
      setActiveScene(scene);
      navigate(
        {
          view: "dashboard",
          projectId: scene.projectId,
          applicationId: application.metadata.id,
          pageId: page.id,
          dashboardView: DEFAULT_DASHBOARD_VIEW,
        },
        replace,
      );
      setMessage(`已打开“${page.name}”二维设计`);
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function openTopologyEditor(preferredApplication?: ApplicationDocument, preferredTopologyId?: string, createNew = false): Promise<void> {
    if (!project) return;
    setBusy(true);
    try {
      const applications = preferredApplication ? [] : await api.listApplications(project.id);
      const application = preferredApplication ?? applications[0] ?? (scenes[0] ? await ensureApplicationForScene(scenes[0]) : undefined);
      if (!application) throw new Error("请先创建一个场景，使项目拥有可保存的应用文档");
      const current = applicationSessionRef.current.store.getState().document;
      if (!current || current.metadata.id !== application.metadata.id) applicationSessionRef.current.openDocument(application);
      let topology = createNew
        ? undefined
        : (applicationSessionRef.current.store.getState().document?.topologies.find((candidate) => candidate.id === preferredTopologyId) ??
          applicationSessionRef.current.store.getState().document?.topologies[0]);
      if (!topology) {
        const existingCount = applicationSessionRef.current.store.getState().document?.topologies.length ?? 0;
        topology = {
          id: crypto.randomUUID(),
          name: existingCount ? `${project.name}拓扑 ${existingCount + 1}` : `${project.name}拓扑`,
          nodes: [],
          edges: [],
        };
        dispatchApplicationCommand(createUpsertTopologyCommand(topology));
      }
      if (applicationSessionRef.current.store.getState().dirty && !(await saveActiveApplication())) return;
      navigate({ view: "topology", projectId: project.id, applicationId: application.metadata.id, topologyId: topology.id });
      setMessage(`已打开“${topology.name}”拓扑编辑`);
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  }

  return { ensureApplicationForScene, openSceneDashboard, openTopologyEditor };
}
