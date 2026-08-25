import {
  migrateSceneSnapshotV1,
  type ApplicationDocument,
  type AssetEntry,
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
  const sceneDraft = migrateSceneSnapshotV1(snapshot);
  const synced = structuredClone(application);
  const sceneDocument = sceneDraft.scenes[0]!;
  const sceneIndex = synced.scenes.findIndex((candidate) => candidate.id === snapshot.id);
  if (sceneIndex >= 0) synced.scenes[sceneIndex] = sceneDocument;
  else synced.scenes.push(sceneDocument);

  const dashboardState = sceneDraft.pages[0]?.nodes.find((node) => node.kind === "legacy-dashboard-panel");
  if (dashboardState?.kind === "legacy-dashboard-panel") {
    for (const page of synced.pages) {
      if (!page.nodes.some((node) => node.kind === "scene-viewport" && node.sceneId === snapshot.id)) continue;
      for (const node of page.nodes) {
        if (node.kind === "legacy-dashboard-panel") node.state = structuredClone(dashboardState.state);
      }
    }
  }

  const sceneFlowIds = new Set(sceneDraft.interactions.map((flow) => flow.id));
  synced.interactions = [
    ...synced.interactions.filter((flow) => !sceneFlowIds.has(flow.id)),
    ...structuredClone(sceneDraft.interactions)
  ];
  const sceneScriptIds = new Set(sceneDraft.scripts.map((script) => script.id));
  synced.scripts = [
    ...synced.scripts.filter((script) => !sceneScriptIds.has(script.id)),
    ...structuredClone(sceneDraft.scripts)
  ];
  synced.assets = mergeAssets(synced.assets, sceneDraft.assets);
  return synced;
}

function mergeAssets(current: readonly AssetEntry[], replacements: readonly AssetEntry[]): AssetEntry[] {
  const replacementIds = new Set(replacements.map((asset) => asset.id));
  return [
    ...current.filter((asset) => !replacementIds.has(asset.id)),
    ...structuredClone(replacements)
  ];
}
