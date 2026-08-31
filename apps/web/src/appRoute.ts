import { docsPath, parseDocsPath } from "./docs/docsRoute";
import {
  parseStudioWorkspacePath,
  readWorkspaceHistoryState,
  studioWorkspacePath,
  workspaceHistoryState,
  type DashboardReturnContext,
  type DashboardViewState
} from "./studio/workspaceRoute";
import { sceneViewerDeliveryRoute } from "./delivery/sceneViewerDelivery";

export interface AppRoute {
  view: "manager" | "dashboard" | "studio" | "topology" | "optimizer" | "data" | "vision" | "operations" | "docs" | "system" | "branding" | "view" | "published";
  sceneId?: string;
  projectId?: string;
  applicationId?: string;
  pageId?: string;
  topologyId?: string;
  documentId?: string;
  dashboardView?: DashboardViewState;
  dashboardReturn?: DashboardReturnContext;
  operationsTab?: "maintenance" | "commissioning" | "battery" | "logistics" | "energy" | "whatif";
}

const operationsTabs = new Set(["maintenance", "commissioning", "battery", "logistics", "energy", "whatif"]);

export function readRoute(): AppRoute {
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
    ...(historyState.dashboardReturn ? { dashboardReturn: historyState.dashboardReturn } : {})
  };
  const docsLocation = parseDocsPath(window.location.pathname);
  if (docsLocation) return { view: "docs", ...docsLocation };
  if (["optimizer", "data", "vision", "operations", "system", "branding"].includes(window.location.pathname.slice(1))) {
    const view = window.location.pathname.slice(1) as AppRoute["view"];
    const requestedTask = new URLSearchParams(window.location.search).get("task");
    return {
      view,
      ...(view === "operations" && requestedTask && operationsTabs.has(requestedTask)
        ? { operationsTab: requestedTask as NonNullable<AppRoute["operationsTab"]> }
        : {}),
    };
  }
  const topologyMatch = window.location.pathname.match(/^\/projects\/([^/]+)\/applications\/([^/]+)\/topologies\/([^/]+)$/);
  if (topologyMatch?.[1] && topologyMatch[2] && topologyMatch[3]) return {
    view: "topology",
    projectId: decodeURIComponent(topologyMatch[1]),
    applicationId: decodeURIComponent(topologyMatch[2]),
    topologyId: decodeURIComponent(topologyMatch[3])
  };
  const match = window.location.pathname.match(/^\/(studio|view|published)\/([^/]+)$/);
  if (match?.[1] && match[2]) return { view: match[1] as "studio" | "view" | "published", sceneId: decodeURIComponent(match[2]) };
  return { view: "manager" };
}

export function routePath(route: AppRoute): string {
  const deliveryRoute = sceneViewerDeliveryRoute();
  if (deliveryRoute) return `/published/${encodeURIComponent(deliveryRoute.sceneId)}`;
  if (route.view === "docs") return docsPath(route.documentId);
  if (route.view === "dashboard" && route.projectId && route.applicationId && route.pageId) {
    return studioWorkspacePath({ kind: "dashboard", projectId: route.projectId, applicationId: route.applicationId, pageId: route.pageId });
  }
  if (route.view === "studio" && route.projectId && route.applicationId && route.sceneId) {
    return studioWorkspacePath({ kind: "scene", projectId: route.projectId, applicationId: route.applicationId, sceneId: route.sceneId });
  }
  if (route.view === "topology" && route.projectId && route.applicationId && route.topologyId) {
    return `/projects/${encodeURIComponent(route.projectId)}/applications/${encodeURIComponent(route.applicationId)}/topologies/${encodeURIComponent(route.topologyId)}`;
  }
  return route.view === "manager" || route.view === "optimizer" || route.view === "data" || route.view === "vision" || route.view === "operations" || route.view === "system" || route.view === "branding"
    ? route.view === "operations" && route.operationsTab
      ? `/operations?task=${encodeURIComponent(route.operationsTab)}`
      : `/${route.view}`
    : `/${route.view}/${encodeURIComponent(route.sceneId ?? "new")}`;
}

export function routeHistoryState(route: AppRoute): Record<string, unknown> {
  return workspaceHistoryState({
    ...(route.dashboardView ? { dashboardView: route.dashboardView } : {}),
    ...(route.dashboardReturn ? { dashboardReturn: route.dashboardReturn } : {})
  });
}

export function openBrowseRoute(view: "view" | "published", sceneId: string): void {
  window.open(routePath({ view, sceneId }), "_blank", "noopener,noreferrer");
}
