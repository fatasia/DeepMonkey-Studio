import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const source = new URL("../src/webgpu/affineSphereBounds.ts", import.meta.url);
const bundled = await build({ entryPoints: [fileURLToPath(source)], bundle: true, write: false,
  format: "esm", platform: "node", target: "node22" });
const { conservativeAffineScale } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const count = 65_536, iterations = 32, data = new Float32Array(count * 36);
for (let index = 0; index < count; index++) {
  const angle = index * 0.013, c = Math.cos(angle), s = Math.sin(angle);
  const sx = 1 + index % 5, sy = .5 + index % 3, shear = (index % 7 - 3) * .1;
  data.set([c * sx, -s * sy + shear, 0, 0, s * sx, c * sy, 0, 0, 0, 0, 1, 0], index * 36);
}

function previousScale(data, offset) {
  const row = [0, 4, 8].map(index => Math.abs(data[offset + index]) + Math.abs(data[offset + index + 1]) + Math.abs(data[offset + index + 2]));
  const column = [0, 1, 2].map(index => Math.abs(data[offset + index]) + Math.abs(data[offset + index + 4]) + Math.abs(data[offset + index + 8]));
  return Math.sqrt(Math.max(...row) * Math.max(...column));
}
let sink = 0;
function measure(run) {
  const start = performance.now();
  for (let index = 0; index < count; index++) sink += run(data, index * 36);
  return performance.now() - start;
}
for (let index = 0; index < 8; index++) { measure(previousScale); measure(conservativeAffineScale); }
const previous = [], current = [];
// Alternate order to reduce drift bias; allocations/GC in the previous implementation stay included.
for (let index = 0; index < iterations; index++) {
  if (index % 2) { current.push(measure(conservativeAffineScale)); previous.push(measure(previousScale)); }
  else { previous.push(measure(previousScale)); current.push(measure(conservativeAffineScale)); }
}
const summary = samples => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] };
};
const report = { scope: "CPU affine scale microbenchmark only; not whole-frame or competitor performance",
  node: process.version, count, iterations, sourceSha256: createHash("sha256").update(await readFile(source)).digest("hex"),
  previous: summary(previous), current: summary(current), samples: { previous, current }, sink };
const output = new URL("../../../test-output/deep-engine/", import.meta.url);
await mkdir(output, { recursive: true });
const file = new URL(`affine-bounds-cpu-${Date.now()}.json`, output);
await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, samples: undefined, evidence: fileURLToPath(file) }));
