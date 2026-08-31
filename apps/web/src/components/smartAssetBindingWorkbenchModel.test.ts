import { describe, expect, it } from "vitest";
import { proposeSmartAssetBindings, type SmartBindingCandidate } from "@bim-studio/studio-core";
import { buildSmartBindingWorkbenchView, candidateKey, confirmedMappings } from "./smartAssetBindingWorkbenchModel";

describe("smart asset binding workbench model", () => {
  it("moves a high-confidence contested mapping to manual review", () => {
    const scenes = [
      { id: "P-101", name: "循环泵 101" },
      { id: "scene-2", name: "循环泵 101" },
    ];
    const catalog = [{ deviceId: "P-101", name: "循环泵 101" }];
    const view = buildSmartBindingWorkbenchView(proposeSmartAssetBindings(scenes, catalog), scenes, catalog);

    expect(view.conflicts).toHaveLength(1);
    expect(view.strongCandidates).toHaveLength(0);
    expect(view.reviewCandidates).toHaveLength(1);
  });

  it("returns only explicitly selected fields in stable order", () => {
    const candidates = [candidate("scene-b", "device-b", 0.82), candidate("scene-a", "device-a", 0.99)];
    const selected = new Set([candidateKey(candidates[0]!), candidateKey(candidates[1]!)]);

    expect(confirmedMappings(candidates, selected)).toEqual([
      { sceneObjectId: "scene-a", deviceId: "device-a", confidence: 0.99 },
      { sceneObjectId: "scene-b", deviceId: "device-b", confidence: 0.82 },
    ]);
  });
});

function candidate(sceneObjectId: string, deviceId: string, confidence: number): SmartBindingCandidate {
  return {
    sceneObjectId,
    deviceId,
    confidence,
    recommendation: "strong-candidate",
    requiresHumanConfirmation: true,
    evidence: [],
  };
}
