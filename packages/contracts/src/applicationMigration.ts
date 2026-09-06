import type { ApplicationDocument, ApplicationObjectRef, DashboardDataWidgetNode, DashboardPageDocument, InteractionFlow, SceneDocument } from "./application.js";
import type { SceneDashboardState, SceneDashboardWidgetState, SceneInteractionTarget, SceneSnapshot } from "./index.js";
import { getSceneModelAssetId } from "./sceneModelAsset.js";

const PAGE_WIDTH = 1920 as const;
const PAGE_HEIGHT = 1080 as const;
const DASHBOARD_ROW_HEIGHT = 90;
const DASHBOARD_MARGIN = 6;

export function migrateSceneSnapshotV1(snapshot: SceneSnapshot): ApplicationDocument {
  const source = structuredClone(snapshot);
  const { schemaVersion: _schemaVersion, projectId, dashboard, interactions, publishedAt, publicationMode: _publicationMode, publicationPerformance: _publicationPerformance, publicationToolbarVisible: _publicationToolbarVisible, createdAt, updatedAt, ...sceneFields } = source;
  const scene = sceneFields as SceneDocument;
  const pageId = `page:${source.id}`;
  const page: DashboardPageDocument = {
    id: pageId,
    name: `${source.name} 看板`,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    viewportFit: "contain",
    ...(dashboard ? { appearance: dashboardAppearance(dashboard) } : {}),
    nodes: [{
      id: `widget:scene:${source.id}`,
      kind: "scene-viewport",
      frame: { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT },
      zIndex: 0,
      sceneId: source.id,
      ...(source.defaultCameraViewId ? { cameraViewId: source.defaultCameraViewId } : {}),
      renderMode: "realtime",
      interactionPolicy: "full-navigation",
      overlaySlot: "page"
    }]
  };
  if (dashboard) {
    page.nodes.push(...dashboardWidgetsToNodes(dashboard));
  }
  const migratedInteractions: InteractionFlow[] = (interactions ?? []).map((script) => ({
    id: script.id,
    name: script.name,
    source: interactionTargetToRef(source.id, script.target),
    trigger: script.trigger,
    enabled: script.enabled,
    actions: structuredClone(script.actions ?? []),
    legacyScript: { runtime: "legacy-trusted-main-thread", script: structuredClone(script) }
  }));
  const modelAssets = new Map(source.models.map((model) => [getSceneModelAssetId(model), model]));
  return {
    schemaVersion: 2,
    metadata: {
      id: source.id,
      projectId,
      name: source.name,
      revision: 1,
      createdAt,
      updatedAt,
      source: {
        kind: "scene-snapshot-v1",
        sceneId: source.id,
        hadInteractions: interactions !== undefined,
        ...(publishedAt ? { publishedAt } : {})
      }
    },
    pages: [page],
    topologies: [],
    scenes: [scene],
    geo: { providerIds: [], layers: [] },
    data: { connectionIds: [], datasetIds: [], transforms: [], variables: [] },
    interactions: migratedInteractions,
    scripts: migratedInteractions.map((flow) => ({
      id: `script:${flow.id}`,
      name: flow.name,
      enabled: flow.enabled,
      apiVersion: "1.0",
      entrypoint: "behavior",
      runtime: "legacy-trusted-main-thread",
      code: flow.legacyScript?.script.code ?? "",
      lifecycle: [],
      capabilities: ["legacy.viewer", "legacy.three", "legacy.browser"],
      permissions: []
    })),
    assets: [...modelAssets.values()].map((model) => ({
      id: getSceneModelAssetId(model),
      kind: "model",
      projectId,
      ...(model.sourceName ? { sourceName: model.sourceName } : {}),
      ...(model.sourceFormat ? { sourceFormat: model.sourceFormat } : {})
    })),
    timelines: [],
    publicationProfiles: [
      { id: "browser-preview", name: "浏览器预览", target: "browser-preview", entryPageId: pageId, renderer: "webgl2" },
      { id: "server-web", name: "服务器 Web", target: "server-web", entryPageId: pageId, renderer: "webgl2" }
    ]
  };
}

