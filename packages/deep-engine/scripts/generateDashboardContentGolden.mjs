import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const repo = path.resolve(root, "../..");
const output = path.join(repo, "test-output/deep-engine/dashboard-content-golden");
await mkdir(output, { recursive: true });
const bundle = async (entry, name) => {
  const outfile = path.join(output, `${name}.mjs`);
  await build({ entryPoints: [path.join(repo, entry)], bundle: true, platform: "node", format: "esm",
    conditions: ["development"], outfile });
  return import(pathToFileURL(outfile).href);
};
const { compileDashboardContent } = await bundle("apps/web/src/delivery/compileDashboardContent.ts", "content");
const { buildDashboardRuntimePackage, serializeDeepRuntimePackage } = await bundle("packages/deep-engine/src/runtimePackage/index.ts", "runtime");
const source = JSON.parse(await readFile(path.join(root, "fixtures/dashboard-layout-source-v1.json"), "utf8"));
source.application.scripts = []; source.application.interactions = [];
source.application.pages[0].nodes = ["rectangle", "rounded", "ellipse"].map((shape, index) => ({
  id: `shape-${shape}`, kind: "data-widget", zIndex: index,
  frame: { x: 100 + 300 * index, y: 100, width: 260, height: 180 },
  widget: { title: shape, key: shape, unit: "", type: "shape", shape, color: ["#368bd6", "#33bb99", "#e5aa44"][index], borderWidth: 0 },
}));
const compiled = compileDashboardContent(source);
const result = buildDashboardRuntimePackage({ packageId: "dashboard.shape-content", packageVersion: "1.0.0",
  deep2d: { schema: "deep-engine.deep2d-runtime", schemaVersion: 1, id: "dashboard.shape-content",
    revision: compiled.displayList.revision, composition: "path-then-atlas", displayList: compiled.displayList, atlases: [], quads: [] } });
for (const [name, value] of [["dashboard-content-source-v1", source], ["dashboard-content-v1", compiled]])
  await writeFile(path.join(root, `fixtures/${name}.json`), JSON.stringify(value, null, 2) + "\n", "utf8");
await writeFile(path.join(root, "fixtures/dashboard-content-runtime-v1.json"), serializeDeepRuntimePackage(result) + "\n", "utf8");
console.log(`Authored shape content golden (publicationReady=${compiled.publicationReady}): ${result.packageHash.value}`);
