import { docsPath, parseDocsPath } from "./docs/docsRoute";
import {
  parseStudioWorkspacePath,
  readWorkspaceHistoryState,
  studioWorkspacePath,
  workspaceHistoryState,
  type DashboardReturnContext,
  type DashboardViewState,
  type TopologyReturnContext
} from "./studio/workspaceRoute";
import { sceneViewerDeliveryRoute } from "./delivery/sceneViewerDelivery";
import { appendSceneAssetQuery, readModelAssetQuery, writeModelAssetQuery, type ModelAssetReturn } from "./optimizer/modelAssetNavigation";
import { carriesProjectContext } from "./projectNavigationContext";

export type ManagerWorkspaceTab = "scenes" | "assets" | "topology" | "examples";

export interface AppRoute {
  view: "manager" | "dashboard" | "studio" | "topology" | "optimizer" | "parametric" | "data" | "vision" | "operations" | "docs" | "system" | "branding" | "view" | "published";
  sceneId?: string;
  projectId?: string;
  modelId?: string;
  assetScope?: "project";
  assetReturn?: ModelAssetReturn;
  insertModelId?: string;
  replaceModelInstanceId?: string;
  managerTab?: ManagerWorkspaceTab;
  applicationId?: string;
  pageId?: string;
  topologyId?: string;
  documentId?: string;
  fallback?: "not-found";
  dashboardView?: DashboardViewState;
  dashboardReturn?: DashboardReturnContext;
  topologyReturn?: TopologyReturnContext;
  operationsTab?: "maintenance" | "commissioning" | "battery" | "logistics" | "energy" | "whatif" | "monitoring";
  systemTab?: "users" | "health" | "cloud-render" | "notifications" | "audit" | "ai" | "mcp" | "performance";
}

const operationsTabs = new Set(["maintenance", "commissioning", "battery", "logistics", "energy", "whatif", "monitoring"]);
const systemTabs = new Set(["users", "health", "cloud-render", "notifications", "audit", "ai", "mcp"]);

export function readRoute(): AppRoute {
  try {
    return readLocationRoute();
  } catch (error) {
    // 非法 URL 编码不能让整个工作台在初始化阶段白屏。
    if (error instanceof URIError) return { view: "manager", fallback: "not-found" };
    throw error;
  }
}

function readLocationRoute(): AppRoute {
  const deliveryRoute = sceneViewerDeliveryRoute();
  if (deliveryRoute) return deliveryRoute;
  const workspace = parseStudioWorkspacePath(window.location.pathname);
  const historyState = readWorkspaceHistoryState(window.history.state);
  if (workspace?.kind === "dashboard") return {
    view: "dashboard",
    ...workspace,
    ...(historyState.dashboardView ? { dashboardView: historyState.dashboardView } : {})
  };
  if (workspace?.kind === "scene") return {
    view: "studio",
    ...workspace,
    ...readModelAssetQuery(new URLSearchParams(window.location.search), true),
    ...(historyState.dashboardReturn ? { dashboardReturn: historyState.dashboardReturn } : {})
  };
  const docsLocation = parseDocsPath(window.location.pathname);
  if (docsLocation) return { view: "docs", ...docsLocation };
  if (["optimizer", "parametric", "data", "vision", "operations", "system", "branding"].includes(window.location.pathname.slice(1))) {
    const view = window.location.pathname.slice(1) as AppRoute["view"];
    const requestedTask = new URLSearchParams(window.location.search).get("task");
    const requestedSystemTab = new URLSearchParams(window.location.search).get("tab");
    const projectId = new URLSearchParams(window.location.search).get("project");
    return {
      view,
      ...(projectId ? { projectId } : {}),
      ...(view === "optimizer" ? readModelAssetQuery(new URLSearchParams(window.location.search)) : {}),
      ...(view === "operations" && requestedTask && operationsTabs.has(requestedTask)
        ? { operationsTab: requestedTask as NonNullable<AppRoute["operationsTab"]> }
        : {}),
      ...(view === "system" && requestedSystemTab && systemTabs.has(requestedSystemTab)
        ? { systemTab: requestedSystemTab as NonNullable<AppRoute["systemTab"]> }
        : {}),
    };
  }
  const topologyMatch = window.location.pathname.match(/^\/projects\/([^/]+)\/applications\/([^/]+)\/topologies\/([^/]+)$/);
  if (topologyMatch?.[1] && topologyMatch[2] && topologyMatch[3]) return {
    view: "topology",
    projectId: decodeURIComponent(topologyMatch[1]),
    applicationId: decodeURIComponent(topologyMatch[2]),
    topologyId: decodeURIComponent(topologyMatch[3]),
    ...(historyState.topologyReturn ? { topologyReturn: historyState.topologyReturn } : {})
  };
  const match = window.location.pathname.match(/^\/(studio|view|published)\/([^/]+)$/);
  if (match?.[1] && match[2]) {
    const query = new URLSearchParams(window.location.search);
    return { view: match[1] as "studio" | "view" | "published", sceneId: decodeURIComponent(match[2]), ...(match[1] === "studio" ? { ...(query.get("project") ? { projectId: query.get("project")! } : {}), ...readModelAssetQuery(query, true) } : {}) };
  }
  if (window.location.pathname === "/" || window.location.pathname === "/manager") {
    const query = new URLSearchParams(window.location.search);
    const projectId = query.get("project");
    const tab = query.get("tab");
    return { view: "manager", ...(projectId ? { projectId } : {}), ...readModelAssetQuery(query),
      ...(tab && ["scenes", "assets", "topology", "examples"].includes(tab) ? { managerTab: tab as ManagerWorkspaceTab } : {}) };
  }
  return { view: "manager", fallback: "not-found" };
}

