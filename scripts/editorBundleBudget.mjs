#!/usr/bin/env node
/**
 * 编辑器主链 chunk 体积门禁（批次 F 启动性能防回归）。
 * 读取 apps/web/dist/.vite/manifest.json，对编辑器首屏关键链（入口→App chunk 与其
 * 静态 imports 闭包）断言单 chunk 与链路总量的字节上限。上限依据 2026-09-21 实测基线
 * （入口 24KB、App 252KB、主链总量 < 2MB——大依赖 three/monaco/rapier/fragments 全部
 * 已懒加载，超限即意味着有人把重依赖拉回了主链）。产物缺失时跳过（dev/未构建场景）。
 */
import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, ".."); // scripts/ 位于仓库根下一级
const manifestPath = resolve(repoRoot, "apps/web/dist/.vite/manifest.json");

if (!existsSync(manifestPath)) {
  console.log("editor-bundle-budget: dist manifest not found; skipping (build apps/web first).");
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const sizeOf = file => {
  try { return statSync(resolve(repoRoot, "apps/web/dist", file)).size; } catch { return 0; }
};

const entry = Object.values(manifest).find(item => item.isEntry);
if (!entry) { console.error("editor-bundle-budget: no entry in manifest."); process.exit(1); }

// 关键链 = 入口 + 其全部静态 imports（动态 import 的懒加载 chunk 不计入——那是设计）。
const chain = new Map();
const walk = file => {
  if (chain.has(file)) return;
  const item = Object.values(manifest).find(v => v.file === file);
  if (!item) return;
  chain.set(file, sizeOf(resolve(repoRoot, "apps/web/dist", file).replace(/\\/g, "/")) || sizeOf(file.replace(/^\//, "")));
  for (const imported of item.imports ?? []) walk(imported);
};
walk(entry.file);

// App chunk（编辑器首屏的动态 import 目标）与其静态 imports 也纳入——它是首屏主链。
const appItem = Object.entries(manifest).find(([key]) => key === "src/App.tsx");
if (appItem) walk(appItem[1].file);

const total = [...chain.values()].reduce((sum, value) => sum + value, 0);
const LIMIT_ENTRY_BYTES = 128 * 1024;
const LIMIT_CHAIN_BYTES = 3 * 1024 * 1024;

const failures = [];
if (chain.get(entry.file) > LIMIT_ENTRY_BYTES) failures.push(`entry chunk ${entry.file} exceeds ${LIMIT_ENTRY_BYTES}`);
if (total > LIMIT_CHAIN_BYTES) failures.push(`static main chain total ${(total / 1024).toFixed(0)}KB exceeds ${LIMIT_CHAIN_BYTES / 1024}KB`);

console.log(`editor-bundle-budget: entry=${(chain.get(entry.file) / 1024).toFixed(0)}KB chain(${chain.size} chunks)=${(total / 1024).toFixed(0)}KB`);
if (failures.length > 0) {
  console.error("editor-bundle-budget FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("editor-bundle-budget: PASSED");
