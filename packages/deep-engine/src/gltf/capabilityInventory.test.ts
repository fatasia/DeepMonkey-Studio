import { describe, expect, it } from "vitest";
import { buildCapabilityInventory, summarizeCapabilityInventory, type CapabilityInventory } from "./capabilityInventory";

function inventory(): CapabilityInventory {
  return {
    schema: "deep-engine.capability-inventory",
    schemaVersion: 1,
    assetId: "asset.bim.snowdon-towers-arch",
    path: "bridge",
    objects: [
      { objectId: "node.wall-a", renderable: true, semanticsPreserved: false, failures: [] },
      { objectId: "node.glass-b", renderable: false, semanticsPreserved: true, failures: [
        { code: "extension-unsupported", stage: "extension", assetPath: "materials[2].extensions.KHR_materials_clearcoat",
          detail: "clearcoat is rejected by the bridge; keep transform and name", count: 1 }] },
      { objectId: "node.mesh-c", renderable: false, semanticsPreserved: false, failures: [
        { code: "accessor-out-of-range", stage: "geometry", assetPath: "meshes[4].primitives[0].attributes.POSITION",
          detail: "accessor byteOffset exceeds bufferView", count: 3 },
        { code: "extension-unsupported", stage: "extension", assetPath: "materials[2].extensions.KHR_materials_clearcoat",
          detail: "clearcoat is rejected by the bridge; keep transform and name", count: 1 }] },
    ],
  };
}

describe("capability inventory contract", () => {
  it("builds an inventory and summarizes failure frequency deterministically", () => {
    const summary = summarizeCapabilityInventory(buildCapabilityInventory(inventory()));
    expect(summary).toEqual({ objects: 3, renderable: 1, semanticsOnly: 1, failed: 1,
      failuresByFrequency: [
        { code: "extension-unsupported", stage: "extension", count: 2 },
        { code: "accessor-out-of-range", stage: "geometry", count: 3 },
      ].slice().sort((left, right) => right.count - left.count || (left.code < right.code ? -1 : 1)) });
  });

  it("fails closed on unrenderable objects without a locatable failure and on duplicate objects", () => {
    const silent = inventory();
    (silent.objects[2] as { failures: never[] }).failures = [];
    expect(() => buildCapabilityInventory(silent)).toThrow(/must carry at least one locatable failure/);
    const duplicate = inventory();
    (duplicate.objects as unknown[]).push({ ...duplicate.objects[0] });
    expect(() => buildCapabilityInventory(duplicate)).toThrow(/duplicate capability object/);
  });

  it("keeps renderable and semantics-preserved columns separate and validates failure fields", () => {
    const bad = inventory();
    (bad.objects[1]!.failures[0] as { assetPath: string }).assetPath = " ";
    expect(() => buildCapabilityInventory(bad)).toThrow(/must locate the asset field/);
    const renderableWithDecode = inventory();
    (renderableWithDecode.objects[0] as { failures: unknown[] }).failures = [
      { code: "accessor-out-of-range", stage: "decode", assetPath: "meshes[0]", detail: "x", count: 1 }];
    expect(() => buildCapabilityInventory(renderableWithDecode)).toThrow(/renderable but carries decode failures/);
  });
});
