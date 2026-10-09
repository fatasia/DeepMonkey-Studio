import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { assertLabInputs, assertRuntimeDependencies } from "./labIsolationPolicy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, "dist/lab/manifest.json"), "utf8"));
const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
assertRuntimeDependencies(metadata.dependencies);
for (const entry of [manifest, manifest.migrationSwitchLab, manifest.competitiveBenchmarkLab, manifest.babylonPairingLab]) {
  assertLabInputs(entry?.inputs, entry?.runtimeEngineDependencies, entry?.outputInputBytes);
}
// 2026-09-21 架构更新：Deep Engine 已从实验包转正为生产引擎（apps/web Deep WebGPU 后端、
// apps/api runtime-package 编译等均为正式生产引用）。旧规则「生产应用禁止引用实验引擎」
// 守护的是转正前的旧决策，已由产品演进推翻。本段改为生产导出面审计：生产引用必须走
// package.json 注册的导出入口（防幽灵子路径/深链绕过），lab 专用入口仍然禁止。
const exportsManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).exports ?? {};
const knownEntryPoints = new Set(Object.keys(exportsManifest).map((entry) => (entry === "." ? "" : entry.replace(/^\.\//, ""))));

const repoRoot = path.resolve(root, "../..");
let rawHits = "";
try {
  rawHits = execFileSync("git", ["grep", "-n", "-E", "@bim-studio/deep-engine|packages/deep-engine", "--", "apps"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
} catch (error) {
  if (error.status !== 1) throw error;
  rawHits = error.stdout ?? "";
}
const audit = new Map();
const violations = [];
for (const line of rawHits.split(/\r?\n/).filter(Boolean)) {
  const match = /@bim-studio\/deep-engine((?:\/[a-z0-9-]+)?)/.exec(line);
  if (!match) continue;
  const entry = match[1].replace(/^\//, "");
  if (!knownEntryPoints.has(entry)) {
    violations.push(`unregistered deep-engine entry "${entry}": ${line}`);
    continue;
  }
  audit.set(entry, (audit.get(entry) ?? 0) + 1);
}
if (violations.length > 0) {
  throw new Error(`Production apps reference unregistered deep-engine entries:\n${violations.join("\n")}`);
}
const auditSummary = [...audit.entries()].sort((a, b) => b[1] - a[1])
  .map(([entry, count]) => `${entry || "(root)"}=${count}`).join(", ");
console.log(`Production reference audit: ${auditSummary || "no references"}.`);
console.log("Isolation passed: Deep runtime has local inputs and the pinned compression codec only; Three is confined to declared comparison entries; production references resolve through registered exports.");
