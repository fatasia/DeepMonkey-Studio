import { readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WARNING_LINES = 300;
const BLOCKING_LINES = WARNING_LINES + 1;
const EXTENSIONS = new Set([".cts", ".mjs", ".mts", ".rs", ".ts", ".tsx", ".wgsl"]);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const sourceRoots = [
  resolve(packageRoot, "src"),
  resolve(packageRoot, "lab"),
  resolve(packageRoot, "scripts"),
  resolve(packageRoot, "../deep-engine-native/src"),
  resolve(packageRoot, "../deep-engine-native/tests"),
];
// Existing legacy files are tracked explicitly; new oversized files remain blocking.
const LEGACY_OVERSIZED = new Set([
  "packages/deep-engine-native/tests/chart_render.rs",
  "packages/deep-engine-native/src/chart/render.rs",
  "packages/deep-engine-native/src/deep2d/hit_index.rs",
  "packages/deep-engine-native/src/native_ui/control_render.rs",
  "packages/deep-engine-native/src/chart/chart_ir.rs",
  "packages/deep-engine-native/src/native_ui/retained_ui.rs",
  "packages/deep-engine-native/src/chart_gpu_tests.rs",
  "packages/deep-engine-native/src/chart/interaction.rs",
  "packages/deep-engine-native/src/deep2d_gpu_cache.rs",
  "packages/deep-engine/src/threeBridge/DeepWebGpuBackend.test.ts",
  "packages/deep-engine-native/src/deep2d_gpu.rs",
  "packages/deep-engine-native/tests/performance_guards.rs",
]);
const legacyByBaseline = new Map();

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(path);
    return entry.isFile() && EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  }));
  return nested.flat();
}

function lineCount(source) {
  if (source.length === 0) return 0;
  return source.split(/\r?\n/u).length - Number(source.endsWith("\n"));
}

function isLegacyOversized(path, lines) {
  if (lines < BLOCKING_LINES) return false;
  if (LEGACY_OVERSIZED.has(path)) return true;
  if (legacyByBaseline.has(path)) return legacyByBaseline.get(path);
  let legacy = false;
  try {
    const baseline = execFileSync("git", ["show", `HEAD:${path}`], { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    legacy = lineCount(baseline) >= BLOCKING_LINES;
  } catch {
    // Untracked/new files have no HEAD baseline and must remain blocking.
  }
  legacyByBaseline.set(path, legacy);
  return legacy;
}

const files = (await Promise.all(sourceRoots.map(collectFiles))).flat();
const measurements = await Promise.all(files.map(async (path) => ({
  lines: lineCount(await readFile(path, "utf8")),
  path: relative(repositoryRoot, path).replaceAll("\\", "/"),
})));
const warnings = measurements.filter(({ lines }) => lines > WARNING_LINES)
  .sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));
const failures = warnings.filter(({ lines, path }) => lines >= BLOCKING_LINES && !isLegacyOversized(path, lines));
const failurePaths = new Set(failures.map(({ path }) => path));

for (const measurement of warnings) {
  const level = failurePaths.has(measurement.path) ? "ERROR" : "WARN";
  console.log(`${level} ${measurement.lines} ${measurement.path}`);
}
console.log(`Deep Engine source-size gate: files=${measurements.length} warnings=${warnings.length} failures=${failures.length}`);
if (failures.length > 0) {
  console.error(`Files above ${WARNING_LINES} lines must be split by responsibility.`);
  process.exitCode = 1;
}
