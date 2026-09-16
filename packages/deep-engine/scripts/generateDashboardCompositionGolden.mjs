import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(root, "../../test-output/deep-engine/dashboard-composition-golden");
await mkdir(output, { recursive: true });
const modules = {};
for (const [name, source] of Object.entries({ runtime: "index.ts", fixture: "dashboardCompositionFixture.testUtils.ts" })) {
  const target = path.join(output, `${name}.mjs`);
  await build({ entryPoints: [path.join(root, "src/runtimePackage", source)], bundle: true, platform: "node", format: "esm", outfile: target });
  modules[name] = await import(pathToFileURL(target).href);
}
const json = async file => JSON.parse(await readFile(path.join(root, file), "utf8"));
const input = modules.fixture.dashboardCompositionFixture(await json("fixtures/chart-ir-v1.json"),
  await json("fixtures/chart-sim-v1.json"), await json("../deep-engine-native/fixtures/deep2d_runtime_atlas_v1.json"));
const result = modules.runtime.buildDashboardCompositionRuntimePackage(input);
await writeFile(path.join(root, "fixtures/dashboard-composition-v1.json"), modules.runtime.serializeDeepRuntimePackage(result) + "\n");
console.log(`Dashboard composition golden: ${result.packageHash.value}; resources=${result.resources.length}`);
