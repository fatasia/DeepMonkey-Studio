import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const writeIndex = args.find((value) => value.startsWith("--write="))?.slice("--write=".length);

/**
 * Verify the assets that are actually deliverable from a clean Git clone.
 * External/customer libraries intentionally remain optional and are reported
 * as such; this command never downloads or mutates them.
 */
const manifest = await buildManifest();
const failures = manifest.verification.failures;
if (writeIndex) {
  const output = path.resolve(root, writeIndex);
  await (await import("node:fs/promises")).writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`asset delivery manifest written: ${path.relative(root, output)}`);
}
console.log(`open asset delivery: ${manifest.verification.status} · tracked=${manifest.repository.trackedFiles} · nature-kit=${manifest.bundled.find((item) => item.id === "nature-kit")?.modelCount ?? 0}`);
for (const item of [...manifest.bundled, ...manifest.optional]) console.log(`${item.status === "ready" ? "READY" : "OPTIONAL"} ${item.id}: ${item.delivery}`);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
}

async function buildManifest() {
  const tracked = trackedFiles();
  const failures = [];
  const bundled = [];

  const nature = await inspectNatureKit(tracked, failures);
  bundled.push(nature);
  const vision = await inspectDirectoryAsset({
    id: "vision-sample",
    root: "apps/api/assets/vision-sample",
    required: ["README.md", "LICENSE-YOLOX", "dog.jpg", "yolox_nano.onnx"],
    license: "Apache-2.0",
    delivery: "API 视觉样例随仓库交付，启动后不下载",
  }, tracked, failures);
  bundled.push(vision);
  const lab = await inspectLabAssets(tracked, failures);
  bundled.push(lab);
  const battery = await inspectDirectoryAsset({
    id: "battery-models",
    root: "apps/api/models/battery",
    required: ["README.md", "candidate-manifests.json"],
    extensions: [".onnx", ".f32", ".json"],
    license: "仓库模型说明及上游许可证以目录文件为准",
    delivery: "电池推理模型随仓库交付；仅在启用电池运行时的部署中加载",
  }, tracked, failures);
  bundled.push(battery);

  const optional = [
    await optionalEntry("external-open-packs", "data/external-assets/open-packs", "CC0 包同步缓存被 .gitignore 排除；运行 assets:sync:open-packs 后才可用", tracked),
    await optionalEntry("industrial-source-a", "data/external-assets/source-a", "外部工业模型目录被 .gitignore 排除；需配置 ASSET_LIBRARY_DIR 并导入经过许可审计的目录", tracked),
    await optionalEntry("industrial-source-b", "data/external-assets/source-b", "外部社区模型目录被 .gitignore 排除；需先同步并通过质量/许可证审计", tracked),
    await optionalEntry("environment-materials", "data/external-assets/environment-materials", "环境材质库被 .gitignore 排除；运行 assets:sync:environment-materials 后才可用", tracked),
    await optionalEntry("format-fixtures", "data/external-assets/format-fixtures", "工业格式测试样本被 .gitignore 排除；仅用于开发/验收，不作为产品素材库", tracked),
  ];

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repository: {
      cleanClone: "git clone + pnpm install --frozen-lockfile",
      trackedFiles: tracked.size,
      trackedAssets: await summarizeTrackedAssets(tracked),
      ignoredRoots: ["data/", "apps/web/public/wasm/", "apps/web/public/draco/", "apps/web/public/basis/"],
    },
    bundled,
    codeCatalogs: [
      { id: "dashboard-templates", source: "apps/web/src/components/dashboardTemplateCatalog.ts", status: "ready", delivery: "模板定义编译进 Web bundle；不依赖外部下载；测试断言 317 个模板" },
      { id: "dashboard-2d-components", source: "apps/web/src/components/dashboardWorkspaceModel.ts", status: "ready", delivery: "二维组件/装饰定义编译进 Web bundle；导入后存入场景文档" },
      { id: "industry-template-packs", source: "apps/web/src/components/industryTemplatePackCatalog.ts", status: "ready", delivery: "行业模板包与样例数据编译进 Web bundle；不依赖外部素材目录" },
      { id: "nature-kit-catalog", source: "apps/web/public/assets/nature-kit/catalog.json", status: nature.status, delivery: "API 默认回退到随包 Nature Kit 目录" },
    ],
    optional,
    startupContract: {
      apiDefaultAssetLibrary: "data/external-assets/source-a",
      natureKitFallback: "apps/web/public/assets/nature-kit",
      assetLibraryLoad: "API 启动只注册路径；首次 GET /api/asset-library 时惰性读取各目录 catalog/audit，后续按文件变更刷新缓存",
      automaticNetworkSync: false,
      cleanCloneResult: "模板/二维组件/Nature Kit/视觉样例/Deep Engine Lab fixtures 可用；工业模型、开放扩展包、环境材质和格式样本需单独同步",
    },
    verification: { status: failures.length ? "failed" : "passed", failures },
  };
}

