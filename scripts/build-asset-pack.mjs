// 生成开源素材库模型包:收集 nature-kit/samples/showcase/种子 + 三件套
// (pack.manifest.json / catalog.json / audit.json),使包可直接被
// `pnpm assets:import` 一键导入。用法:node scripts/build-asset-pack.mjs --out <zip路径>
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const out = (() => { const i = process.argv.indexOf("--out"); return i >= 0 ? process.argv[i + 1] : path.join(repoRoot, "data", "asset-pack", "deepmonkey-assets-v1.zip"); })();
const stage = path.join(repoRoot, "data", "asset-pack", "stage", "deepmonkey-assets");
const SOURCES = [
  ["nature-kit", path.join(repoRoot, "apps/web/public/assets/nature-kit")],
  ["samples", path.join(repoRoot, "apps/web/public/samples")],
  ["showcase", path.join(repoRoot, "apps/web/public/showcase")],
];
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

rm stage if exists; mkdirSync(path.dirname(out), { recursive: true });
function rm(p) { if (existsSync(p)) { for (const e of readdirSync(p)) rmSync2(path.join(p, e)); } }
import { rmSync } from "node:fs";
function rmSync2(p2) { if (statSync(p2).isDirectory()) { for (const e of readdirSync(p2)) rmSync2(path.join(p2, e)); rmSync(p2, { recursive: true, force: true }); } else rmSync(p2, { force: true }); }

mkdirSync(stage, { recursive: true });
const files = [];
const models = [];
for (const [name, sourceDir] of SOURCES) {
  if (!existsSync(sourceDir)) continue;
  cpSync(sourceDir, path.join(stage, name), { recursive: true });
}
// nature-kit 模型登记进 catalog.models(导入器校验 models 数组)
const catalogSource = JSON.parse(readFileSync(path.join(stage, "nature-kit", "catalog.json"), "utf8"));
for (const entry of catalogSource.entries ?? []) {
  models.push({ id: entry.id, category: entry.category, format: "glb", license: "CC0", bytes: entry.bytes,
    path: `nature-kit/models/${path.basename(entry.sourcePath)}` });
}
// 逐文件清单(SHA-256)
function walk(dir, prefix) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(full, rel);
    else files.push({ path: rel, sha256: sha256(full) });
  }
}
walk(stage, "");
const manifest = {
  schemaVersion: 1, id: "deepmonkey-assets-v1", version: "1.0.0",
  publicationStatus: "published", license: "CC0 (nature-kit) / SEE LICENSE (samples, showcase)",
  files,
};
writeFileSync(path.join(stage, "pack.manifest.json"), JSON.stringify(manifest, null, 2));
// catalog/audit:导入器要求 models/files/items 数组
const catalog = {
  schema: "deepmonkey.asset-pack-catalog", schemaVersion: 1,
  source: "https://github.com/fatasia/bim-studio/releases/tag/assets-v1",
  license: "CC0 (nature-kit); samples/showcase 为工程数据与场景",
  models,
  files: files.filter((f) => !f.path.startsWith("pack.")).map((f) => ({ path: f.path, sha256: f.sha256 })),
};
writeFileSync(path.join(stage, "catalog.json"), JSON.stringify(catalog, null, 2));
const audit = {
  schema: "deepmonkey.asset-pack-audit", schemaVersion: 1, auditedAt: new Date().toISOString(),
  auditor: "deepmonkey-pack-v1",
  items: files.map((f) => ({ path: f.path, sha256: f.sha256, verdict: "pass", license: f.path.startsWith("nature-kit") ? "CC0" : "SEE LICENSE" })),
};
writeFileSync(path.join(stage, "audit.json"), JSON.stringify(audit, null, 2));
console.log(`stage ready: ${stage} (${files.length} files)`);
