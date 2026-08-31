import type {
  SmartAssetBindingResult,
  SmartBindingCandidate,
  SmartBindingCatalogItem,
  SmartBindingConflict,
  SmartBindingSceneObject,
} from "@bim-studio/studio-core";

export interface ConfirmedSmartAssetMapping {
  sceneObjectId: string;
  deviceId: string;
  confidence: number;
}

export interface SmartBindingWorkbenchView {
  strongCandidates: SmartBindingCandidate[];
  reviewCandidates: SmartBindingCandidate[];
  conflicts: SmartBindingConflict[];
  unmatchedSceneObjects: Array<{ sceneObjectId: string; name: string; confidence: number; reason: string }>;
  unmatchedDevices: Array<{ deviceId: string; name: string }>;
  sceneNames: ReadonlyMap<string, string>;
  deviceNames: ReadonlyMap<string, string>;
}

/** 冲突候选即使分数很高也进入待复核组，不允许被“强候选”标签掩盖。 */
export function buildSmartBindingWorkbenchView(
  result: SmartAssetBindingResult,
  scenes: readonly SmartBindingSceneObject[],
  catalog: readonly SmartBindingCatalogItem[],
): SmartBindingWorkbenchView {
  const sceneNames = new Map(scenes.map((scene) => [scene.id, scene.name]));
  const deviceNames = new Map(catalog.map((device) => [device.deviceId, device.name]));
  const conflictedScenes = new Set(result.conflicts.flatMap((conflict) => conflict.sceneObjectIds));
  const conflictedDevices = new Set(result.conflicts.flatMap((conflict) => conflict.deviceIds));
  const isConflicted = (candidate: SmartBindingCandidate) =>
    conflictedScenes.has(candidate.sceneObjectId) || conflictedDevices.has(candidate.deviceId);
  return {
    strongCandidates: result.candidates.filter((candidate) => candidate.recommendation === "strong-candidate" && !isConflicted(candidate)),
    reviewCandidates: result.candidates.filter((candidate) => candidate.recommendation !== "strong-candidate" || isConflicted(candidate)),
    conflicts: result.conflicts,
    unmatchedSceneObjects: result.unmatchedSceneObjects.map((item) => ({
      sceneObjectId: item.sceneObjectId,
      name: sceneNames.get(item.sceneObjectId) ?? item.sceneObjectId,
      confidence: item.bestConfidence,
      reason: item.reason,
    })),
    unmatchedDevices: result.unmatchedDeviceIds.map((deviceId) => ({
      deviceId,
      name: deviceNames.get(deviceId) ?? deviceId,
    })),
    sceneNames,
    deviceNames,
  };
}

export function candidateKey(candidate: Pick<SmartBindingCandidate, "sceneObjectId" | "deviceId">): string {
  return `${candidate.sceneObjectId}\u0000${candidate.deviceId}`;
}

export function confirmedMappings(
  candidates: readonly SmartBindingCandidate[],
  selectedKeys: ReadonlySet<string>,
): ConfirmedSmartAssetMapping[] {
  return candidates
    .filter((candidate) => selectedKeys.has(candidateKey(candidate)))
    .map(({ sceneObjectId, deviceId, confidence }) => ({ sceneObjectId, deviceId, confidence }))
    .sort((left, right) => left.sceneObjectId.localeCompare(right.sceneObjectId, "en") || left.deviceId.localeCompare(right.deviceId, "en"));
}
