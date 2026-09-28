import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactSha256, wasmSourceFingerprint } from "./lib/wasmArtifactFingerprint.mjs";
import { checkTsDistFreshness } from "./lib/tsArtifactFreshness.mjs";

/**
 * 运行时产物新鲜度门禁。
 *
 * 背景(2026-09-25 两次实锤回归):runtimePackage schema 增加顶层字段后,
 * ① apps/web 引用的 deep-engine dist 未重建 → scripts 子进程解析新包报
 *    "unknown field";② public/engine-wasm 的 wasm 二进制未重建 → Deep WASM
 *    切换整链失败。二者都只在集成运行时爆,单测全绿。
 *
 * 门禁规则:在内存中按真实 tsconfig 编译 contracts 与 deep-engine,逐文件核对完整 dist
 * (JS 运行语义与 d.ts ABI,覆盖 V1/V2/V3/V4/V5/V7),无需改写并发构建产物。
 * WASM 继续核对 Rust 来源、四产物哈希、schema 字段探针与 Web 桥声明。
 */

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const TYPES = path.join(repoRoot, "packages/deep-engine/src/runtimePackage/types.ts");
const WASM = path.join(repoRoot, "apps/web/public/engine-wasm/deep_engine_wasm_bg.wasm");
const WASM_DIR = path.dirname(WASM);
const MANIFEST = path.join(WASM_DIR, "deep_engine_wasm.manifest.json");
const BRIDGE = path.join(repoRoot, "apps/web/src/viewer/StudioDeepWasmBridge.ts");
const WASM_ARTIFACT_FILES = ["deep_engine_wasm_bg.wasm", "deep_engine_wasm.js", "deep_engine_wasm.d.ts", "deep_engine_wasm_bg.wasm.d.ts"];

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
  const stale = [];
  for (const name of ["contracts", "deep-engine"]) {
    const result = await checkTsDistFreshness(repoRoot, name);
    stale.push(...result.stale);
  }
  for (const field of fields) {
    if (!await containsBytes(WASM, field)) stale.push({ artifact: "wasm bundle", field,
      hint: "node scripts/build-wasm-bundle.mjs" });
  }
  let manifest;
  try { manifest = JSON.parse(await readFile(MANIFEST, "utf8")); } catch { /* older bundle */ }
  const source = wasmSourceFingerprint(repoRoot);
  if (manifest?.schemaVersion !== 1 || manifest.source?.sha256 !== source.sha256) {
    stale.push({ artifact: "wasm bundle", field: "Rust source fingerprint",
      hint: "node scripts/build-wasm-bundle.mjs" });
  }
  if (manifest?.profile !== "wasm-release" || manifest.target !== "wasm32-unknown-unknown" || manifest.features !== null) {
    stale.push({ artifact: "wasm bundle", field: "product profile/target/features",
      hint: "node scripts/build-wasm-bundle.mjs" });
  }
  for (const file of WASM_ARTIFACT_FILES) {
    const expected = manifest?.artifacts?.[file];
    try {
      if (artifactSha256(path.join(WASM_DIR, file)) === expected) continue;
    } catch { /* missing artifact */ }
    stale.push({ artifact: "wasm bundle", field: `${file} SHA-256`, hint: "node scripts/build-wasm-bundle.mjs" });
  }
  if (!manifest?.artifacts || Object.keys(manifest.artifacts).length !== WASM_ARTIFACT_FILES.length || WASM_ARTIFACT_FILES.some(file => typeof manifest.artifacts[file] !== "string")) {
    stale.push({ artifact: "wasm bundle", field: "JS/wasm/type artifact manifest",
      hint: "node scripts/build-wasm-bundle.mjs" });
  }
  const generatedTypes = await readFile(path.join(WASM_DIR, "deep_engine_wasm.d.ts"), "utf8").catch(() => "");
  const bridgeSource = await readFile(BRIDGE, "utf8");
  const bridgeInterface = bridgeSource.match(/export interface DeepWasmRuntimeModule \{([\s\S]*?)\n\}/)?.[1] ?? "";
  for (const [, name] of bridgeInterface.matchAll(/^\s+(\w+)\??\(/gm)) {
    if (name !== "default" && !generatedTypes.includes(`export function ${name}(`)) {
      stale.push({ artifact: "wasm ABI", field: name, hint: "rebuild wasm and synchronize StudioDeepWasmBridge.ts" });
    }
  }
  return { ok: stale.length === 0, stale, checked: fields };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = await checkRuntimeArtifactFreshness();
  if (!result.ok) {
    console.error("运行时产物陈旧(先于集成运行时就该拦下):");
    for (const item of result.stale) console.error(`- [${item.artifact}] ${item.field};修复: ${item.hint}`);
    process.exit(1);
  }
  console.log(`运行时产物新鲜度通过(contracts/deep-engine 全量 TS 产物、${result.checked.length} 个 WASM 包字段与 hash/桥 ABI)。`);
}
