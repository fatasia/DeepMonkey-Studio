import type {
  ModelFormat,
  SceneDashboardState,
  SceneDashboardWidgetState,
  SceneInteractionActionState,
  SceneInteractionScriptState,
  SceneInteractionTrigger,
  SceneSnapshot
} from "./index.js";
import { validateApplicationDocument } from "./applicationValidation.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type SceneDocument = Omit<SceneSnapshot,
  "schemaVersion" | "projectId" | "dashboard" | "interactions" |
  "publishedAt" | "createdAt" | "updatedAt">;

export interface ApplicationMetadata {
  id: string;
  projectId: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  source?: {
    kind: "scene-snapshot-v1";
    sceneId: string;
    hadInteractions: boolean;
    publishedAt?: string;
  };
}

export interface WidgetFrame { x: number; y: number; width: number; height: number; }

export interface SceneViewportWidgetNode {
  id: string;
  kind: "scene-viewport";
  frame: WidgetFrame;
  zIndex: number;
  sceneId: string;
  cameraViewId?: string;
  renderMode: "realtime" | "load-on-interaction" | "static-placeholder";
  interactionPolicy: "display-only" | "click-select" | "full-navigation";
  overlaySlot: "page";
}

export interface LegacyDashboardPanelWidgetNode {
  id: string;
  kind: "legacy-dashboard-panel";
  frame: WidgetFrame;
  zIndex: number;
  state: SceneDashboardState;
}

export type DashboardDataWidgetConfig = Omit<SceneDashboardWidgetState, "id" | "x" | "y" | "w" | "h">;

/**
 * A first-class 2D data component. Layout belongs to the page frame while the
 * component config stays independent of any scene overlay or grid library.
 */
export interface DashboardDataWidgetNode {
  id: string;
  kind: "data-widget";
  frame: WidgetFrame;
  zIndex: number;
  widget: DashboardDataWidgetConfig;
}

export type WidgetNode = SceneViewportWidgetNode | DashboardDataWidgetNode | LegacyDashboardPanelWidgetNode;

export interface DashboardPageDocument {
  id: string;
  name: string;
  width: 1920;
  height: 1080;
  nodes: WidgetNode[];
}

export interface TopologyNode { id: string; kind: string; x: number; y: number; properties: Record<string, JsonValue>; }
export interface TopologyEdge { id: string; sourceNodeId: string; targetNodeId: string; properties: Record<string, JsonValue>; }
export interface TopologyDocument { id: string; name: string; nodes: TopologyNode[]; edges: TopologyEdge[]; }
export interface GeoConfiguration { providerIds: string[]; layers: Array<{ id: string; providerId: string; visible: boolean }>; }
export interface ApplicationDataDocument { connectionIds: string[]; datasetIds: string[]; transforms: Array<{ id: string; expression: string }>; variables: Array<{ id: string; value: JsonValue }>; }

export type ApplicationObjectRef =
  | { kind: "page"; id: string }
  | { kind: "widget"; id: string }
  | { kind: "scene"; id: string }
  | { kind: "object"; sceneId: string; modelId: string; layerId?: string };

export interface InteractionFlow {
  id: string;
  name: string;
  source: ApplicationObjectRef;
  trigger: SceneInteractionTrigger;
  enabled: boolean;
  actions: SceneInteractionActionState[];
  legacyScript?: {
    runtime: "legacy-trusted-main-thread";
    script: SceneInteractionScriptState;
  };
}

export interface ScriptModule {
  id: string;
  name: string;
  apiVersion: "1.0";
  entrypoint: "behavior";
  runtime: "worker-sandbox" | "legacy-trusted-main-thread";
  code: string;
  capabilities: string[];
}
export interface AssetEntry { id: string; kind: "model" | "image" | "video" | "environment"; projectId: string; sourceName?: string; sourceFormat?: ModelFormat; contentHash?: string; }
export interface TimelineDocument { id: string; name: string; duration: number; trackIds: string[]; }
export interface PublicationProfile { id: string; name: string; target: "browser-preview" | "server-web"; entryPageId: string; renderer: "webgl2" | "auto"; }

export interface ApplicationDocument {
  schemaVersion: 2;
  metadata: ApplicationMetadata;
  pages: DashboardPageDocument[];
  topologies: TopologyDocument[];
  scenes: SceneDocument[];
  geo: GeoConfiguration;
  data: ApplicationDataDocument;
  interactions: InteractionFlow[];
  scripts: ScriptModule[];
  assets: AssetEntry[];
  timelines: TimelineDocument[];
  publicationProfiles: PublicationProfile[];
}

export interface PublishedApplicationRecord {
  id: string;
  applicationId: string;
  projectId: string;
  applicationRevision: number;
  document: ApplicationDocument;
  publishedAt: string;
}

export interface ApplicationPublicationPointer {
  applicationId: string;
  projectId: string;
  activePublicationId: string;
  updatedAt: string;
}

export interface ServerMetaResponse {
  serverInstanceId: string;
  apiVersion: "1.0";
  serverTime: string;
  capabilities: {
    applications: { schemaVersions: [2]; immutablePublications: true };
    legacyScenes: { schemaVersions: [1]; routes: true };
    authentication: { providers: ["local"] };
    hosts: { browser: true; tauri: false };
  };
}

export function assertApplicationDocument(value: unknown): asserts value is ApplicationDocument {
  validateApplicationDocument(value);
}
