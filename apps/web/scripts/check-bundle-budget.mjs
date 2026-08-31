import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const dist = join(import.meta.dirname, "..", "dist");
const assets = join(dist, "assets");
const budgets = [
  { prefix: "index-", maximumBytes: 1_100_000, label: "主应用入口" },
  { prefix: "ViewerEngine-", maximumBytes: 500_000, label: "常规三维浏览器" },
  { prefix: "postProcessingRuntime-", maximumBytes: 220_000, label: "按需后处理" },
  { prefix: "ParametricModelWorkbench-", maximumBytes: 60_000, label: "参数化建模工作台" },
  { prefix: "parametricCad.worker-", maximumBytes: 350_000, label: "参数化建模 Worker" },
  { prefix: "replicad_single-", extension: ".wasm", maximumBytes: 25_000_000, label: "参数化 OpenCascade WASM" }
];

for (const budget of budgets) assertAssetBudget(budget);
const manifest = readManifest();
assertManifestAssetBudget(manifest, "@thatopen/fragments/dist/index.mjs", 4_500_000, "IFC/Fragments 运行时");
assertManifestAssetBudget(manifest, "@thatopen/fragments/dist/Worker/worker.mjs", 3_500_000, "IFC/Fragments Worker");
assertRuntimeBoundaries(manifest);
assertInitialJavaScriptBudget(manifest, 1_900_000, 540_000);

function assertAssetBudget({ prefix, extension = ".js", maximumBytes, label }) {
  const file = readdirSync(assets).find((name) => name.startsWith(prefix) && name.endsWith(extension));
  if (!file) throw new Error(`未找到${label}产物（${prefix}）`);
  const size = statSync(join(assets, file)).size;
  if (size > maximumBytes) throw new Error(`${label}超出预算：${formatBytes(size)} > ${formatBytes(maximumBytes)} (${file})`);
  console.log(`[bundle-budget] ${label}: ${formatBytes(size)} / ${formatBytes(maximumBytes)}`);
}

function readManifest() {
  const manifestPath = join(dist, ".vite", "manifest.json");
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function assertManifestAssetBudget(manifest, sourceSuffix, maximumBytes, label) {
  const [, item] = findManifestEntry(manifest, sourceSuffix);
  const size = statSync(join(dist, item.file)).size;
  if (size > maximumBytes) throw new Error(`${label}超出预算：${formatBytes(size)} > ${formatBytes(maximumBytes)} (${item.file})`);
  console.log(`[bundle-budget] ${label}: ${formatBytes(size)} / ${formatBytes(maximumBytes)}`);
}

function assertRuntimeBoundaries(manifest) {
  const entry = Object.values(manifest).find((item) => item.isEntry);
  if (!entry) throw new Error("未找到 Vite 初始入口 manifest");
  const initial = collectImports(manifest, entry);
  const [fragmentsKey, fragments] = findManifestEntry(manifest, "@thatopen/fragments/dist/index.mjs");
  const [, worker] = findManifestEntry(manifest, "@thatopen/fragments/dist/Worker/worker.mjs");
  const [workerUrlKey, workerUrl] = findManifestEntry(manifest, "@thatopen/fragments/dist/Worker/worker.mjs?url");
  const [viewerKey, viewer] = findManifestEntry(manifest, "src/viewer/ViewerEngine.ts");
  const [, postProcessing] = findManifestEntry(manifest, "src/viewer/postProcessingRuntime.ts");
  const [, parametricWorkbench] = findManifestEntry(manifest, "src/parametric/ParametricModelWorkbench.tsx");
  const forbiddenFiles = new Set([viewer.file, fragments.file, worker.file, workerUrl.file, postProcessing.file, parametricWorkbench.file]);
  const forbidden = initial.filter((file) => forbiddenFiles.has(file));
  if (forbidden.length > 0) throw new Error(`初始页面意外加载高级三维运行时：${forbidden.join(", ")}`);
  if (initial.some((file) => file.includes("archive-runtime"))) {
    throw new Error("初始页面意外加载场景压缩运行时");
  }

  const viewerStaticImports = new Set(collectImports(manifest, viewer));
  const leaked = [fragments.file, worker.file, workerUrl.file, postProcessing.file].filter((file) => viewerStaticImports.has(file));
  if (leaked.length > 0) throw new Error(`常规三维浏览器静态加载了按需能力：${leaked.join(", ")}`);
  const dynamicImports = new Set(viewer.dynamicImports ?? []);
  for (const required of [fragmentsKey, workerUrlKey]) {
    if (!dynamicImports.has(required)) throw new Error(`ViewerEngine 未按需声明运行时：${required}`);
  }
  console.log(`[bundle-budget] 首屏 ${initial.length} 个 chunk；IFC、后处理与参数化建模均保持按需加载`);
}

function assertInitialJavaScriptBudget(manifest, maximumBytes, maximumGzipBytes) {
  const entry = Object.values(manifest).find((item) => item.isEntry);
  if (!entry) throw new Error("未找到 Vite 初始入口 manifest");
  const files = collectImports(manifest, entry).filter((file) => file.endsWith(".js"));
  const contents = files.map((file) => readFileSync(join(dist, file)));
  const bytes = contents.reduce((sum, content) => sum + content.byteLength, 0);
  const gzipBytes = contents.reduce((sum, content) => sum + gzipSync(content).byteLength, 0);
  if (bytes > maximumBytes || gzipBytes > maximumGzipBytes) {
    throw new Error(
      `首屏 JavaScript 超出预算：${formatBytes(bytes)} / gzip ${formatBytes(gzipBytes)}，预算 ${formatBytes(maximumBytes)} / gzip ${formatBytes(maximumGzipBytes)}`
    );
  }
  console.log(
    `[bundle-budget] 首屏 JavaScript: ${formatBytes(bytes)} / gzip ${formatBytes(gzipBytes)}；预算 ${formatBytes(maximumBytes)} / gzip ${formatBytes(maximumGzipBytes)}`
  );
}

function findManifestEntry(manifest, sourceSuffix) {
  const match = Object.entries(manifest).find(([key, item]) => key.replaceAll("\\", "/").endsWith(sourceSuffix) || item.src?.replaceAll("\\", "/").endsWith(sourceSuffix));
  if (!match) throw new Error(`manifest 未找到运行时入口：${sourceSuffix}`);
  return match;
}

function collectImports(manifest, entry) {
  const visited = new Set();
  const visit = (item) => {
    if (!item || visited.has(item.file)) return;
    visited.add(item.file);
    for (const imported of item.imports ?? []) visit(manifest[imported]);
  };
  visit(entry);
  return [...visited];
}

function formatBytes(value) {
  return `${(value / 1024).toFixed(1)} KiB`;
}
