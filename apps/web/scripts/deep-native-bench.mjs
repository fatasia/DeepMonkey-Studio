// From repository root: node apps/web/scripts/deep-native-bench.mjs [--probe|--test|--check]
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { median, parseNativeReport, tableCells } from "./deep-native-bench-metrics.mjs";
import { checkEvidence } from "./deep-native-bench-check.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = path.join(root, "test-output/deep-native-bench");
const nativeRoot = path.join(root, "packages/deep-engine-native");
const exe = path.join(nativeRoot, "target/release/deep-engine-native.exe");
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => !["--probe", "--test", "--check"].includes(arg))) {
  throw new Error("Usage: deep-native-bench.mjs [--probe|--test|--check]");
}
const probe = args.includes("--probe");
const frames = probe ? 8 : 512, warmup = probe ? 2 : 120, rounds = probe ? 1 : 3;
const rebuildCycles = probe ? 2 : 20;
const runId = new Date().toISOString().replace(/[:.]/g, "-") + (probe ? "-probe" : "");
const runDir = path.join(output, "runs", runId);
const tsx = pathToFileURL(createRequire(path.join(root, "apps/api/package.json")).resolve("tsx")).href;
const sha256 = value => createHash("sha256").update(value).digest("hex");

function execute(command, commandArgs, env = process.env) {
  return new Promise((resolve, reject) => {
    const startedMonotonicMs = performance.now();
    const child = spawn(command, commandArgs, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", firstPresent;
    child.stdout.setEncoding("utf8").on("data", text => {
      stdout += text;
      if (!firstPresent) {
        const marker = stdout.match(/^native benchmark first present: .+\r?\n/m)?.[0].trimEnd();
        if (marker) {
          const observedMonotonicMs = performance.now();
          firstPresent = { startedMonotonicMs, observedMonotonicMs,
            firstFrameMs: observedMonotonicMs - startedMonotonicMs, marker };
        }
      }
    });
    child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, firstPresent }); });
  });
}