async function inspectNatureKit(tracked, failures) {
  const relativeRoot = "apps/web/public/assets/nature-kit";
  const rootPath = path.join(root, relativeRoot);
  const catalogPath = path.join(rootPath, "catalog.json");
  let catalog;
  try { catalog = JSON.parse(await readFile(catalogPath, "utf8")); }
  catch { failures.push(`${relativeRoot}/catalog.json missing or invalid`); return readyEntry("nature-kit", relativeRoot, "CC0-1.0", "Nature Kit 48 个 GLB 与 192 个缩略图随 Web 静态包交付", 0, 0); }
  if (catalog.schema !== "deep-engine.v11-nature-kit-catalog" || catalog.selectedCount !== 48 || catalog.entries?.length !== 48) failures.push("Nature Kit catalog must contain exactly 48 audited entries");
  let bytes = 0;
  for (const entry of catalog.entries ?? []) {
    const modelRelative = path.join(relativeRoot, "models", `${entry.id}.glb`);
    const modelPath = path.join(root, modelRelative);
    try {
      const model = await readFile(modelPath);
      bytes += model.byteLength;
      if (entry.bytes !== model.byteLength) failures.push(`${modelRelative}: byte length differs from catalog`);
      if (entry.contentHash && sha256(model) !== entry.contentHash) failures.push(`${modelRelative}: SHA-256 differs from catalog`);
      if (!tracked.has(modelRelative.replaceAll(path.sep, "/"))) failures.push(`${modelRelative}: not tracked by Git`);
    } catch { failures.push(`${modelRelative}: missing`); }
    for (const direction of ["NE", "NW", "SE", "SW"]) {
      const thumbnailRelative = path.join(relativeRoot, "thumbnails", `${entry.id}_${direction}.png`);
      try { await stat(path.join(root, thumbnailRelative)); }
      catch { failures.push(`${thumbnailRelative}: missing`); }
    }
  }
  return readyEntry("nature-kit", relativeRoot, "CC0-1.0", "Nature Kit 48 个 GLB 与 192 个缩略图随 Web 静态包交付", catalog.entries?.length ?? 0, bytes);
}

async function inspectLabAssets(tracked, failures) {
  const relativeRoot = "packages/deep-engine/lab/assets";
  const rootPath = path.join(root, relativeRoot);
  let sources;
  try { sources = JSON.parse(await readFile(path.join(rootPath, "sources.json"), "utf8")); }
  catch { failures.push(`${relativeRoot}/sources.json missing or invalid`); return readyEntry("deep-engine-lab-fixtures", relativeRoot, "per-file upstream notices", "渲染器 Lab 样例随仓库交付，仅用于测试与开发", 0, 0); }
  let bytes = 0;
  for (const sample of sources.samples ?? []) {
    const relative = path.join(relativeRoot, sample.file).replaceAll(path.sep, "/");
    try {
      const file = await readFile(path.join(root, relative));
      bytes += file.byteLength;
      if (sample.bytes !== file.byteLength) failures.push(`${relative}: byte length differs from sources.json`);
      if (sample.sha256 && sha256(file) !== sample.sha256) failures.push(`${relative}: SHA-256 differs from sources.json`);
      if (!tracked.has(relative)) failures.push(`${relative}: not tracked by Git`);
      const notice = path.join(root, relativeRoot, `${path.basename(sample.file, ".glb")}.LICENSE.md`);
      try { await stat(notice); } catch { failures.push(`${relative}: upstream license notice missing`); }
    } catch { failures.push(`${relative}: missing`); }
  }
  return readyEntry("deep-engine-lab-fixtures", relativeRoot, "per-file upstream notices", "渲染器 Lab 样例随仓库交付，仅用于测试与开发", sources.samples?.length ?? 0, bytes);
}

async function inspectDirectoryAsset(spec, tracked, failures) {
  const rootPath = path.join(root, spec.root);
  let files = [];
  try { files = await readdir(rootPath); }
  catch { failures.push(`${spec.root}: required bundled directory missing`); }
  for (const relative of spec.required) {
    const pathName = path.join(spec.root, relative).replaceAll(path.sep, "/");
    if (!tracked.has(pathName)) failures.push(`${pathName}: not tracked by Git`);
    try { await stat(path.join(root, pathName)); } catch { failures.push(`${pathName}: missing`); }
  }
  const binaryCount = files.filter((file) => spec.extensions?.includes(path.extname(file).toLowerCase())).length;
  return { id: spec.id, root: spec.root, status: "ready", license: spec.license, delivery: spec.delivery, fileCount: files.length, binaryCount };
}

function readyEntry(id, relativeRoot, license, delivery, modelCount, bytes) {
  return { id, root: relativeRoot, status: "ready", license, delivery, modelCount, bytes };
}

async function optionalEntry(id, relativeRoot, delivery, tracked) {
  const files = [...tracked].filter((file) => file.startsWith(`${relativeRoot}/`));
  let presentOnDisk = false;
  try { await stat(path.join(root, relativeRoot)); presentOnDisk = true; } catch { /* Optional cache absent. */ }
  return { id, root: relativeRoot, status: "optional", license: "见各自目录的来源审计", delivery, presentOnDisk, gitTrackedFiles: files.length };
}

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], { cwd: root });
  return new Set(output.toString("utf8").split("\0").filter(Boolean));
}

async function summarizeTrackedAssets(tracked) {
  const assetExtensions = new Set([".glb", ".gltf", ".obj", ".fbx", ".stl", ".3mf", ".step", ".stp", ".x_t", ".jt", ".rvt", ".e57", ".las", ".laz", ".copc", ".b3dm", ".i3dm", ".pnts", ".json", ".png", ".jpg", ".jpeg", ".webp", ".ktx2", ".hdr", ".exr", ".onnx", ".f32", ".mp4", ".svg"]);
  const byExtension = {};
  let bytes = 0;
  for (const relative of tracked) {
    const extension = path.extname(relative).toLowerCase();
    if (!assetExtensions.has(extension)) continue;
    try {
      const size = (await stat(path.join(root, relative))).size;
      const row = byExtension[extension] ??= { files: 0, bytes: 0 };
      row.files += 1;
      row.bytes += size;
      bytes += size;
    } catch { /* Deleted tracked files are not deliverable from the current worktree. */ }
  }
  return { files: Object.values(byExtension).reduce((sum, row) => sum + row.files, 0), bytes, byExtension };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
