import { describe, expect, it } from "vitest";
import { validateSceneSnapshotTransforms } from "./sceneTransformProjection";

describe("scene snapshot transform projection", () => {
  it("accepts ApplicationDocument migrated scene transforms through Deep graph validation", () => {
    expect(() => validateSceneSnapshotTransforms({ models: [{ modelId: "m", transform: {
      position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    } }] })).not.toThrow();
  });

  it("rejects non-finite author transforms before persistence", () => {
    expect(() => validateSceneSnapshotTransforms({ models: [{ modelId: "m", transform: {
      position: { x: Number.NaN, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    } }] })).toThrow();
  });
});
