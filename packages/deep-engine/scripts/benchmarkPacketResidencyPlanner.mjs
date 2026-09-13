import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const plannerSource = new URL("src/webgpu/packetResidencyRequestPlanner.ts", root);
const bundled = await build({
  entryPoints: [fileURLToPath(plannerSource)],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "node22",
});
const moduleSource = bundled.outputFiles[0].text;
const { createPacketResidencyRequestPlanner, planPacketResidencyRequests } = await import(
  `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`
);

const demandCount = integerArgument("demands", 100_000);
const batchCount = integerArgument("batches", 512);
const resourceGroups = integerArgument("resource-groups", 32);
const textureCount = integerArgument("textures", 64);
const warmups = integerArgument("warmups", 5);
const samples = integerArgument("samples", 21);
const fixture = createFixture(batchCount, resourceGroups, textureCount, demandCount);
const validationOptions = { textureMipLevels: fixture.textureMipLevels };
const compiledPlanner = createPacketResidencyRequestPlanner(fixture.packet);
const forwardRequests = planPacketResidencyRequests(fixture.packet, fixture.demands, validationOptions);
const reverseRequests = planPacketResidencyRequests(fixture.packet, fixture.reversedDemands, validationOptions);
const requestJson = JSON.stringify(forwardRequests);
if (requestJson !== JSON.stringify(reverseRequests)) throw new Error("Demand order changed the request plan.");
if (requestJson !== JSON.stringify(compiledPlanner.plan(fixture.demands, validationOptions))
  || requestJson !== JSON.stringify(compiledPlanner.plan(fixture.reversedDemands, validationOptions))) {
  throw new Error("Compiled and one-shot request plans differ.");
}
const requestSha256 = createHash("sha256").update(requestJson).digest("hex");

let checksum = 0;
const timings = { oneShot: [], compiled: [] };
for (let round = 0; round < warmups + samples; round++) {
  const demands = round % 2 === 0 ? fixture.demands : fixture.reversedDemands;
  const operations = round % 2 === 0 ? ["oneShot", "compiled"] : ["compiled", "oneShot"];
  for (const operation of operations) {
    const start = performance.now();
    const requests = operation === "oneShot"
      ? planPacketResidencyRequests(fixture.packet, demands, validationOptions)
      : compiledPlanner.plan(demands, validationOptions);
    const elapsed = performance.now() - start;
    checksum += requests.length + requests.reduce((sum, request) => sum + request.priority, 0);
    if (round >= warmups) timings[operation].push(elapsed);
  }
}
if (!Number.isFinite(checksum) || timings.oneShot.length !== samples
  || timings.compiled.length !== samples) throw new Error("Invalid benchmark result.");

const report = {
  schema: 2,
  timestamp: new Date().toISOString(),
  scope: "Node CPU packet residency request planning only; no GPU, frame, renderer, or competitor comparison",
  runtime: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  sourceSha256: createHash("sha256").update(moduleSource).digest("hex"),
  method: { warmups, samples, alternatingDemandOrder: true, alternatingOperationOrder: true,
    compiledIndexCreatedOutsideTimedSamples: true },
  input: { demandCount, batchCount, instancesPerBatch: 16, resourceGroups, textureCount,
    lodLevels: 3, sharedGeometryAndTextures: true },
  output: { requestCount: forwardRequests.length, requestSha256 },
  timing: { oneShot: summarize(timings.oneShot), compiled: summarize(timings.compiled) },
  checksum,
};
const output = new URL("../../test-output/deep-engine/", root);
await mkdir(output, { recursive: true });
const evidence = new URL(`packet-residency-planner-${Date.now()}.json`, output);
await writeFile(evidence, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, timing: {
  oneShot: { ...report.timing.oneShot, samplesMs: undefined },
  compiled: { ...report.timing.compiled, samplesMs: undefined },
},
  evidence: fileURLToPath(evidence) }));

function createFixture(batches, groups, textures, demands) {
  if (batches < groups || textures < 1 || groups < 1) throw new Error("Fixture dimensions are invalid.");
  const geometries = new Map();
  for (let group = 0; group < groups; group++) {
    for (const name of ["fine", "middle", "coarse"]) {
      const id = `${name}-${group}`;
      geometries.set(id, { id, revision: 1, vertices: new Float32Array(18), indices: new Uint32Array([0, 1, 2]) });
    }
  }
  const textureSources = Array.from({ length: textures }, (_, index) => ({
    id: `texture-${index}`,
    revision: 1,
    semantic: "baseColor",
    format: "rgba8unorm-srgb",
    levels: [4, 2, 1].map(size => ({ width: size, height: size, bytesPerRow: size * 4,
      byteLength: size * size * 4, data: new Uint8Array(size * size * 4) })),
    sampler: { addressModeU: "repeat", addressModeV: "repeat", magFilter: "linear",
      minFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 1 },
    samplerKey: "repeat|repeat|linear|linear|linear|1",
    byteLength: 84,
  }));
  const packetBatches = Array.from({ length: batches }, (_, index) => {
    const group = index % groups;
    const instanceIds = Array.from({ length: 16 }, (__, instance) => `instance-${index}-${instance}`);
    return { key: `batch-${index}`, geometry: `fine-${group}`, instanceIds, count: instanceIds.length,
      mirrored: false, doubleSided: false, alphaMode: "OPAQUE", data: new Float32Array(instanceIds.length * 36),
      textures: { emissiveStrength: 1, baseColor: { texture: `texture-${index % textures}`, texCoord: 0,
        uvTransform: [1, 0, 0, 0, 1, 0] } },
      lod: { hysteresisRatio: 0.1, levels: [
        { geometry: `fine-${group}`, minProjectedDiameterPixels: 100, geometricError: 0, triangles: 3, resident: true },
        { geometry: `middle-${group}`, minProjectedDiameterPixels: 20, geometricError: 1, triangles: 2, resident: true },
        { geometry: `coarse-${group}`, minProjectedDiameterPixels: 0, geometricError: 2, triangles: 1, resident: true },
      ] } };
  });
  const requestDemands = Array.from({ length: demands }, (_, index) => {
    const batch = index % batches;
    return { batchKey: `batch-${batch}`, instanceId: `instance-${batch}-${index % 16}`,
      desiredLod: index % 3, priority: index % 101 - 50 };
  });
  return { packet: { geometries, textures: textureSources, batches: packetBatches },
    demands: requestDemands, reversedDemands: [...requestDemands].reverse(),
    textureMipLevels: new Map(textureSources.map(texture => [texture.id, 1])) };
}

function integerArgument(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid --${name} value.`);
  return value;
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = fraction => sorted[Math.ceil(sorted.length * fraction) - 1];
  return { p50Ms: percentile(0.5), p95Ms: percentile(0.95), minMs: sorted[0], maxMs: sorted.at(-1), samplesMs: values };
}
