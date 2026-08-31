import { describe, expect, it } from "vitest";
import { proposeSmartAssetBindings, type SmartBindingCatalogItem, type SmartBindingSceneObject } from "./smartAssetBinding.js";

describe("smart asset binding", () => {
  it("lets an exact stable identifier override misleading name and position", () => {
    const result = proposeSmartAssetBindings([
      {
        id: "mesh-1",
        name: "Compressor C-09",
        properties: { deviceId: "P-101" },
        position: { x: 100, y: 100 },
      },
    ], [
      { deviceId: "P-101", name: "Feed Pump P-101", position: { x: 0, y: 0 } },
      { deviceId: "C-09", name: "Compressor C-09", position: { x: 100, y: 100 } },
    ]);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      sceneObjectId: "mesh-1",
      deviceId: "P-101",
      confidence: 0.99,
      recommendation: "strong-candidate",
      requiresHumanConfirmation: true,
    });
    expect(result.candidates[0]?.evidence.find((factor) => factor.factor === "stable-identifier")).toMatchObject({
      score: 1,
      explanation: "稳定标识精确一致",
    });
  });

  it("resolves identical-name contention in stable object-id order", () => {
    const scenes: SmartBindingSceneObject[] = [
      { id: "scene-b", name: "Cooling Pump" },
      { id: "scene-a", name: "Cooling Pump" },
    ];
    const catalog: SmartBindingCatalogItem[] = [{ deviceId: "pump-1", name: "Cooling Pump" }];
    const first = proposeSmartAssetBindings(scenes, catalog);
    const second = proposeSmartAssetBindings([...scenes].reverse(), catalog);

    expect(first).toEqual(second);
    expect(first.evidenceFingerprint).toMatch(/^fnv1a64-canonical-v1:[a-f0-9]{16}$/);
    expect(first.candidates).toEqual([expect.objectContaining({ sceneObjectId: "scene-a", deviceId: "pump-1" })]);
    expect(first.conflicts).toContainEqual(expect.objectContaining({
      type: "device-contended",
      sceneObjectIds: ["scene-a", "scene-b"],
      resolvedSceneObjectId: "scene-a",
      resolvedDeviceId: "pump-1",
    }));
    expect(first.unmatchedSceneObjects).toEqual([{
      sceneObjectId: "scene-b",
      bestConfidence: expect.any(Number),
      reason: "lost-one-to-one-conflict",
    }]);
  });

  it("changes the evidence fingerprint when source evidence changes", () => {
    const scenes = [{ id: "scene-1", name: "Pump", properties: { deviceId: "pump-1" } }];
    const first = proposeSmartAssetBindings(scenes, [{ deviceId: "pump-1", name: "Pump" }]);
    const changed = proposeSmartAssetBindings(scenes, [{ deviceId: "pump-1", name: "Pump A" }]);

    expect(changed.evidenceFingerprint).not.toBe(first.evidenceFingerprint);
  });

  it("keeps unrelated low-confidence records unmatched", () => {
    const result = proposeSmartAssetBindings(
      [{ id: "boiler-mesh", name: "Boiler A", category: "boiler" }],
      [{ deviceId: "weather-1", name: "Outdoor Weather Station", category: "weather" }],
    );

    expect(result.candidates).toEqual([]);
    expect(result.unmatchedSceneObjects).toEqual([expect.objectContaining({
      sceneObjectId: "boiler-mesh",
      reason: "no-candidate",
    })]);
    expect(result.unmatchedDeviceIds).toEqual(["weather-1"]);
    expect(result.requiresHumanConfirmation).toBe(true);
  });

  it("uses position to separate otherwise identical devices", () => {
    const result = proposeSmartAssetBindings([
      { id: "pump-left", name: "Transfer Pump", category: "pump", position: { x: 1, y: 0 } },
      { id: "pump-right", name: "Transfer Pump", category: "pump", position: { x: 99, y: 0 } },
    ], [
      { deviceId: "device-right", name: "Transfer Pump", category: "pump", position: { x: 100, y: 0 } },
      { deviceId: "device-left", name: "Transfer Pump", category: "pump", position: { x: 0, y: 0 } },
    ], { distanceScale: 100 });

    expect(result.candidates.map(({ sceneObjectId, deviceId }) => ({ sceneObjectId, deviceId }))).toEqual([
      { sceneObjectId: "pump-left", deviceId: "device-left" },
      { sceneObjectId: "pump-right", deviceId: "device-right" },
    ]);
    const left = result.candidates.find((candidate) => candidate.sceneObjectId === "pump-left")!;
    expect(left.evidence.find((factor) => factor.factor === "distance")).toMatchObject({
      available: true,
      score: 0.99,
    });
  });

  it("rejects duplicate catalog identifiers instead of producing unstable mappings", () => {
    expect(() => proposeSmartAssetBindings(
      [{ id: "scene-1", name: "Pump" }],
      [{ deviceId: "device-1", name: "Pump" }, { deviceId: "device-1", name: "Pump backup" }],
    )).toThrow("设备 ID 必须唯一");
  });
});
