import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// Compile into isolated test output; shared dist is not touched.
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(root, "../../test-output/deep-engine/dashboard-golden");
await mkdir(output, {recursive:true});
const modulePath = path.join(output, "runtime.mjs");
await build({entryPoints:[path.join(root,"src/runtimePackage/index.ts")], bundle:true,
  platform:"node", format:"esm", outfile:modulePath});
const {buildDashboardRuntimePackage, serializeDeepRuntimePackage} = await import(pathToFileURL(modulePath).href);
const deep2d = JSON.parse(await readFile(path.resolve(root,"../deep-engine-native/fixtures/deep2d_runtime_atlas_v1.json"),"utf8"));
const result = buildDashboardRuntimePackage({packageId:"dashboard.main",packageVersion:"1.0.0",deep2d});
const fixturePath = path.join(root,"fixtures/dashboard-runtime-v1.json");
await writeFile(fixturePath, serializeDeepRuntimePackage(result)+"\n","utf8");
console.log(`Dashboard runtime golden: ${result.packageHash.value}`);
