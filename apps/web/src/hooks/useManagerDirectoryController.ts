import { useEffect, useRef, useState } from "react";
import type { ApplicationDocument, ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { api } from "../api";
import { readRoute } from "../appRoute";
import { readProjectContext, rememberProjectContext } from "../projectNavigationContext";
import type { AppState } from "./useAppState";
import { createDirectoryRequest, directoryStateForKey, EMPTY_DIRECTORY_STATE, type DirectoryLoadState } from "./managerDirectoryRequest";

export interface ManagerDirectoryController {
  projects: DirectoryLoadState;
  scenes: DirectoryLoadState;
  applications: DirectoryLoadState;
  retry: () => void;
}

/** 目录读取与导航/渲染分离；失败不等于目录为空，也不改变登录状态。 */
export function useManagerDirectoryController(state: Pick<AppState,
  "currentUser" | "project" | "route" | "scenes" | "setProjects" | "setProject" | "setScenes" | "setManagerApplications"
>): ManagerDirectoryController {
  const { currentUser, project, route, scenes, setProjects, setProject, setScenes, setManagerApplications } = state;
  const userId = currentUser?.id ?? "";
  const projectId = project?.id ?? "";
  const projectKey = JSON.stringify([userId, projectId]);
  const identity = useRef({ userId, projectKey, view: route.view });
  identity.current = { userId, projectKey, view: route.view };
  const [catalog, setCatalog] = useState(EMPTY_DIRECTORY_STATE);
  const [sceneCatalog, setSceneCatalog] = useState(EMPTY_DIRECTORY_STATE);
  const [applicationCatalog, setApplicationCatalog] = useState(EMPTY_DIRECTORY_STATE);
  const [projectRequest] = useState(() => createDirectoryRequest<ProjectRecord[]>(setCatalog));
  const [sceneRequest] = useState(() => createDirectoryRequest<SceneSnapshot[]>(setSceneCatalog));
  const [applicationRequest] = useState(() => createDirectoryRequest<ApplicationDocument[]>(setApplicationCatalog));
  const lastSceneKey = useRef("");
  const lastApplicationKey = useRef("");
  const projectsReady = catalog.key === userId && catalog.phase === "ready";
  const scenesReady = sceneCatalog.key === projectKey && sceneCatalog.phase === "ready";

  function loadProjects() {
    if (!userId) return;
    return projectRequest.load(userId, signal => api.listProjects({ signal }), items => {
      setProjects(items);
      // 导航可能在请求途中改变，完成时以最新 URL 的项目为准。
      const requestedProjectId = readRoute().projectId;
      setProject(current => items.find(item => item.id === requestedProjectId)
        ?? items.find(item => item.id === current?.id)
        ?? items.find(item => item.id === readProjectContext(userId)) ?? items[0]);
    }, () => identity.current.userId === userId);
  }

  function loadScenes() {
    if (!userId || !projectId || !projectsReady) return;
    return sceneRequest.load(projectKey, signal => api.listScenes(projectId, { signal }), items => {
      setScenes([...items].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)));
    }, () => identity.current.projectKey === projectKey);
  }

  function loadApplications() {
    if (!userId || !projectId || !projectsReady || !scenesReady || route.view !== "manager") return;
    return applicationRequest.load(projectKey, signal => api.listApplications(projectId, { signal }), setManagerApplications,
      () => identity.current.projectKey === projectKey && identity.current.view === "manager");
  }

  useEffect(() => {
    void loadProjects();
    return projectRequest.cancel;
  }, [userId]);

  useEffect(() => {
    if (projectsReady) rememberProjectContext(userId, projectId || undefined);
  }, [userId, projectId, projectsReady]);

  useEffect(() => {
    if (lastSceneKey.current !== projectKey) { lastSceneKey.current = projectKey; setScenes([]); }
    void loadScenes();
    return sceneRequest.cancel;
  }, [projectKey, projectsReady]);

  useEffect(() => {
    if (lastApplicationKey.current !== projectKey) { lastApplicationKey.current = projectKey; setManagerApplications([]); }
    void loadApplications();
    return applicationRequest.cancel;
  }, [projectKey, route.view, scenes.length, projectsReady, scenesReady]);

  return {
    projects: directoryStateForKey(catalog, userId),
    scenes: directoryStateForKey(sceneCatalog, projectKey),
    applications: directoryStateForKey(applicationCatalog, projectKey),
    retry: () => {
      if (catalog.phase === "error") { void loadProjects(); return; }
      if (sceneCatalog.phase === "error") void loadScenes();
      if (applicationCatalog.phase === "error") void loadApplications();
    },
  };
}
