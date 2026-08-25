import {
  type ApplicationDocument,
  type ApplicationObjectRef,
  type AssetEntry,
  type InteractionFlow,
  type SceneDocument,
  type SceneInteractionTarget,
  type SceneSnapshot
} from "@bim-studio/contracts";

export function applicationForScene(
  applications: readonly ApplicationDocument[],
  sceneId: string
): ApplicationDocument | undefined {
  return applications.find((application) => application.scenes.some((scene) => scene.id === sceneId))
    ?? applications.find((application) => application.metadata.id === sceneId);
}

export function syncSceneIntoApplication(
  application: ApplicationDocument,
  snapshot: SceneSnapshot
): ApplicationDocument {
  const synced = structuredClone(application);
  const sceneDocument = sceneDocumentFromSnapshot(snapshot);
  const sceneIndex = synced.scenes.findIndex((candidate) => candidate.id === snapshot.id);
  if (sceneIndex >= 0) synced.scenes[sceneIndex] = sceneDocument;
  else synced.scenes.push(sceneDocument);

  const sceneFlows = (snapshot.interactions ?? [])
    .filter((script) => script.target.kind === "object")
    .map((script): InteractionFlow => ({
      id: script.id,
      name: script.name,
      source: interactionTargetToRef(snapshot.id, script.target),
      trigger: script.trigger,
      enabled: script.enabled,
      actions: structuredClone(script.actions ?? []),
      legacyScript: { runtime: "legacy-trusted-main-thread", script: structuredClone(script) }
    }));
  const previousSceneFlowIds = new Set(synced.interactions
    .filter((flow) => flow.source.kind === "object" && flow.source.sceneId === snapshot.id)
    .map((flow) => flow.id));
  synced.interactions = [
    ...synced.interactions.filter((flow) => !previousSceneFlowIds.has(flow.id)),
    ...sceneFlows
  ];
  const previousSceneScriptIds = new Set([...previousSceneFlowIds].map((id) => `script:${id}`));
  synced.scripts = [
    ...synced.scripts.filter((script) => !previousSceneScriptIds.has(script.id)),
    ...sceneFlows.map((flow) => ({
      id: `script:${flow.id}`,
      name: flow.name,
      apiVersion: "1.0" as const,
      entrypoint: "behavior" as const,
      runtime: "legacy-trusted-main-thread" as const,
      code: flow.legacyScript?.script.code ?? "",
      capabilities: ["legacy.viewer", "legacy.three", "legacy.browser"]
    }))
  ];
  synced.assets = mergeAssets(synced.assets, snapshot.models.map((model) => ({
    id: model.modelId,
    kind: "model" as const,
    projectId: snapshot.projectId,
    ...(model.sourceName ? { sourceName: model.sourceName } : {}),
    ...(model.sourceFormat ? { sourceFormat: model.sourceFormat } : {})
  })));
  return synced;
}

function sceneDocumentFromSnapshot(snapshot: SceneSnapshot): SceneDocument {
  const source = structuredClone(snapshot);
  const {
    schemaVersion: _schemaVersion,
    projectId: _projectId,
    dashboard: _dashboard,
    interactions: _interactions,
    publishedAt: _publishedAt,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...scene
  } = source;
  return scene;
}

function interactionTargetToRef(sceneId: string, target: SceneInteractionTarget): ApplicationObjectRef {
  if (target.kind !== "object") throw new Error("三维编辑器只能回写三维对象交互");
  return {
    kind: "object",
    sceneId,
    modelId: target.modelId,
    ...(target.layerId ? { layerId: target.layerId } : {})
  };
}

function mergeAssets(current: readonly AssetEntry[], replacements: readonly AssetEntry[]): AssetEntry[] {
  const replacementIds = new Set(replacements.map((asset) => asset.id));
  return [
    ...current.filter((asset) => !replacementIds.has(asset.id)),
    ...structuredClone(replacements)
  ];
}
