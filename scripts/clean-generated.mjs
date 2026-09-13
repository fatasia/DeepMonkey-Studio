import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apply = process.argv.includes("--apply");

const explicitRelativePaths = [
  "--format",
  ".cache",
  ".chrome-ui-check",
  ".chrome-ui-check2",
  ".chrome-ui-check3",
  ".runtime-logs",
  "apps/battery-native-runtime/target",
  "apps/desktop/.scene-viewer-build",
  "apps/desktop/src-tauri/gen",
  "apps/desktop/src-tauri/target",
  "apps/web/public/basis",
  "apps/web/public/brand/logo.webp",
  "apps/web/public/draco",
  "apps/web/public/wasm",
  "artifacts",
  "data/logs",
  "logs",
  "packages/deep-engine-native/artifacts",
  "packages/deep-engine-native/target",
  "packages/deep-engine-native/target-native-packet-cache",
  "tools/revit-worker/build",
  "tools/revit-worker/publish",
  "tools/unity/.smoke-runs",
  "tools/unity/bridge-smoke/Build",
  "tools/unity/bridge-smoke/Library",
  "tools/unity/bridge-smoke/Logs",
  "tools/unity/bridge-smoke/Temp",
  "tools/unity/bridge-smoke/UserSettings",
];

async function collectGeneratedDirectories(root, names, targets) {
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const absolutePath = path.join(root, entry.name);
    if (names.has(entry.name)) {
      targets.add(absolutePath);
      continue;
    }
    await collectGeneratedDirectories(absolutePath, names, targets);
  }
}

async function collectLogFiles(root, targets) {
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".log")) {
      targets.add(path.join(root, entry.name));
    }
  }
}

async function collectStaleNodeRedPackages(targets) {
  const lockfile = await readFile(path.join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
  if (lockfile.includes("node-red")) return;

  const virtualStore = path.join(repositoryRoot, "node_modules", ".pnpm");
  let entries = [];
  try {
    entries = await readdir(virtualStore, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.includes("node-red")) {
      targets.add(path.join(virtualStore, entry.name));
    }
  }
}

async function sizeOf(target) {
  const metadata = await stat(target);
  if (!metadata.isDirectory()) return metadata.size;
  let total = 0;
  for (const entry of await readdir(target, { withFileTypes: true })) {
    total += await sizeOf(path.join(target, entry.name));
  }
  return total;
}

function assertInsideRepository(target) {
  const relativePath = path.relative(repositoryRoot, target);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing unsafe cleanup target: ${target}`);
  }
  return relativePath;
}

const targets = new Set(explicitRelativePaths.map((entry) => path.resolve(repositoryRoot, entry)));
await collectGeneratedDirectories(path.join(repositoryRoot, "apps"), new Set(["dist"]), targets);
await collectGeneratedDirectories(path.join(repositoryRoot, "packages"), new Set(["dist"]), targets);
await collectGeneratedDirectories(path.join(repositoryRoot, "tools", "revit-worker", "src"), new Set(["bin", "obj"]), targets);
await collectLogFiles(path.join(repositoryRoot, "data"), targets);
await collectLogFiles(path.join(repositoryRoot, "tools", "unity", "bridge-smoke"), targets);
await collectStaleNodeRedPackages(targets);

let totalBytes = 0;
let existingTargets = 0;
for (const target of [...targets].sort()) {
  const relativePath = assertInsideRepository(target);
  try {
    const bytes = await sizeOf(target);
    totalBytes += bytes;
    existingTargets += 1;
    console.log(`${apply ? "remove" : "would remove"}\t${relativePath}\t${(bytes / 1024 / 1024).toFixed(1)} MB`);
    if (apply) {
      await rm(target, {
        force: true,
        maxRetries: process.platform === "win32" ? 8 : 2,
        recursive: true,
        retryDelay: 150,
      });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

console.log(`${apply ? "removed" : "previewed"} ${existingTargets} paths, ${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GiB`);
