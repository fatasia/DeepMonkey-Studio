import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const NORMAL_FILE_LIMIT = 800;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".rs", ".cs", ".py", ".ps1"]);
const IGNORED_DIRECTORIES = new Set([
  "coverage",
  "dist",
  "node_modules",
  "target",
  ".scene-viewer-build",
  ".smoke-runs",
  "Library",
  "PackageCache",
  "site-packages"
]);

const sourceFiles = (await Promise.all(["apps", "packages", "scripts", "tools"].map(walk))).flat();
const failures = [];

for (const filePath of sourceFiles) {
  const relativePath = path.relative(process.cwd(), filePath).replaceAll(path.sep, "/");
  const lines = lineCount(await readFile(filePath, "utf8"));
  if (lines > NORMAL_FILE_LIMIT) {
    failures.push(`${relativePath}: ${lines} 行；新文件或已拆分文件不得超过 ${NORMAL_FILE_LIMIT} 行`);
  }
}

if (failures.length) {
  console.error("[source-size] 源文件体量门禁失败：");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`[source-size] ${sourceFiles.length} 个源文件通过；所有源文件上限 ${NORMAL_FILE_LIMIT} 行，无豁免`);

async function walk(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.flatMap((entry) => {
    if (entry.isDirectory()) {
      return IGNORED_DIRECTORIES.has(entry.name) ? [] : [walk(path.join(root, entry.name))];
    }
    return entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [[path.join(root, entry.name)]] : [];
  }));
  return nested.flat();
}

function lineCount(source) {
  if (!source) return 0;
  const lines = source.split(/\r?\n/).length;
  return source.endsWith("\n") ? lines - 1 : lines;
}
