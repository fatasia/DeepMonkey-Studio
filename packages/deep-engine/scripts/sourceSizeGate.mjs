import { readdir, readFile } from "node:fs/promises";
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

const files = (await Promise.all(sourceRoots.map(collectFiles))).flat();
const measurements = await Promise.all(files.map(async (path) => ({
  lines: lineCount(await readFile(path, "utf8")),
  path: relative(repositoryRoot, path).replaceAll("\\", "/"),
})));
const warnings = measurements.filter(({ lines }) => lines > WARNING_LINES)
  .sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));
const failures = warnings.filter(({ lines }) => lines >= BLOCKING_LINES);

for (const measurement of warnings) {
  const level = measurement.lines >= BLOCKING_LINES ? "ERROR" : "WARN";
  console.log(`${level} ${measurement.lines} ${measurement.path}`);
}
console.log(`Deep Engine source-size gate: files=${measurements.length} warnings=${warnings.length} failures=${failures.length}`);
if (failures.length > 0) {
  console.error(`Files above ${WARNING_LINES} lines must be split by responsibility.`);
  process.exitCode = 1;
}