export function applicationToSceneSnapshotV1(application: ApplicationDocument, sceneId = application.metadata.source?.sceneId ?? application.scenes[0]?.id): SceneSnapshot {
  if (!sceneId) throw new Error("应用没有可导出的三维场景");
  const scene = application.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new Error(`应用中不存在场景 ${sceneId}`);
  const page = application.pages.find((item) => item.nodes.some((node) => node.kind === "scene-viewport" && node.sceneId === sceneId));
  const dashboard = page ? pageToSceneDashboard(page) : undefined;
  const legacyInteractions = application.interactions
    .filter((flow) => flow.legacyScript?.script)
    .map((flow) => structuredClone(flow.legacyScript!.script));
  return {
    schemaVersion: 1,
    ...structuredClone(scene),
    projectId: application.metadata.projectId,
    ...(dashboard ? { dashboard: structuredClone(dashboard) } : {}),
    ...(application.metadata.source?.hadInteractions ? { interactions: legacyInteractions } : {}),
    ...(application.metadata.source?.publishedAt ? { publishedAt: application.metadata.source.publishedAt } : {}),
    createdAt: application.metadata.createdAt,
    updatedAt: application.metadata.updatedAt
  };
}

function dashboardWidgetsToNodes(dashboard: SceneDashboardState): DashboardDataWidgetNode[] {
  const panelX = dashboard.side === "left" ? 0 : PAGE_WIDTH - dashboard.width;
  const columnWidth = dashboard.width / 2;
  return dashboard.widgets.map((widget, index) => {
    const { id, x, y, w, h, ...config } = widget;
    return {
      id,
      kind: "data-widget",
      frame: {
        x: Math.round(panelX + x * columnWidth + DASHBOARD_MARGIN),
        y: Math.round(y * DASHBOARD_ROW_HEIGHT + DASHBOARD_MARGIN),
        width: Math.max(40, Math.round(w * columnWidth - DASHBOARD_MARGIN * 2)),
        height: Math.max(40, Math.round(h * DASHBOARD_ROW_HEIGHT - DASHBOARD_MARGIN * 2))
      },
      zIndex: index + 1,
      widget: config
    };
  });
}

function pageToSceneDashboard(page: DashboardPageDocument): SceneDashboardState | undefined {
  const nodes = page.nodes.filter((node): node is DashboardDataWidgetNode => node.kind === "data-widget");
  if (nodes.length === 0) return undefined;
  const minimumX = Math.min(...nodes.map((node) => node.frame.x));
  const maximumX = Math.max(...nodes.map((node) => node.frame.x + node.frame.width));
  const side = minimumX < PAGE_WIDTH / 2 ? "left" as const : "right" as const;
  const width = Math.max(320, Math.min(720, Math.round(side === "left" ? maximumX + DASHBOARD_MARGIN : PAGE_WIDTH - minimumX + DASHBOARD_MARGIN)));
  const panelX = side === "left" ? 0 : PAGE_WIDTH - width;
  const columnWidth = width / 2;
  const widgets: SceneDashboardWidgetState[] = nodes.map((node) => ({
    id: node.id,
    ...structuredClone(node.widget),
    x: Math.max(0, Math.min(1, Math.round((node.frame.x - panelX - DASHBOARD_MARGIN) / columnWidth))),
    y: Math.max(0, Math.round((node.frame.y - DASHBOARD_MARGIN) / DASHBOARD_ROW_HEIGHT)),
    w: Math.max(1, Math.round((node.frame.width + DASHBOARD_MARGIN * 2) / columnWidth)),
    h: Math.max(1, Math.round((node.frame.height + DASHBOARD_MARGIN * 2) / DASHBOARD_ROW_HEIGHT))
  }));
  return {
    side,
    width,
    ...structuredClone(page.appearance ?? {}),
    widgets
  };
}

function dashboardAppearance(dashboard: SceneDashboardState): NonNullable<DashboardPageDocument["appearance"]> {
  return {
    ...(dashboard.backgroundColor ? { backgroundColor: dashboard.backgroundColor } : {}),
    ...(dashboard.backgroundOpacity === undefined ? {} : { backgroundOpacity: dashboard.backgroundOpacity }),
    ...(dashboard.blur === undefined ? {} : { blur: dashboard.blur }),
    ...(dashboard.borderRadius === undefined ? {} : { borderRadius: dashboard.borderRadius })
  };
}

function interactionTargetToRef(sceneId: string, target: SceneInteractionTarget): ApplicationObjectRef {
  return target.kind === "widget"
    ? { kind: "widget", id: target.widgetId }
    : { kind: "object", sceneId, modelId: target.modelId, ...(target.layerId ? { layerId: target.layerId } : {}) };
}
