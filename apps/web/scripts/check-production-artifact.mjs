import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distRoot = resolve(webRoot, "dist");
const manifestPath = resolve(distRoot, ".vite/manifest.json");
const forbiddenMarkers = [
  "ViewerVisualQa",
  "DashboardVisualQa",
  "__visualQa",
  "PRODUCT BROWSER QA",
  "工业三维渲染基线"
];

if (!existsSync(manifestPath)) {
  throw new Error("生产产物不存在，请先执行 web build");
}

const textExtensions = new Set([".css", ".html", ".js", ".json", ".mjs"]);
const leakedFiles = listFiles(distRoot).flatMap((filePath) => {
  if (!textExtensions.has(extname(filePath))) return [];
  const content = readFileSync(filePath, "utf8");
  const marker = forbiddenMarkers.find((candidate) => content.includes(candidate));
  return marker ? [{ filePath, marker }] : [];
});

if (leakedFiles.length > 0) {
  const details = leakedFiles.map(({ filePath, marker }) => `${filePath}: ${marker}`).join("\n");
  throw new Error(`生产包混入视觉验收入口或夹具：\n${details}`);
}

console.log("[production-artifact] 通过：正常生产包未携带视觉验收入口或夹具");

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}
