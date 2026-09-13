import { build } from "esbuild";
import { arch, cpus, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// 仅量测相同不透明网格的 CPU 投影准备，不包含 GPU、作者提取、渲染或竞品。
const built = await build({ entryPoints: [fileURLToPath(new URL("../src/renderPacket.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", target: "es2022", write: false });
const source = built.outputFiles[0].text;
const { prepareRenderPacket, prepareInstanceUpdate } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const summarize = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], samplesMs: values };
};
const warmups = 7, sampleCount = 31;
function benchmark(vertexCount, instanceCount) {
  const vertices = new Float32Array(vertexCount * 6), indices = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const corner = i % 3;
    vertices.set([corner === 1 ? 1 : 0, corner === 2 ? 1 : 0, Math.floor(i / 3) * 0.00001, 0, 0, 1], i * 6);
    indices[i] = i;
  }
  const materials = [{ id: "m", baseColor: [0.5, 0.6, 0.7], metallic: 0.5, roughness: 0.5 }];
  const instances = Array.from({ length: instanceCount }, (_, i) => {
    const angle = i * 0.017, c = Math.cos(angle), s = Math.sin(angle), mirror = i % 3 === 0 ? -1 : 1;
    return { id: `i${i}`, geometry: "g", material: "m",
      transform: [c * mirror, 0, -s * mirror, 0, 0.1, 1.4, 0, 0, s * 0.7, 0, c * 0.7, 0, i % 16, Math.floor(i / 16), 0, 1] };
  });
  const packet = { geometries: [{ id: "g", revision: 0, vertices, indices }], materials, instances };
  const resident = new Set(["g"]), update = { materials, instances };
  const operations = { fullPacket: () => prepareRenderPacket(packet).batches,
    instanceUpdate: () => prepareInstanceUpdate(resident, update) };
  const samples = { fullPacket: [], instanceUpdate: [] };
  let checksum = 0;
  const measure = (name, record) => {
    const start = performance.now(), result = operations[name](), elapsed = performance.now() - start;
    checksum += result.reduce((count, batch) => count + batch.count, 0);
    if (record) samples[name].push(elapsed);
  };
  for (let round = 0; round < warmups + sampleCount; round++) {
    for (const name of round % 2 ? ["instanceUpdate", "fullPacket"] : ["fullPacket", "instanceUpdate"]) measure(name, round >= warmups);
  }
  if (checksum !== 2 * (warmups + sampleCount) * instanceCount) throw new Error("Preparation result count mismatch.");
  return { input: { geometryBytes: vertices.byteLength + indices.byteLength, vertices: vertexCount,
    triangles: vertexCount / 3, instances: instanceCount, transform: "rotation, shear, nonuniform scale, mirrored winding" },
    fullPacket: summarize(samples.fullPacket), instanceUpdate: summarize(samples.instanceUpdate), checksum };
}
const cases = [];
for (const vertexCount of [3, 898_779]) for (const instanceCount of [128, 1024]) cases.push(benchmark(vertexCount, instanceCount));
console.log(JSON.stringify({ schema: 2, timestamp: new Date().toISOString(),
  scope: "Node CPU render-packet preparation only; no GPU, FPS, renderer or competitor comparison",
  runtime: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  method: { warmupsPerPath: warmups, samplesPerPath: sampleCount, alternatingOrder: true, geometryUnchanged: true }, cases,
}, null, 2));
