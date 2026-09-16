import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { validateDeepAssetPackage } from "../../deep-engine/dist/assetPackageValidation.js";
const fixture = new URL("../tests/fixtures/asset-directory-v1/", import.meta.url);
const input = JSON.parse(await readFile(new URL("manifest.json", fixture), "utf8"));
const result = validateDeepAssetPackage(input);
assert.equal(result.valid, true, JSON.stringify(result.issues));
assert.deepEqual(result.resourceOrder, ["metadata/license-text", "metadata/license", "scene/main"]);
for (const blob of input.blobs) {
  const bytes = await readFile(new URL(`blobs/${blob.hash}`, fixture));
  assert.equal(bytes.length, blob.byteLength);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), blob.hash);
}
for (const mutate of [
  value => value.manifest.resources[0].dependencies.push("scene/main"),
  value => value.blobs[0].hash = "A".repeat(64),
  value => value.manifest.source.logicalName = "../outside.json",
  value => value.manifest.resources[2].logicalPath = value.manifest.resources[0].logicalPath,
]) {
  const bad = structuredClone(input); mutate(bad);
  assert.equal(validateDeepAssetPackage(bad).valid, false);
}
console.log("TS Asset Package golden: same manifest, all chunks, DAG order, 4 invalid variants passed");
