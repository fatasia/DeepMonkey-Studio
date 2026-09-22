import type {
  ModelFormat,
  SceneDashboardWidgetState,
  SceneInteractionActionState,
  SceneInteractionScriptState,
  SceneInteractionTrigger,
  SceneSnapshot
} from "./index.js";
import { validateApplicationDocument } from "./applicationValidation.js";
import type { DashboardTemplateSource } from "./dashboardTemplateSource.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type SceneDocument = Omit<SceneSnapshot,
  "schemaVersion" | "projectId" | "dashboard" | "interactions" |
  "publishedAt" | "publicationMode" | "publicationPerformance" | "publicationToolbarVisible" | "createdAt" | "updatedAt">;

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
  /** Page-local, user-editable unique identity. The immutable id remains the persistence key. */
  name?: string;
  kind: "scene-viewport";
  frame: WidgetFrame;
  zIndex: number;
  visible?: boolean;
  selectable?: boolean;
  locked?: boolean;
  groupId?: string;
  groupName?: string;
  sceneId: string;
  cameraViewId?: string;
  renderMode: "realtime" | "load-on-interaction" | "static-placeholder";
  interactionPolicy: "display-only" | "click-select" | "full-navigation";
  overlaySlot: "page";
}

export type DashboardDataWidgetConfig = Omit<SceneDashboardWidgetState, "id" | "x" | "y" | "w" | "h">;

/**
 * A first-class 2D data component. Layout belongs to the page frame while the
 * component config stays independent of any scene overlay or grid library.
 */
export interface DashboardDataWidgetNode {
  id: string;
  /** Page-local, user-editable unique identity. The immutable id remains the persistence key. */
  name?: string;
  kind: "data-widget";
  frame: WidgetFrame;
  zIndex: number;
  visible?: boolean;
  selectable?: boolean;
  locked?: boolean;
  groupId?: string;
  groupName?: string;
  widget: DashboardDataWidgetConfig;
}

export type WidgetNode = SceneViewportWidgetNode | DashboardDataWidgetNode;

export interface DashboardPageAppearance {
  backgroundColor?: string;
  backgroundImageUrl?: string;
  backgroundImageName?: string;
  backgroundImageFit?: "cover" | "contain" | "stretch" | "original";
  backgroundImagePosition?: "center" | "top" | "bottom" | "left" | "right";
  backgroundImageRepeat?: boolean;
  backgroundOpacity?: number;
  blur?: number;
  borderRadius?: number;
}

export const DASHBOARD_PAGE_MIN_SIZE = 320;
export const DASHBOARD_PAGE_MAX_SIZE = 16_384;
export type DashboardViewportFit = "contain" | "cover" | "stretch" | "fixed";

export interface DashboardGuide {
  id: string;
  orientation: "horizontal" | "vertical";
  /** Logical canvas coordinate in pixels. */
  position: number;
}

export interface DashboardRootLayerRef { kind: "group" | "node"; id: string }

export interface DashboardPageDocument {
  id: string;
  name: string;
  /** Logical design resolution, independent from the editor viewport size. */
  width: number;
  height: number;
  /** How the published page adapts its logical resolution to the display. */
  viewportFit: DashboardViewportFit;
  appearance?: DashboardPageAppearance;
  /** 导入来源随编辑、保存与发布保留，不参与运行数据绑定。 */
  templateSource?: DashboardTemplateSource;
  /** Editor-only layout guides. They are saved with the page and hidden at runtime. */
  guides?: DashboardGuide[];
  nodes: WidgetNode[];
  /** 作者目录根顺序；组内顺序由节点 zIndex 决定。 */
  rootLayerOrder?: DashboardRootLayerRef[];
}

export interface TopologyNode { id: string; kind: string; x: number; y: number; properties: Record<string, JsonValue>; }
export interface TopologyEdge { id: string; sourceNodeId: string; targetNodeId: string; properties: Record<string, JsonValue>; }
export interface TopologyDocument { id: string; name: string; nodes: TopologyNode[]; edges: TopologyEdge[]; }
export type TopologyScadaOperatingState = "unknown" | "offline" | "idle" | "running" | "warning" | "alarm";
export type TopologyScadaAlarmSeverity = "info" | "warning" | "critical";
export type TopologyScadaDataQuality = "good" | "uncertain" | "bad";
export interface TopologyScadaAlarmState {
  /** Stable adapter-side identity used when acknowledging an alarm. */
  id?: string;
  active: boolean;
  severity: TopologyScadaAlarmSeverity;
  message: string;
  acknowledged?: boolean;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  occurredAt?: string;
}
/** Ephemeral state supplied by a SCADA/data runtime. It is intentionally separate from the saved topology document. */
export interface TopologyScadaRuntimeState {
  state: TopologyScadaOperatingState;
  value?: JsonValue;
  unit?: string;
  /** Adapter-reported confidence in the current value. Omitted means good for backwards compatibility. */
  quality?: TopologyScadaDataQuality;
  alarm?: TopologyScadaAlarmState;
  /** ISO-8601 source timestamp used to detect stale or invalid telemetry. */
  updatedAt?: string;
}
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

