/** Local-only derivatives of frozen A02 sources. Nothing is copied into distributable Lab assets. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");
const { dequantize, getBounds } = require("@gltf-transform/functions");
const draco = require("draco3dgltf");
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.decoder": await draco.createDecoderModule() });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const manifest = JSON.parse(await readFile(path.join(root, "packages/deep-engine/fixtures/benchmark-assets/manifests-v1.json"), "utf8"));
const output = path.resolve(root, process.argv[2] ?? "test-output/de26-local-assets-20260918");
await mkdir(output, { recursive: true });
const entries = [];
const unavailable = [];
for (const [id, name] of [["asset.bim.baked-scene", "LocalBim"], ["asset.factory.preheater-far-origin", "LocalPreheater"]]) {
  const asset = manifest.manifests.find((item: any) => item.id === id);
  if (!asset) {
    unavailable.push({ id, reason: "local source asset was withdrawn; replace it with an approved benchmark asset" });
    continue;
  }
  const source = new Uint8Array(await readFile(asset.source.path));
  if (hash(source) !== asset.source.sha256 || source.byteLength !== asset.source.bytes) throw new Error(`Frozen source changed: ${id}`);
  const document = await io.readBinary(source);
  await document.transform(dequantize());
  for (const extension of document.getRoot().listExtensionsUsed()) {
    if (extension.extensionName === "KHR_draco_mesh_compression") extension.dispose();
  }
  const result = await io.writeBinary(document);
  const focusNode = name === "LocalPreheater" ? document.getRoot().listNodes().find((node: any) => node.getName() === "group2") : document.getRoot().listScenes()[0];
  if (!focusNode) throw new Error(`Frozen camera target missing: ${name}`);
  const bounds = getBounds(focusNode);
  const center = bounds.min.map((value: number, axis: number) => (value + bounds.max[axis]) / 2);
  const radius = Math.hypot(...bounds.max.map((value: number, axis: number) => (value - bounds.min[axis]) / 2));
  const cameraFrame = { center, radius, focus: name === "LocalPreheater" ? "authored group2 equipment assembly" : "complete default scene",
    contentPolicy: "all source instances retained; camera framing only" };
  await writeFile(path.join(output, `${name}.glb`), result);
  entries.push({ id, name, sourceSha256: asset.source.sha256, sha256: hash(result), bytes: result.byteLength, cameraFrame,
    preparation: "gltf-transform@4.4.2 dequantize; draco3dgltf@1.5.7 decode; source transforms/materials preserved",
    license: asset.license });
}
await writeFile(path.join(output, "sources.json"), JSON.stringify({ schema: 1, assets: entries, unavailable }, null, 2));
console.log(JSON.stringify({ output, assets: entries, unavailable }, null, 2));
