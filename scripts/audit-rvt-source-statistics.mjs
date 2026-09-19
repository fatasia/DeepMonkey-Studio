#!/usr/bin/env node
/**
 * DE26/A08 源级 RVT 统计审计(离线、本地、确定性)。
 *
 * 流程:离线构建 rvt-rs(lib)→ rustc 编译统计探针与单测 → 对每个输入
 * 运行两次并校验报告/输出确定性 → 校验诚实合同(statistics.unmeasured
 * 必须声明 triangles/meshes/textures)→ 生成 evidence.json。
 *
 * 用法: node scripts/audit-rvt-source-statistics.mjs <input.rvt...> --output <dir>
 *   [--reader <rvt-rs root>]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const rawArgs = process.argv.slice(2);
const cleaned = [];
for (let i = 0; i < rawArgs.length; i += 1) {
  if (rawArgs[i] === "--output") { i += 1; continue; }
  if (rawArgs[i] === "--reader") { i += 1; continue; }
  cleaned.push(rawArgs[i]);
}
const outputIndex = rawArgs.indexOf("--output");
if (outputIndex < 0 || !rawArgs[outputIndex + 1]) throw new Error("usage: audit-rvt-source-statistics.mjs <input.rvt...> --output <dir> [--reader <dir>]");
const outputDirectory = path.resolve(root, rawArgs[outputIndex + 1]);
const readerIndex = rawArgs.indexOf("--reader");
const readerRoot = path.resolve(root, readerIndex >= 0 ? rawArgs[readerIndex + 1] : "data/external-assets/industrial-format-plan/samples/extracted/rvt-rs-main");
const inputs = cleaned;
if (inputs.length === 0) throw new Error("no input files");
if (existsSync(outputDirectory)) throw new Error("Use a new evidence directory; existing evidence is immutable.");

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const run = (command, argv, options = {}) => {
  const result = spawnSync(command, argv, { cwd: root, encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
};
const fail = (message, result) => {
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  throw new Error(message);
};

mkdirSync(outputDirectory, { recursive: true });
const buildPath = path.join(outputDirectory, "build");
const sourcePath = path.join(root, "scripts/fixtures/rvt-source-statistics.rs");
const manifestPath = path.join(readerRoot, "Cargo.toml");

const cargo = run("cargo", ["build", "--offline", "--locked", "--profile", "ci", "--lib", "--manifest-path", manifestPath, "--target-dir", buildPath]);
if (cargo.status !== 0) fail("Offline reader build failed", cargo);
const depsPath = path.join(buildPath, "ci", "deps");
const externs = [];
for (const name of ["rvt", "serde_json", "sha2", "flate2"]) {
  const matches = readdirSync(depsPath)
    .filter((file) => (file === `lib${name}.rlib` || (file.startsWith(`lib${name}-`) && file.endsWith(".rlib"))));
  if (matches.length !== 1) throw new Error(`Ambiguous/missing compiled library: ${name} (${matches.join(", ")})`);
  externs.push("--extern", `${name}=${path.join(depsPath, matches[0])}`);
}
const linkerArgs = ["-L", `dependency=${depsPath}`];
const exePath = path.join(outputDirectory, "rvt-source-statistics.exe");
const testPath = path.join(outputDirectory, "rvt-source-statistics-tests.exe");
const compile = run("rustc", ["--edition=2024", sourcePath, ...externs, ...linkerArgs, "-o", exePath]);
if (compile.status !== 0) fail("Statistics probe compile failed", compile);
const compileTests = run("rustc", ["--edition=2024", "--test", sourcePath, ...externs, ...linkerArgs, "-o", testPath]);
if (compileTests.status !== 0) fail("Statistics probe test compile failed", compileTests);
const testRun = run(testPath, []);
if (testRun.status !== 0) fail("Statistics probe tests failed", testRun);
process.stdout.write(testRun.stdout.split(/\r?\n/).filter((line) => line.startsWith("test result")).join("\n") + "\n");

const rustcVersion = run("rustc", ["--version"]).stdout.trim();
const results = [];
for (const inputFile of inputs) {
  const inputPath = path.resolve(inputFile);
  if (!existsSync(inputPath)) throw new Error(`input not found: ${inputPath}`);
  const before = sha256(inputPath);
  const reportPath = path.join(outputDirectory, `${before}.json`);
  const repeatPath = path.join(outputDirectory, `${before}.repeat.json`);
  const first = run(exePath, [inputPath, reportPath], { timeout: 600_000 });
  if (first.status !== 0) fail(`probe failed for ${inputPath}`, first);
  const second = run(exePath, [inputPath, repeatPath], { timeout: 600_000 });
  if (second.status !== 0) fail(`repeat probe failed for ${inputPath}`, second);
  if (first.stdout !== second.stdout) throw new Error("Nondeterministic statistics stdout");
  const after = sha256(inputPath);
  const reportHash = sha256(reportPath);
  if (before !== after || reportHash !== sha256(repeatPath)) throw new Error("Source changed or nondeterministic statistics report");
  rmSync(repeatPath, { force: true });
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (report.schemaVersion !== 1 || report.scope !== "source-statistics-aggregate"
    || report.sourceSha256 !== before || report.quality !== "inspect") throw new Error("Invalid source/quality contract");
  // 诚实条款:builtin 读取器没有 tessellation,报告不得携带实测的
  // triangles/meshes/textures,必须显式声明 unmeasured。
  const unmeasured = Array.isArray(report.statistics?.unmeasured) ? report.statistics.unmeasured : [];
  for (const field of ["triangles", "meshes", "textures"]) {
    if (!unmeasured.includes(field)) throw new Error(`statistics.unmeasured must declare ${field}`);
  }
  process.stdout.write(first.stdout + "\n");
  results.push({
    sourcePath: inputPath,
    sourceBytes: statSync(inputPath).size,
    sourceSha256: before,
    reportSha256: reportHash,
    status: report.status,
    version: report.revitVersion,
    build: report.build ?? null,
    guid: report.guid ?? null,
    statistics: {
      declaredElementIds: report.statistics.declaredElementIds ?? null,
      exportedInstanceIds: report.statistics.exportedInstanceIds ?? null,
      exportedInstanceIdsGeometryValidated: report.statistics.exportedInstanceIdsGeometryValidated ?? null,
      levelDistinctNames: report.statistics.levelDistinctNames ?? null,
      strictMaterialNameCount: report.statistics.strictMaterialNameCount ?? null,
      strictRoomNameCount: report.statistics.strictRoomNameCount ?? null,
      modelBBoxMinMeters: report.statistics.modelBBoxMinMeters ?? null,
      modelBBoxMaxMeters: report.statistics.modelBBoxMaxMeters ?? null,
      unmeasured,
    },
    failures: report.failures ?? [],
  });
}

const hashPaths = [
  sourcePath,
  fileURLToPath(import.meta.url),
  manifestPath,
  path.join(readerRoot, "Cargo.lock"),
  exePath,
];
const walk = (current) => {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) walk(full);
    else hashPaths.push(full);
  }
};
walk(path.join(readerRoot, "src"));
const evidence = {
  schemaVersion: 1,
  scope: "source-statistics-aggregate",
  rustc: rustcVersion,
  files: hashPaths.map((file) => ({ path: file, sha256: sha256(file) })),
  results,
};
const evidencePath = path.join(outputDirectory, "evidence.json");
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ evidence: evidencePath, results: results.map((r) => ({ source: r.sourcePath, status: r.status, version: r.version })) }));
