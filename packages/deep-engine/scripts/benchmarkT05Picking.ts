import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createBenchmarkScene } from "../lab/benchmarkScene.js";
import { packInstanceBatches } from "../src/renderPacketBatches.js";
import { pickScene } from "../src/webgpu/picking.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "../src/webgpu/packetBufferTypes.js";

const fixture = createBenchmarkScene(10_000);
const packet = fixture.packet;
const broadPhase = process.env.T05_PICK_BROADPHASE !== "0";
const sources = packInstanceBatches(new Set(packet.geometries.map(geometry => geometry.id)),
  packet.instances, new Map(packet.materials.map(material => [material.id, material])), new Map());
const batches = new Map(sources.map(source => [source.key, {
  source, buffer: {} as GPUBuffer, capacity: 0, previousBuffer: {} as GPUBuffer,
  previousCapacity: 0, previousTransforms: new Float32Array(0),
} satisfies CachedPacketBatch]));
const geometries = new Map(packet.geometries.map(source => [source.id, {
  source, mesh: {} as CachedPacketGeometry["mesh"], center: [0, 0, 0], radius: broadPhase ? 1 : 1e9,
} satisfies CachedPacketGeometry]));
const target = packet.instances[5_050]!;
const origin = [target.transform[12]!, target.transform[13]!, target.transform[14]! + 500];
const direction = [0, 0, -1];
const scene = { batches, geometries, objectBindings: [{ nodeId: "benchmark-grid", instanceIds: packet.instances.map(i => i.id) }] };
const samples: number[] = [];
let hitIds: string[] = [];
let degraded: readonly string[] = [];
for (let i = 0; i < 15; i++) {
  const start = performance.now();
  const result = pickScene(scene, origin, direction, { maxHits: 1 });
  const elapsed = performance.now() - start;
  if (!result.available || result.hits.length === 0) throw new Error("10k ray missed the grid fixture.");
  if (result.hits[0]!.nodeId !== "benchmark-grid") throw new Error("10k ray lost author identity.");
  hitIds = result.hits.map(hit => hit.instanceId);
  degraded = result.degraded ?? [];
  if (i >= 5) samples.push(elapsed);
}
const sorted = [...samples].sort((a, b) => a - b);
const report = { schema: "t05-picking-10k-v1", fixture: fixture.id,
  instanceCount: packet.instances.length, triangleCountPerInstance: packet.geometries[0]!.indices.length / 3,
  broadPhase, ray: { origin, direction }, samplesMs: samples, p50Ms: sorted[4], p95Ms: sorted[9],
  hitIds, hitNodeId: "benchmark-grid", degraded };
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const output = path.resolve(repoRoot, process.env.T05_PICK_OUTPUT ?? "test-output/deep-core/T05/picking-10k.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, p50Ms: report.p50Ms, p95Ms: report.p95Ms, hitIds }));
