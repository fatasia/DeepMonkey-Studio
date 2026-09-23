import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkAssetManifest } from "../packages/deep-engine/src/benchmarkAssetManifest.ts";
import type { BenchmarkTrajectory } from "../packages/deep-engine/src/benchmarkAssetTrajectory.ts";
import { buildBenchmarkReadinessInventory, type ObservedAssetSource } from "../packages/deep-engine/src/benchmarkReadiness.ts";
import { decodeTexturedGlb } from "../packages/deep-engine/src/gltf/decodeTexturedGlb.ts";
import { benchmarkPacketSphere } from "../packages/deep-engine/lab/benchmarkPacketBounds.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = path.resolve(root, process.argv[2] ?? "test-output/de26-local-assets-20260918");
await mkdir(output, { recursive: true });
const manifestFile = path.join(root, "packages/deep-engine/fixtures/benchmark-assets/manifests-v1.json");
const trajectoryFile = path.join(root, "packages/deep-engine/fixtures/benchmark-assets/trajectories-v1.json");
const manifestDocument = JSON.parse(await readFile(manifestFile, "utf8")) as { manifests: BenchmarkAssetManifest[] };
const trajectoryDocument = JSON.parse(await readFile(trajectoryFile, "utf8")) as { trajectories: BenchmarkTrajectory[] };
const observedSources: Record<string, ObservedAssetSource> = {};
const sourceErrors: string[] = [];
for (const manifest of manifestDocument.manifests) {
  const sourcePath = path.isAbsolute(manifest.source.path) ? manifest.source.path : path.resolve(root, manifest.source.path);
  try {
    const bytes = await readFile(sourcePath);
    observedSources[manifest.id] = {
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    sourceErrors.push(`${manifest.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const readiness = buildBenchmarkReadinessInventory({
  manifests: manifestDocument.manifests,
  trajectories: trajectoryDocument.trajectories,
  observedSources,
});
await writeFile(path.join(output, "readiness.json"), `${JSON.stringify(readiness, null, 2)}\n`);

const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const sharp = require("sharp");
const prepared = [];
let localAssets: { name: string }[] = [];
try {
  const localManifest = JSON.parse(await readFile(path.join(output, "sources.json"), "utf8")) as { assets?: { name: string }[] };
  localAssets = Array.isArray(localManifest.assets) ? localManifest.assets : [];
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
for (const { name } of localAssets) {
  const bytes = new Uint8Array(await readFile(path.join(output, `${name}.glb`)));
  const packet = await decodeTexturedGlb(bytes, { async decode(image) {
    const { data, info } = await sharp(image.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data: new Uint8Array(data) };
  } });
  const sphere = benchmarkPacketSphere(packet);
  const sizes = packet.instances.map(instance => {
    const part = { ...packet, instances: [instance] };
    const bounds = benchmarkPacketSphere(part);
    const geometry = packet.geometries.find(value => value.id === instance.geometry)!;
    return { id: instance.id, radius: bounds.radius, center: bounds.center.toArray(), triangles: geometry.indices.length / 3 };
  }).sort((a, b) => b.radius - a.radius);
  const summary = { name, center: sphere.center.toArray(), radius: sphere.radius,
    largest: sizes.slice(0, 6),
    geometries: packet.geometries.length, instances: packet.instances.length,
    triangles: packet.geometries.reduce((total, geometry) => total + geometry.indices.length / 3, 0),
    materials: packet.materials.length, textures: packet.textures.length,
    instance: packet.instances[0], firstVertex: Array.from(packet.geometries[0]!.vertices.subarray(0, 6)) };
  prepared.push(summary);
  console.log(JSON.stringify(summary));
}
await writeFile(path.join(output, "prepared-statistics.json"), JSON.stringify({ schemaVersion: 1, source: "inspect-de26-local-benchmarks.mts", assets: prepared }, null, 2));
console.log(JSON.stringify({ readiness: readiness.status, readinessFile: path.join(output, "readiness.json"), preparedStatisticsFile: path.join(output, "prepared-statistics.json"),
  sourceErrors, preparedAssets: prepared.map((asset) => ({ name: asset.name, geometries: asset.geometries, instances: asset.instances })) }));
