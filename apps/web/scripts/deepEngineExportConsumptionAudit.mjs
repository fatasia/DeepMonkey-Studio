/**
 * Z5 消费方与价值审计:deep-engine 导出面 × 产品消费对账。
 *
 * 口径:解析 packages/deep-engine 各子路径入口的 src index 导出符号(re-export 与
 * 直接 export),对每个符号 grep 四个消费域——apps/web/src、apps/api/src、
 * packages/scene-sdk/src、packages/deep-engine-native/src;包内自消费单独计数。
 * 零外部消费符号 = 价值审计候选清单(只列事实,删除/保留由用户裁决,本脚本不改代码)。
 *
 * 用法:node apps/web/scripts/deepEngineExportConsumptionAudit.mjs
 * 产物:test-output/z5-value-audit-20261003/export-consumption.json + stdout 摘要
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const engineSrc = resolve(repoRoot, "packages/deep-engine/src");
const outputRoot = resolve(repoRoot, "test-output/z5-value-audit-20261003");
mkdirSync(outputRoot, { recursive: true });

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 从 index.ts 提取 re-export 的源文件与符号(export {...} from / export * from)。 */
function indexExports(indexPath) {
  if (!existsSync(indexPath)) return [];
  const src = readFileSync(indexPath, "utf-8");
  const out = [];
  for (const match of src.matchAll(/export\s+\{([^}]+)\}\s+from\s+["']\.\/([^"']+)["']/g)) {
    for (const piece of match[1].split(",")) {
      const name = piece.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
      if (name && name !== "default") out.push({ name, file: match[2] });
    }
  }
  for (const match of src.matchAll(/export\s+\*\s+from\s+["']\.\/([^"']+)["']/g)) {
    out.push({ star: true, file: match[1] });
  }
  return out;
}

const enginePackage = JSON.parse(readFileSync(resolve(repoRoot, "packages/deep-engine/package.json"), "utf-8"));
const domains = {};
for (const [key, value] of Object.entries(enginePackage.exports)) {
  if (key === ".") continue;
  // exports 值为嵌套条件对象(development/types/default);递归找含 /src/ 的入口。
  const findSrcEntry = (node) => {
    if (typeof node === "string") return node.includes("/src/") || node.includes("\src\\") ? node : undefined;
    if (node && typeof node === "object") { for (const child of Object.values(node)) { const hit = findSrcEntry(child); if (hit) return hit; } }
    return undefined;
  };
  const entryFile = findSrcEntry(value);
  if (!entryFile) continue;
  const abs = resolve(repoRoot, "packages/deep-engine", entryFile);
  domains[key] = indexExports(abs);
}

const consumerRoots = {
  web: resolve(repoRoot, "apps/web/src"),
  api: resolve(repoRoot, "apps/api/src"),
  sceneSdk: resolve(repoRoot, "packages/scene-sdk/src"),
  native: resolve(repoRoot, "packages/deep-engine-native/src"),
  // H-C7 SDK 线路:8 模板与分发 skill 是 deep-engine 的第二消费方(合同消费者)。
  templates: resolve(repoRoot, "templates"),
  contracts: resolve(repoRoot, "packages/contracts/src"),
};
const consumerTexts = {};
for (const [domain, root] of Object.entries(consumerRoots)) {
  let text = "";
  for (const file of walk(root)) { try { text += readFileSync(file, "utf-8"); } catch { /* skip */ } }
  consumerTexts[domain] = text;
}
const engineText = walk(engineSrc).map(file => { try { return readFileSync(file, "utf-8"); } catch { return ""; } }).join("\n");

const rows = [];
for (const [entry, symbols] of Object.entries(domains)) {
  for (const symbol of symbols) {
    if (symbol.star) continue;
    const name = symbol.name;
    const pattern = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`);
    const consumers = Object.entries(consumerTexts)
      .filter(([, text]) => pattern.test(text))
      .map(([domain]) => domain);
    const internalUses = (engineText.match(new RegExp(pattern, "g")) ?? []).length;
    rows.push({ entry, name, externalConsumers: consumers, internalMentions: internalUses });
  }
}

const zeroExternal = rows.filter(row => row.externalConsumers.length === 0);
const summary = {
  generatedAt: new Date().toISOString(),
  entries: Object.keys(domains).length,
  totalSymbols: rows.length,
  withExternalConsumers: rows.length - zeroExternal.length,
  zeroExternalCandidates: zeroExternal.length,
};
writeFileSync(resolve(outputRoot, "export-consumption.json"), JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 1));
console.log("\n零外部消费候选(按入口分组,删除/保留由用户裁决):");
const byEntry = {};
for (const row of zeroExternal) (byEntry[row.entry] ??= []).push(row.name);
for (const [entry, names] of Object.entries(byEntry)) console.log(`  ${entry}: ${names.length} 个 -> ${names.slice(0, 8).join(", ")}${names.length > 8 ? " ..." : ""}`);
