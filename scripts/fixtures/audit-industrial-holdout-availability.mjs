import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";

// ⑦ 保留集可用性审计:对每个工业 profile,盘点样本池、与既有证据绑定的 SHA-256
// 求交集,得出"未用样本数"(= 未来保留集/晋升验证的可用语料)。SHA 比对是强制剔重步骤
// (2026-09-19 RVT 保留集教训:B示例模型.rvt 即改名重复样本)。

const root = process.cwd();
const externalRoot = path.join(root, "data/external-assets");
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const PROFILES = [
  { id: "bim.xt-builtin", dirs: ["industrial-format-plan/samples/extracted", "industrial-format-plan/samples/downloaded"], exts: [".x_t", ".x_b"] },
  { id: "bim.3dm-builtin", dirs: ["format-fixtures/3dm", "industrial-format-plan/samples/extracted"], exts: [".3dm"] },
  { id: "bim.jt-builtin", dirs: ["format-fixtures/jt", "format-research/dxjt-toolkit/samples"], exts: [".jt"] },
  { id: "bim.solidworks-builtin", dirs: ["industrial-format-plan/samples/solidworks-sheetmetal-20260918"], exts: [".sldprt", ".sldasm"] },
  { id: "bim.rvt-builtin", dirs: ["industrial-format-plan/samples/rvt", "industrial-format-plan/samples/extracted"], exts: [".rvt"] },
  { id: "bim.pointcloud-builtin", dirs: ["industrial-format-plan/samples/pointcloud", "industrial-format-plan/samples/extracted/libE57Format-test-data"], exts: [".e57", ".las", ".laz", ".copc"] },
  { id: "bim.3dtiles-builtin", dirs: ["industrial-format-plan/samples/extracted/3d-tiles-samples"], exts: [".json", ".b3dm", ".pnts", ".glb", ".i3dm", ".cmpt"] },
];

function collect(dir, exts, out, depth = 0) {
  if (depth > 4 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, exts, out, depth + 1);
    else if (exts.includes(path.extname(entry.name).toLowerCase())) out.push(full);
  }
}

// 已绑定语料:26 份 S1–S6 证据绑定 + ⑧ 源级审计 + RVT 保留集
const bound = new Set();
const boundSources = [];
const bindingPath = path.join(root, "test-output/industrial-s1-s6-evidence-binding-20260919/evidence.json");
if (existsSync(bindingPath)) {
  const matches = JSON.stringify(JSON.parse(readFileSync(bindingPath, "utf8"))).match(/[0-9a-f]{64}/g) ?? [];
  for (const hash of matches) bound.add(hash);
  boundSources.push("industrial-s1-s6-evidence-binding-20260919");
}
for (const rel of [
  "test-output/de26-rvt-source-audit-20260919-r5/evidence.json",
  "test-output/industrial-rvt-holdout-20260919/evidence.json",
]) {
  const full = path.join(root, rel);
  if (existsSync(full)) {
    for (const hash of JSON.stringify(JSON.parse(readFileSync(full, "utf8"))).match(/[0-9a-f]{64}/g) ?? []) bound.add(hash);
    boundSources.push(rel);
  }
}

const report = { schema: "deep-engine.industrial-holdout-availability.v1", generatedAt: new Date().toISOString(), boundEvidenceSources: boundSources, boundShaCount: bound.size, profiles: [] };

for (const profile of PROFILES) {
  const files = [];
  for (const dir of profile.dirs) collect(path.join(externalRoot, dir), profile.exts, files);
  const seen = new Map();
  let duplicates = 0;
  const unused = [];
  let boundCount = 0;
  for (const file of files) {
    const hash = sha256(file);
    if (seen.has(hash)) { duplicates += 1; continue; }
    seen.set(hash, file);
    if (bound.has(hash)) boundCount += 1;
    else unused.push({ file: path.relative(root, file), sha256: hash });
  }
  report.profiles.push({
    id: profile.id,
    totalFiles: files.length,
    uniqueBySha: seen.size,
    duplicates: duplicates,
    boundInEvidence: boundCount,
    unusedAvailable: unused.length,
    unusedSample: unused.slice(0, 5),
    holdoutReady: unused.length >= 3,
  });
}

report.evidenceBoundary = "可用性盘点以 SHA-256 为准;未用样本进入保留集前仍需逐个记录来源与授权边界";
const outDir = path.join(root, "test-output/industrial-holdout-availability-20260919");
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.profiles.map(({ id, uniqueBySha, boundInEvidence, unusedAvailable, holdoutReady }) => ({ id, uniqueBySha, boundInEvidence, unusedAvailable, holdoutReady })), null, 1));
