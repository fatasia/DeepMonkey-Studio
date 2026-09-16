import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(root, "../../test-output/deep-engine/chart-sim-golden");
await mkdir(output, { recursive: true });
await build({ entryPoints: [path.join(root, "src/chartSimulation.ts"), path.join(root, "src/chartDataApply.ts")],
  bundle: true, platform: "node", format: "esm", outdir: output, outExtension: { ".js": ".mjs" } });
const { ChartSimulationSource } = await import(pathToFileURL(path.join(output, "chartSimulation.mjs")).href);
const { applyChartDataUpdate } = await import(pathToFileURL(path.join(output, "chartDataApply.mjs")).href);
const read = async name => JSON.parse(await readFile(path.join(root, "fixtures", name), "utf8"));
const source = await read("chart-ir-v1.json");
const fixture = await read("chart-sim-v1.json");
const sim = new ChartSimulationSource(fixture, source);
let current = { ir: source, dataRevision: 0 };
const steps = [];
for (const elapsedMs of [0, 500, 500, 500]) {
  const frame = sim.prepare(elapsedMs, current.dataRevision);
  current = applyChartDataUpdate(current.ir, current.dataRevision, frame.message);
  sim.commit(frame, current.dataRevision);
  steps.push({ elapsedMs, ...frame, expected: current });
}
await writeFile(path.join(root, "fixtures/chart-sim-replay-v1.json"), JSON.stringify({ source, fixture, steps }, null, 2) + "\n");
console.log("Chart sim golden generated from TS fixed-clock producer and source reconciliation.");
