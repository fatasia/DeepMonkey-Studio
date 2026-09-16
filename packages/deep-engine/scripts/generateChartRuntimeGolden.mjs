import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// Compile into isolated test output; shared dist is not touched.
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(root, "../../test-output/deep-engine/chart-golden");
await mkdir(output, {recursive:true});
const modulePath = path.join(output, "runtime.mjs");
await build({entryPoints:[path.join(root,"src/runtimePackage/index.ts")], bundle:true,
  platform:"node", format:"esm", outfile:modulePath});
const {buildChartRuntimePackage, serializeDeepRuntimePackage} = await import(pathToFileURL(modulePath).href);
const chartIr = JSON.parse(await readFile(path.resolve(root,"fixtures/chart-ir-v1.json"),"utf8"));
const simFixture = JSON.parse(await readFile(path.resolve(root,"fixtures/chart-sim-v1.json"),"utf8"));
const base = {packageId:"chart.main",packageVersion:"1.0.0",
  chart:{id:"chart.main.ir",revision:1,value:chartIr}};
const dynamic = buildChartRuntimePackage({...base,
  chartSim:{id:"chart.main.sim",revision:1,value:simFixture}});
const statless = buildChartRuntimePackage(base);
await writeFile(path.join(root,"fixtures/chart-runtime-v1.json"), serializeDeepRuntimePackage(dynamic)+"\n","utf8");
await writeFile(path.join(root,"fixtures/chart-runtime-static-v1.json"), serializeDeepRuntimePackage(statless)+"\n","utf8");
console.log(`Chart runtime goldens: dynamic ${dynamic.packageHash.value} static ${statless.packageHash.value}`);
