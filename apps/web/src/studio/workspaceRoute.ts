export interface DashboardViewState {
  zoom: number;
  scrollLeft: number;
  scrollTop: number;
  selectedNodeIds: string[];
}

export interface DashboardWorkspaceLocation {
  kind: "dashboard";
  projectId: string;
  applicationId: string;
  pageId: string;
}

export interface SceneWorkspaceLocation {
  kind: "scene";
  projectId: string;
  applicationId: string;
  sceneId: string;
}

export type StudioWorkspaceLocation = DashboardWorkspaceLocation | SceneWorkspaceLocation;

export interface DashboardReturnContext extends DashboardWorkspaceLocation {
  view: DashboardViewState;
}

export interface TopologyReturnContext extends DashboardReturnContext {
  /** Existing topology widget to refill after editing. */
  nodeId: string;
}

export interface StudioWorkspaceHistoryState {
  dashboardView?: DashboardViewState;
  dashboardReturn?: DashboardReturnContext;
  topologyReturn?: TopologyReturnContext;
}

export const DEFAULT_DASHBOARD_VIEW: DashboardViewState = Object.freeze({
  zoom: 0.5,
  scrollLeft: 0,
  scrollTop: 0,
  selectedNodeIds: []
});

export function parseStudioWorkspacePath(pathname: string): StudioWorkspaceLocation | undefined {
  const match = pathname.match(/^\/studio\/([^/]+)\/applications\/([^/]+)\/(pages|scenes)\/([^/]+)\/?$/);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return undefined;
  const projectId = decodePathSegment(match[1]);
  const applicationId = decodePathSegment(match[2]);
  const resourceId = decodePathSegment(match[4]);
  if (!projectId || !applicationId || !resourceId) return undefined;
  return match[3] === "pages"
    ? { kind: "dashboard", projectId, applicationId, pageId: resourceId }
    : { kind: "scene", projectId, applicationId, sceneId: resourceId };
}

export function studioWorkspacePath(location: StudioWorkspaceLocation): string {
  const resource = location.kind === "dashboard"
    ? `pages/${encodeURIComponent(location.pageId)}`
    : `scenes/${encodeURIComponent(location.sceneId)}`;
  return `/studio/${encodeURIComponent(location.projectId)}/applications/${encodeURIComponent(location.applicationId)}/${resource}`;
}

export function normalizeDashboardViewState(value: unknown): DashboardViewState {
  const candidate = asRecord(value);
  return {
    zoom: clamp(finiteNumber(candidate.zoom, DEFAULT_DASHBOARD_VIEW.zoom), 0.1, 2),
    scrollLeft: Math.max(0, finiteNumber(candidate.scrollLeft, 0)),
    scrollTop: Math.max(0, finiteNumber(candidate.scrollTop, 0)),
    selectedNodeIds: Array.isArray(candidate.selectedNodeIds)
      ? [...new Set(candidate.selectedNodeIds.filter((item): item is string => typeof item === "string" && item.length > 0))]
      : []
  };
}

export function readWorkspaceHistoryState(value: unknown): StudioWorkspaceHistoryState {
  const state = asRecord(asRecord(value).bimStudio);
  const dashboardReturn = readDashboardReturnContext(state.dashboardReturn);
  const topologyReturn = readTopologyReturnContext(state.topologyReturn);
  return {
    ...(state.dashboardView ? { dashboardView: normalizeDashboardViewState(state.dashboardView) } : {}),
    ...(dashboardReturn ? { dashboardReturn } : {}),
    ...(topologyReturn ? { topologyReturn } : {})
  };
}

function readTopologyReturnContext(value: unknown): TopologyReturnContext | undefined {
  const dashboard = readDashboardReturnContext(value);
  const candidate = asRecord(value);
  if (!dashboard || typeof candidate.nodeId !== "string" || !candidate.nodeId) return undefined;
  return { ...dashboard, nodeId: candidate.nodeId };
}

export function workspaceHistoryState(state: StudioWorkspaceHistoryState): Record<string, unknown> {
  return { bimStudio: structuredClone(state) };
}

function readDashboardReturnContext(value: unknown): DashboardReturnContext | undefined {
  const candidate = asRecord(value);
  if (candidate.kind !== "dashboard"
    || typeof candidate.projectId !== "string"
    || typeof candidate.applicationId !== "string"
    || typeof candidate.pageId !== "string") return undefined;
  return {
    kind: "dashboard",
    projectId: candidate.projectId,
    applicationId: candidate.applicationId,
    pageId: candidate.pageId,
    view: normalizeDashboardViewState(candidate.view)
  };
}

function decodePathSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
