import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, relative } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const configuredRoots = process.argv.slice(2);
const defaultRoots = [
  "apps/api/src",
  "apps/cloud-render-worker/src",
  "apps/desktop/scripts",
  "apps/desktop/src-tauri",
  "apps/web/dist",
  "apps/web/index.html",
  "apps/web/public",
  "apps/web/scripts",
  "apps/web/src",
  "packages",
  "scripts",
  "tools/revit-agent",
  "tools/revit-worker",
  "tools/unity",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "bim-studio.ps1",
  "logo-layers-20260804.svg",
];
const roots = (configuredRoots.length ? configuredRoots : defaultRoots)
  .map((path) => resolve(repositoryRoot, path));

// 这些名称只允许存在于内部调研、许可台账与隔离测试缓存，不能进入用户可见产物。
const forbiddenMarks = [
  ["industrial", "studio"].join(" "),
  "itwin",
  "bentley",
  "帆软",
  "finevis",
  "fanruan",
  "thingjs",
  "山海鲸",
  "捷码",
  "gemcoder",
  "图扑",
  "hightopo",
];
const textExtensions = new Set([
  ".addin", ".asmdef", ".cjs", ".cs", ".css", ".html", ".js", ".jslib", ".json", ".jsx",
  ".map", ".md", ".meta", ".mjs", ".ps1", ".py", ".rs", ".sh", ".svg", ".toml", ".ts", ".tsx",
  ".txt", ".xml", ".yaml", ".yml",
]);
const excludedFiles = new Set([
  "scripts/check-public-brand-isolation.mjs",
]);
const excludedPathPrefixes = [
  "apps/desktop/src-tauri/gen/",
  "tools/unity/.smoke-runs/",
];
const excludedDirectories = new Set([".git", "coverage", "dist", "node_modules", "target"]);
const violations = [];

for (const root of roots) {
  if (!(await exists(root))) continue;
  for (const file of await filesUnder(root)) {
    const normalizedName = normalizedRelativePath(file);
    if (excludedFiles.has(normalizedName) || excludedPathPrefixes.some((prefix) => normalizedName.startsWith(prefix))) continue;
    inspectText(normalizedName, file, "文件名");
    const extension = file.slice(file.lastIndexOf(".")).toLocaleLowerCase("en-US");
    if (!textExtensions.has(extension)) continue;
    const content = (await readFile(file, "utf8")).toLocaleLowerCase("en-US");
    inspectText(content, file, "内容");
  }
}

if (violations.length) {
  console.error("正式产物包含竞品名称或标识引用：");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("正式产物去品牌门禁通过");
}

function inspectText(text, file, source) {
  for (const mark of forbiddenMarks) {
    if (text.includes(mark)) violations.push(`${relative(repositoryRoot, file)} · ${source} · ${mark}`);
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name.toLocaleLowerCase("en-US"))) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function filesUnder(path) {
  return (await stat(path)).isDirectory() ? walk(path) : [path];
}

function normalizedRelativePath(path) {
  return relative(repositoryRoot, path).replaceAll("\\", "/").toLocaleLowerCase("en-US");
}
