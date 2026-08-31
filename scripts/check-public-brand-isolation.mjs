import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, relative } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const configuredRoots = process.argv.slice(2);
const roots = (configuredRoots.length ? configuredRoots : ["apps/web/dist", "apps/web/public"])
  .map((path) => resolve(repositoryRoot, path));

// 这些名称只允许存在于内部调研、许可台账与隔离测试缓存，不能进入用户可见产物。
const forbiddenMarks = [
  "itwin",
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
const textExtensions = new Set([".css", ".html", ".js", ".json", ".map", ".md", ".svg", ".txt", ".xml"]);
const violations = [];

for (const root of roots) {
  if (!(await exists(root))) continue;
  for (const file of await walk(root)) {
    const normalizedName = relative(repositoryRoot, file).toLocaleLowerCase("en-US");
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
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
