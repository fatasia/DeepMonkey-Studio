#!/usr/bin/env node
// Unity 基准档编排:staging 工程 → 批处理构建播放器 → 跑 4 组配置 → 汇总行业标准指标。
// 用法:
//   node tools/unity-bench/build-unity-bench.mjs build   # staging + Unity 批处理构建
//   node tools/unity-bench/build-unity-bench.mjs run     # 播放器跑 static/dynamic × 120/1000 并汇总
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const toolRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolRoot, "../..");
const projectRoot = path.join(repoRoot, "_unity-bench", "proj");
const playerCandidates = () => [
  process.env.BENCH_PLAYER_OUT,
  path.join(projectRoot, "Builds", "bench.exe"),
  path.join(repoRoot, "_unity-bench", "Builds", "bench.exe"),
].filter(Boolean);
const findPlayer = () => playerCandidates().find(p => existsSync(p)) ?? playerCandidates()[0];
const unityExe = process.env.BENCH_UNITY ?? "D:\\Soft\\Unity\\2022.3.62f1\\Editor\\Unity.exe";
const unityVersion = "2022.3.62f1";
const mode = process.argv[2] ?? "build";

if (!existsSync(unityExe)) throw new Error(`Unity 不存在:${unityExe}(可用 BENCH_UNITY 覆盖)`);

function stage() {
  mkdirSync(path.join(projectRoot, "Assets", "Scripts"), { recursive: true });
  mkdirSync(path.join(projectRoot, "Assets", "Editor"), { recursive: true });
  mkdirSync(path.join(projectRoot, "ProjectSettings"), { recursive: true });
  mkdirSync(path.join(projectRoot, "Packages"), { recursive: true });
  cpSync(path.join(toolRoot, "Assets"), path.join(projectRoot, "Assets"), { recursive: true });
  writeFileSync(path.join(projectRoot, "ProjectSettings", "ProjectVersion.txt"),
    `m_EditorVersion: ${unityVersion}\n`);
  // 零依赖 manifest:空工程默认解析会拉进 com.unity.ads@3.7.5,与 2022.3.62 不兼容(CS0619);
  // Built-in RP + 原生图元不需要任何包。
  writeFileSync(path.join(projectRoot, "Packages", "manifest.json"), JSON.stringify({ dependencies: {} }, null, 2));
  console.log(`[unity-bench] staged ${projectRoot}`);
}

function build() {
  stage();
  const log = path.join(repoRoot, "_unity-bench", "build.log");
  mkdirSync(path.dirname(log), { recursive: true });
  // 首次运行导入工程并执行构建;第二次兜底(首次可能只完成 Library 生成)
  for (let attempt = 1; attempt <= 2; attempt++) {
    console.log(`[unity-bench] build attempt ${attempt} (log: ${log})`);
    const result = spawnSync(unityExe, [
      "-batchmode", "-quit", "-projectPath", projectRoot,
      "-executeMethod", "BenchBuild.BuildAndQuit",
      "-logFile", log,
    ], { stdio: "inherit" });
    if (result.status === 0) {
      const player = findPlayer();
      if (player && existsSync(player)) { console.log(`[unity-bench] player ready: ${player} (unity exit=0)`); return; }
    }
    console.warn(`[unity-bench] attempt ${attempt} exit=${result.status}`);
  }
  throw new Error(`Unity 构建失败,见 ${log}`);
}

function percentile(sorted, ratio) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

function summarize(label, file) {
  const { frameMs, workload, objectCount, firstFrameMs, gpuP50Ms, rebuildP50Ms, rebuildHeapWorstMiB } = JSON.parse(readFileSync(file, "utf8"));
  const sorted = [...frameMs].sort((a, b) => a - b);
  const n = sorted.length;
  const worst = sorted.slice(Math.max(0, n - Math.max(1, Math.round(n * 0.01))));
  const avg = list => list.reduce((sum, v) => sum + v, 0) / (list.length || 1);
  const median = sorted[Math.floor(n / 2)] ?? 0;
  const row = {
    label, workload, objectCount, samples: n,
    firstFrameMs, gpuP50Ms, rebuildP50Ms, rebuildHeapWorstMiB,
    p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1) ?? 0,
    low1Fps: 1000 / avg(sorted.slice(Math.max(0, n - Math.max(1, Math.round(n * 0.01))))),
    jankOver16_7: sorted.filter(v => v > 16.7).length,
    jankOver20: sorted.filter(v => v > 20).length,
    jankOver2xMedian: sorted.filter(v => v > 2 * median).length,
  };
  void worst; void avg; // low1Fps 已内联;保留 worst 语义注释
  return row;
}

function run() {
  const playerPath = findPlayer();
  if (!playerPath || !existsSync(playerPath)) throw new Error(`播放器不存在:${playerCandidates().join(", ")},先执行 build`);
  const configs = [
    { workload: "static", count: 120 }, { workload: "dynamic", count: 120 },
    { workload: "static", count: 1000 }, { workload: "dynamic", count: 1000 },
  ];
  const rows = [];
  const outDir = path.join(repoRoot, "test-output", "unity-native-bench");
  mkdirSync(outDir, { recursive: true });
  for (const config of configs) {
    const file = path.join(outDir, `frames-${config.workload}-${config.count}.json`);
    console.log(`[unity-bench] run ${config.workload} ${config.count} -> ${file}`);
    const result = spawnSync(playerPath, [
      "-frames", "600", "-workload", config.workload, "-count", String(config.count), "-out", file,
    ], { stdio: "inherit" });
    if (result.status !== 0 || !existsSync(file)) throw new Error(`播放器运行失败:${config.workload}/${config.count}`);
    rows.push(summarize(`unity-mono/${config.workload}/${config.count}`, file));
  }
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(rows, null, 2));
  console.table(rows);
}

if (mode === "build") build();
else if (mode === "run") run();
else throw new Error(`未知模式:${mode}(build|run)`);
