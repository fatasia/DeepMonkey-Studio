import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(root, "../../test-output/deep-engine/chart-data-golden");
await mkdir(output, { recursive: true });
const outfile = path.join(output, "apply.mjs");
await build({ entryPoints: [path.join(root, "src/chartDataApply.ts")], bundle: true, platform: "node", format: "esm", outfile });
const { applyChartDataUpdate } = await import(pathToFileURL(outfile).href);
const source = JSON.parse(await readFile(path.join(root, "fixtures/chart-ir-v1.json"), "utf8"));
const messages = [
  { schema: "deep-engine.chart-data-update", schemaVersion: 1, chartId: source.id, expectedDataRevision: 0, dataRevision: 1,
    datasets: [{ kind: "append-window", datasetId: "main", rows: [["C", 4, 0.4, "泵三"]], maxRows: 2 }] },
  { schema: "deep-engine.chart-data-update", schemaVersion: 1, chartId: source.id, expectedDataRevision: 1, dataRevision: 2,
    datasets: [{ kind: "replace", datasetId: "main", rows: [["D", 8, 0.8, "水箱四"]] }] },
];
let current = { ir: source, dataRevision: 0 };
const steps = messages.map(message => {
  current = applyChartDataUpdate(current.ir, current.dataRevision, message);
  return { message, expected: current };
});
await writeFile(path.join(root, "fixtures/chart-data-update-v1.json"), JSON.stringify({ source, steps }, null, 2) + "\n");
console.log("Chart data golden generated from TS source reconciliation: append-window -> replace");