/** Lifecycle hooks exposed by the application behavior-script contract. */
export type ApplicationScriptLifecycle =
  | "onStart"
  | "onUpdate"
  | "onFixedUpdate"
  | "onData"
  | "onEvent"
  | "onStop"
  | "onDispose";

/** Permissions that a sandboxed behavior script may request from its host. */
export type ApplicationScriptPermission =
  | "scene.read"
  | "scene.write"
  | "data.read"
  | "data.write"
  | "ai.invoke"
  | "network.connect"
  | "renderer.extend"
  | "editor.extend";

/** 持久化的脚本挂载目标；旧脚本未声明时按场景级行为处理。 */
export type ApplicationScriptTarget =
  | { kind: "scene" }
  | { kind: "object" | "component"; id: string };

/**
 * 已安装到项目中的脚本依赖。运行时只读取项目内缓存，不直接执行来源地址，
 * 因而 Web 发布和离线客户端使用的是同一份经过哈希锁定的代码。
 */
export interface ApplicationScriptDependency {
  id: string;
  /** JavaScript `import` 使用的模块名，例如 `dayjs`。 */
  specifier: string;
  source: "npm" | "upload" | "external-url";
  requested: string;
  resolvedVersion?: string;
  fileName: string;
  assetUrl: string;
  integrity: string;
  size: number;
  license?: string;
  installedAt: string;
}

export interface ScriptModule {
  id: string;
  name: string;
  enabled: boolean;
  apiVersion: "1.0";
  entrypoint: "behavior";
  /** Legacy trusted modules are migration records and must never be loaded into the worker sandbox implicitly. */
  runtime: "worker-sandbox" | "legacy-trusted-main-thread";
  code: string;
  lifecycle: ApplicationScriptLifecycle[];
  capabilities: string[];
  permissions: ApplicationScriptPermission[];
  target?: ApplicationScriptTarget;
}
export interface AssetEntry { id: string; kind: "model" | "image" | "video" | "environment"; projectId: string; sourceName?: string; sourceFormat?: ModelFormat; contentHash?: string; }
export interface TimelineDocument { id: string; name: string; duration: number; trackIds: string[]; }
export interface PublicationProfile { id: string; name: string; target: "browser-preview" | "server-web"; entryPageId: string; renderer: "webgl2" | "auto"; }

/** A business-space level shared by the 2D dashboard and 3D scene editors. */
export type SpatialNodeLoadPolicy = "focus" | "replace" | "additive";

export interface SpatialNavigationNode {
  id: string;
  name: string;
  /** Project-defined semantic type, for example campus, floor, ward, gallery or subsystem. */
  kind: string;
  parentId?: string;
  /** 3D content shown at this level. A node may inherit its parent's scene. */
  sceneId?: string;
  /** 2D page opened without losing the current spatial context. */
  dashboardPageId?: string;
  /** Equipment and other leaf nodes normally focus an object instead of loading another scene. */
  target?: { modelId: string; layerId?: string };
  entryCameraViewId?: string;
  loadPolicy: SpatialNodeLoadPolicy;
}

export interface SpatialNavigationDocument {
  rootNodeIds: string[];
  nodes: SpatialNavigationNode[];
  /** Number of inactive scene levels the host may retain for fast back navigation. */
  cacheLimit: number;
}

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
  /** 可选字段保证旧应用无迁移成本；首次安装脚本依赖时创建。 */
  scriptDependencies?: ApplicationScriptDependency[];
  assets: AssetEntry[];
  timelines: TimelineDocument[];
  publicationProfiles: PublicationProfile[];
  /** Optional while the authoring UI is being rolled out; new hierarchical applications should provide it. */
  spatialNavigation?: SpatialNavigationDocument;
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
