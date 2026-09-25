import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 运行时产物新鲜度门禁。
 *
 * 背景(2026-09-25 两次实锤回归):runtimePackage schema 增加顶层字段后,
 * ① apps/web 引用的 deep-engine dist 未重建 → scripts 子进程解析新包报
 *    "unknown field";② public/engine-wasm 的 wasm 二进制未重建 → Deep WASM
 *    切换整链失败。二者都只在集成运行时爆,单测全绿。
 *
 * 门禁规则:以 src/runtimePackage/types.ts 中声明的包顶层可选字段为准,
 * 要求 (a) dist/runtimePackage 产物与 (b) wasm 二进制(Rust serde 错误消息
 * 内嵌字段清单,可作字符串探针)都包含这些字段名。任一缺失=产物陈旧,
 * 提示重建命令。空字段集(如 schema 冻结期)时门禁空过。
 */

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const TYPES = path.join(repoRoot, "packages/deep-engine/src/runtimePackage/types.ts");
const DIST_DIR = path.join(repoRoot, "packages/deep-engine/dist/runtimePackage");
const WASM = path.join(repoRoot, "apps/web/public/engine-wasm/deep_engine_wasm_bg.wasm");

/** 包顶层字段声明的稳定探针:types.ts 中 `readonly <name>?:` 或 `readonly <name>:` 的字段名集合。 */
async function topLevelRuntimePackageFields() {
  const source = await readFile(TYPES, "utf8");
  const blockStart = source.indexOf("export interface DeepRuntimePackageV1 {");
  if (blockStart < 0) return [];
  const blockEnd = source.indexOf("\n}", blockStart);
  const block = source.slice(blockStart, blockEnd);
  return [...block.matchAll(/readonly (\w+)\??:/g)].map(match => match[1])
    .filter(name => !["schema", "schemaVersion"].includes(name));
}

async function containsBytes(filePath, needle) {
  try { await stat(filePath); } catch { return false; }
  const handle = await import("node:fs/promises").then(mod => mod.open(filePath, "r"));
  try {
    const { size } = await handle.stat();
    const needleBytes = Buffer.from(needle, "utf8");
    const chunkSize = 8 * 1024 * 1024;
    let tail = Buffer.alloc(0);
    for (let offset = 0; offset < size; offset += chunkSize) {
      const length = Math.min(chunkSize, size - offset);
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, offset);
      const haystack = Buffer.concat([tail, chunk]);
      if (haystack.includes(needleBytes)) return true;
      tail = haystack.subarray(haystack.length - needleBytes.length);
    }
    return false;
  } finally { await handle.close(); }
}

export async function checkRuntimeArtifactFreshness() {
  const fields = await topLevelRuntimePackageFields();
  if (fields.length === 0) return { ok: true, skipped: "types.ts 未声明包顶层字段", stale: [] };
  const stale = [];
  // 桶文件不承载字段名,扫描目录下全部编译产物。
  let distSource = "";
  try {
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(DIST_DIR)).filter(name => name.endsWith(".js"));
    distSource = (await Promise.all(files.map(name => readFile(path.join(DIST_DIR, name), "utf8")))).join(String.fromCharCode(10));
  } catch { distSource = ""; }
  for (const field of fields) {
    if (!distSource.includes(field)) stale.push({ artifact: "deep-engine dist", field,
      hint: "pnpm --filter @bim-studio/deep-engine build" });
  }
  for (const field of fields) {
    if (!await containsBytes(WASM, field)) stale.push({ artifact: "wasm bundle", field,
      hint: "node scripts/build-wasm-bundle.mjs" });
  }
  return { ok: stale.length === 0, stale, checked: fields };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = await checkRuntimeArtifactFreshness();
  if (!result.ok) {
    console.error("运行时产物陈旧(先于集成运行时就该拦下):");
    for (const item of result.stale) console.error(`- [${item.artifact}] 缺字段 ${item.field};修复: ${item.hint}`);
    process.exit(1);
  }
  console.log(`运行时产物新鲜度通过(检查 ${result.checked.length} 个包顶层字段)。`);
}
