// Reproducible first-party directory fixture, not a raw GLB importer.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "tests/fixtures/asset-directory-v1");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const runtime = await readFile(resolve(root, "tests/fixtures/runtime-package-v1.json"));
const license = await readFile(resolve(root, "../../LICENSE"));
const sourceHash = sha(runtime), licenseHash = sha(license);
const packageId = "deep.asset.native-fixture";
const proof = Buffer.from(JSON.stringify({ schemaVersion: 1, packageId, sourceHash,
  resourceIds: ["scene/main"], licenseId: "LicenseRef-Deep-Monkey-Community-1.0", licenseTextHash: licenseHash }));
const payloads = [
  { bytes: runtime, mediaType: "application/vnd.deep.runtime-package+json" },
  { bytes: license, mediaType: "text/plain" },
  { bytes: proof, mediaType: "application/vnd.deep.asset-license+json" },
];
const facets = ["geometry", "hierarchy", "materials", "textures", "animation", "skin", "morph", "cameras", "lights", "colliders", "navmesh", "metadata", "pmi", "behavior", "audio"];
const manifest = { schemaVersion: 1,
  blobs: payloads.map(({bytes, mediaType}) => ({ hash: sha(bytes), byteLength: bytes.length, mediaType })).sort((a,b) => a.hash < b.hash ? -1 : 1),
  manifest: { schemaVersion: 1, packageId,
    source: { kind: "model-file", logicalName: "fixtures/runtime-package-v1.json", contentHash: sourceHash, byteLength: runtime.length },
    importer: { kind: "direct-parser", id: "deep.runtime-directory-fixture", version: "1.0.0", recipeHash: sha(await readFile(fileURLToPath(import.meta.url))), deterministic: true },
    compatibility: { schemaVersion: 1, id: "native-directory-v1", sourceKind: "model-file", format: "json", importer: "direct-parser", runtimeArtifact: "deep-asset-package", importerVersion: "1.0.0", fixtureSetHash: sourceHash, deterministic: true,
      facets: Object.fromEntries(facets.map(name => [name, { status: ["geometry", "hierarchy", "materials", "metadata"].includes(name) ? "verified" : "unverified", evidenceIds: ["fixture:runtime-package-v1"], reason: null }])) },
    resources: [
      { id: "metadata/license", kind: "metadata", logicalPath: "metadata/license.json", blobHash: sha(proof), dependencies: ["metadata/license-text"] },
      { id: "metadata/license-text", kind: "metadata", logicalPath: "metadata/LICENSE", blobHash: licenseHash, dependencies: [] },
      { id: "scene/main", kind: "scene", logicalPath: "scenes/main.runtime.json", blobHash: sourceHash, dependencies: ["metadata/license"] },
    ], entryScene: "scene/main" } };
await mkdir(resolve(output, "blobs"), { recursive: true });
for (const item of payloads) await writeFile(resolve(output, "blobs", sha(item.bytes)), item.bytes);
await writeFile(resolve(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`asset directory fixture: ${output}, 3 verified byte chunks`);