export function routePath(route: AppRoute): string {
  const deliveryRoute = sceneViewerDeliveryRoute();
  if (deliveryRoute) return `/published/${encodeURIComponent(deliveryRoute.sceneId)}`;
  if (route.view === "docs") return docsPath(route.documentId);
  if (carriesProjectContext(route.view)) {
    const query = new URLSearchParams();
    if (route.projectId) query.set("project", route.projectId);
    if (route.view === "manager" && route.managerTab) query.set("tab", route.managerTab);
    if (route.view === "manager" || route.view === "optimizer") writeModelAssetQuery(query, route);
    if (route.view === "operations" && route.operationsTab) query.set("task", route.operationsTab);
    if (route.view === "system" && route.systemTab) query.set("tab", route.systemTab);
    return `/${route.view}${query.size ? `?${query.toString().replace(/\+/g, "%20")}` : ""}`;
  }
  if (route.view === "dashboard" && route.projectId && route.applicationId && route.pageId) {
    return studioWorkspacePath({ kind: "dashboard", projectId: route.projectId, applicationId: route.applicationId, pageId: route.pageId });
  }
  if (route.view === "studio" && route.projectId && route.applicationId && route.sceneId) {
    return appendSceneAssetQuery(studioWorkspacePath({ kind: "scene", projectId: route.projectId, applicationId: route.applicationId, sceneId: route.sceneId }), route);
  }
  if (route.view === "topology" && route.projectId && route.applicationId && route.topologyId) {
    return `/projects/${encodeURIComponent(route.projectId)}/applications/${encodeURIComponent(route.applicationId)}/topologies/${encodeURIComponent(route.topologyId)}`;
  }
  return route.view === "vision" || route.view === "operations" || route.view === "system" || route.view === "branding"
    ? route.view === "operations" && route.operationsTab
      ? `/operations?task=${encodeURIComponent(route.operationsTab)}`
      : route.view === "system" && route.systemTab
        ? `/system?tab=${encodeURIComponent(route.systemTab)}`
        : `/${route.view}`
    : route.view === "studio" ? appendSceneAssetQuery(`/studio/${encodeURIComponent(route.sceneId ?? "new")}`, route) : `/${route.view}/${encodeURIComponent(route.sceneId ?? "new")}`;
}

export function routeHistoryState(route: AppRoute): Record<string, unknown> {
  return workspaceHistoryState({
    ...(route.dashboardView ? { dashboardView: route.dashboardView } : {}),
    ...(route.dashboardReturn ? { dashboardReturn: route.dashboardReturn } : {}),
    ...(route.topologyReturn ? { topologyReturn: route.topologyReturn } : {})
  });
}

export function openBrowseRoute(view: "view" | "published", sceneId: string): void {
  window.open(routePath({ view, sceneId }), "_blank", "noopener,noreferrer");
}
