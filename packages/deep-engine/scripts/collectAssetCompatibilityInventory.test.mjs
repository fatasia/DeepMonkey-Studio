import assert from "node:assert/strict";
import test from "node:test";
import { collectAssetCompatibilityInventory, extractStringArray } from "./collectAssetCompatibilityInventory.mjs";

test("extracts a const string array without treating comments as formats", () => {
  const source = 'export const supportedExtensions = ["glb", /* "fake" */ "gltf"] as const;';
  assert.deepEqual(extractStringArray(source, "supportedExtensions"), ["glb", "gltf"]);
});

test("locks the real 25-format input inventory and Unity Web Build boundary", async () => {
  const inventory = await collectAssetCompatibilityInventory();
  assert.equal(inventory.supportedExtensionCount, 25);
  assert.deepEqual(inventory.supportedExtensions, [
    "rvt", "ifc", "step", "stp", "iges", "igs", "dwg", "dxf", "gltf", "glb", "fbx", "obj", "stl",
    "3mf", "dae", "3ds", "x_t", "x_b", "jt", "usd", "usda", "usdc", "usdz", "urdf", "zip",
  ]);
  assert.equal(inventory.catalogCoverage.every((item) => item.capabilityId), true);
  assert.equal(inventory.routeEvidence.every((item) => item.conversionProviderDeclared), true);
  assert.match(inventory.unityEvidence.displayName, /WebGL/);
  assert.equal(inventory.unityEvidence.acceptsWebBuildZip, true);
  assert.equal(inventory.unityEvidence.requiresWebBuildRuntimeFiles, true);
  assert.equal(inventory.unityEvidence.rendersInIframe, true);
  assert.equal(inventory.unityEvidence.acceptsUnityPackage, false);
  assert.equal(inventory.unityEvidence.acceptsAssetBundle, false);
});