async function runBenchmark() {
  await mkdir(runDir, { recursive: true });
  async function sourceFiles(directory) {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) result.push(...await sourceFiles(fullPath));
      else result.push(fullPath);
    }
    return result;
  }
  const sources = [...await sourceFiles(path.join(nativeRoot, "src")),
    path.join(nativeRoot, "Cargo.toml"), path.join(nativeRoot, "Cargo.lock")].sort();
  const binaryStat = await stat(exe);
  const sourceHashes = [];
  for (const file of sources) {
    if ((await stat(file)).mtimeMs > binaryStat.mtimeMs) throw new Error("Rebuild release executable; newer source: " + file);
    sourceHashes.push({ path: path.relative(root, file).replaceAll("\\", "/"), sha256: sha256(await readFile(file)) });
  }
  const binarySha256 = sha256(await readFile(exe));
  const sourceManifestBytes = JSON.stringify(sourceHashes, null, 2);
  await writeFile(path.join(runDir, "native-source-hashes.json"), sourceManifestBytes);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DEEP_ENGINE_")));
  Object.assign(env, { DEEP_ENGINE_TELEMETRY_WARMUP_FRAMES: String(warmup), DEEP_ENGINE_TELEMETRY_VIEWPORT: "1440x900" });
  const cases = [];
  for (const count of [120, 1000]) {
    const fixture = await execute(process.execPath, ["--conditions=development", "--import", tsx,
      path.join(root, "apps/web/scripts/deep-native-fixture.mts"), String(count)]);
    if (fixture.code !== 0) throw new Error("Fixture " + count + " failed: " + fixture.stderr);
    const packageName = "fixture-" + count + ".runtime-package.json";
    const packageBytes = await readFile(path.join(output, packageName));
    const pkg = JSON.parse(packageBytes);
    await writeFile(path.join(runDir, packageName), packageBytes);
    const manifestName = "fixture-" + count + ".manifest.json";
    const manifest = JSON.parse(await readFile(path.join(output, manifestName), "utf8"));
    await writeFile(path.join(runDir, manifestName), JSON.stringify(manifest, null, 2));
    for (const workload of count === 120 ? ["static"] : ["static", "dynamic", "rebuild"]) {
      const sampleFrames = workload === "rebuild" ? rebuildCycles : frames;
      const runs = [];
      for (let round = 1; round <= rounds; round++) {
        console.log("Deep Native " + workload + "/" + count + ": " + round + "/" + rounds + ", " + warmup + "+" + sampleFrames + " frames");
        const name = workload + "-" + count + "-r" + round;
        const result = await execute(exe, ["--smoke-package-telemetry", path.join(runDir, packageName)],
          { ...env, DEEP_ENGINE_BENCH_WORKLOAD: workload, DEEP_ENGINE_TELEMETRY_SAMPLE_FRAMES: String(sampleFrames) });
        await writeFile(path.join(runDir, name + ".stdout.log"), result.stdout);
        await writeFile(path.join(runDir, name + ".stderr.log"), result.stderr);
        if (result.code !== 0) throw new Error(name + " failed (" + (result.code ?? result.signal) + "); see " + runDir);
        const parsed = parseNativeReport(result.stdout, { frames: sampleFrames, warmup, count, workload, packageHash: pkg.packageHash.value });
        if (!result.firstPresent || !Number.isFinite(result.firstPresent.firstFrameMs) || result.firstPresent.firstFrameMs <= 0) {
          throw new Error(name + ": missing launch-to-first-present observation");
        }
        const launchBytes = JSON.stringify(result.firstPresent, null, 2);
        await writeFile(path.join(runDir, name + ".launch.json"), launchBytes);
        await writeFile(path.join(runDir, name + ".telemetry.json"), parsed.raw + "\n");
        runs.push({ round, evidence: "runs/" + runId + "/" + name + ".telemetry.json", evidenceSha256: sha256(parsed.raw + "\n"),
          launchEvidence: "runs/" + runId + "/" + name + ".launch.json", launchSha256: sha256(launchBytes),
          frames: parsed.frames, benchmark: { ...parsed.benchmark, firstFrameMs: result.firstPresent.firstFrameMs },
          adapter: parsed.report.adapter, build: parsed.report.build });
        console.log(JSON.stringify({ ...parsed.frames, ...runs.at(-1).benchmark }));
      }
      const values = runs.map(run => ({ ...run.frames, ...run.benchmark }));
      cases.push({ workload, objectCount: count, presentedFrames: sampleFrames, fixture: manifest,
        packageHash: pkg.packageHash.value, fileSha256: sha256(packageBytes), runs,
        median: Object.fromEntries(Object.keys(values[0]).map(key => [key, median(values.map(run => run[key]))])) });
    }
  }
  if (sha256(await readFile(exe)) !== binarySha256) throw new Error("Native executable changed during run.");
  for (const source of sourceHashes) {
    if (sha256(await readFile(path.join(root, source.path))) !== source.sha256) throw new Error("Native source changed during run: " + source.path);
  }
  if (cases.flatMap(item => item.runs).some(run => JSON.stringify(run.adapter) !== JSON.stringify(cases[0].runs[0].adapter))) {
    throw new Error("Adapter identity changed between rounds.");
  }
  const summary = { schema: "deep-engine.native-benchmark-summary", schemaVersion: 2, runId, probe,
    createdAt: new Date().toISOString(), protocol: { viewport: [1440, 900], warmupFrames: warmup,
      presentedFrames: frames, intervalSamples: frames - 1, rounds, rebuildCycles, movingObjects: 200,
      quantile: "nearest-rank ceil(n*p)-1, same as browser FrameSampler", aggregation: "median of per-run statistics; heap worst uses maximum round delta",
      timing: "web_time::Instant between surface.present calls; not compositor completion",
      firstFrame: "parent monotonic clock before spawn to first-present stdout receipt; includes process/package/device startup and IPC",
      rebuild: "20 full instance replacements, shared geometry/material resources; last cycle duration per run",
      heap: "Rust GlobalAlloc live bytes after each present; final minus warmed baseline, excludes driver/GPU/native system allocations",
      drawCalls: "actual encoded render draw commands including parallel shadows, indirect calls count once even when culled",
      gpu: "complete-frame timestamp pairs for every presented frame; includes visibility/shadows/opaque/HiZ/output, no ring truncation",
      buildFeatures: ["native-bench"], telemetry: "opt-in CPU/GPU queries plus allocator/draw observers", inheritedDeepEngineOptions: "cleared" },
    host: { platform: os.platform(), release: os.release(), architecture: os.arch(), cpu: os.cpus()[0]?.model,
      logicalProcessors: os.cpus().length, memoryBytes: os.totalmem(), node: process.version },
    executable: { path: path.relative(root, exe), sha256: binarySha256, modifiedAt: binaryStat.mtime.toISOString(),
      sourceManifest: "runs/" + runId + "/native-source-hashes.json", sourceManifestSha256: sha256(sourceManifestBytes) }, cases };
  await writeFile(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(path.join(output, probe ? "probe-summary.json" : "summary.json"), JSON.stringify(summary, null, 2));
  console.log("Evidence: " + runDir);
  if (!probe) console.log(JSON.stringify(tableCells(summary), null, 2));
}

if (args.includes("--test")) {
  const result = await execute(process.execPath, ["--conditions=development", "--import", tsx,
    "--test", path.join(root, "apps/web/scripts/deep-native-bench.test.mts")]);
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.code ?? 1;
} else if (args.includes("--check")) {
  await checkEvidence(root, output);
} else {
  await runBenchmark();
}
