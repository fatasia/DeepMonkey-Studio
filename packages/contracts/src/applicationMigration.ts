import type { ApplicationDocument, ApplicationObjectRef, DashboardPageDocument, InteractionFlow, SceneDocument } from "./application.js";
import type { SceneInteractionTarget, SceneSnapshot } from "./index.js";

const PAGE_WIDTH = 1920 as const;
const PAGE_HEIGHT = 1080 as const;

export function migrateSceneSnapshotV1(snapshot: SceneSnapshot): ApplicationDocument {
  const source = structuredClone(snapshot);
  const { schemaVersion: _schemaVersion, projectId, dashboard, interactions, publishedAt, createdAt, updatedAt, ...sceneFields } = source;
  const scene = sceneFields as SceneDocument;
  const pageId = `page:${source.id}`;
  const page: DashboardPageDocument = {
    id: pageId,
    name: `${source.name} 看板`,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
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
    page.nodes.push({
      id: `widget:legacy-dashboard:${source.id}`,
      kind: "legacy-dashboard-panel",
      frame: {
        x: dashboard.side === "left" ? 0 : PAGE_WIDTH - dashboard.width,
        y: 0,
        width: dashboard.width,
        height: PAGE_HEIGHT
      },
      zIndex: 1,
      state: dashboard
    });
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
  const modelAssets = new Map(source.models.map((model) => [model.modelId, model]));
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
      runtime: "legacy-trusted-main-thread",
      code: flow.legacyScript?.script.code ?? "",
      capabilities: ["legacy.viewer", "legacy.three", "legacy.browser"]
    })),
    assets: [...modelAssets.values()].map((model) => ({
      id: model.modelId,
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
  const dashboard = page?.nodes.find((node) => node.kind === "legacy-dashboard-panel")?.state;
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

function interactionTargetToRef(sceneId: string, target: SceneInteractionTarget): ApplicationObjectRef {
  return target.kind === "widget"
    ? { kind: "widget", id: target.widgetId }
    : { kind: "object", sceneId, modelId: target.modelId, ...(target.layerId ? { layerId: target.layerId } : {}) };
}
