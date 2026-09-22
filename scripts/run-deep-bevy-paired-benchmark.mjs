import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeRawRun } from "./lib/bevy019BenchmarkEvidence.mjs";
import { createDeepBevyFixture, fixtureDescriptor } from "./lib/deepBevyBenchmarkFixture.mjs";
import { measurements, pairedReport, parseDeepTelemetry } from "./lib/deepBevyPairedEvidence.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const options = parseArgs(process.argv.slice(2));
const local = process.env.LOCALAPPDATA;
if (!local) throw new Error("LOCALAPPDATA is required");
const cache = path.resolve(process.env.DEEP_BEVY_BENCHMARK_CACHE_ROOT
  ?? path.join(local, "bim-studio-benchmarks", "deep-vs-bevy-0.19.1"));
assertExternal(cache);
const bevyCache = path.resolve(process.env.BEVY_BENCHMARK_CACHE_ROOT
  ?? path.join(local, "bim-studio-benchmarks", "bevy-0.19.1"));
assertExternal(bevyCache);
const directories = { cache, cargoHome: path.join(cache, "cargo-home"), deepTarget: path.join(cache, "deep-target"),
  tmp: path.join(cache, "tmp"), fixtures: path.join(cache, "fixtures"), raw: path.join(cache, "raw") };
await Promise.all(Object.values(directories).map(value => mkdir(value, { recursive: true })));
const packet = createDeepBevyFixture(options.instances), fixture = fixtureDescriptor(packet);
const packetPath = path.join(directories.fixtures, `cubes-${options.instances}.json`);
await writeFile(packetPath, JSON.stringify(packet));
const deepExecutable = path.join(directories.deepTarget, "release", "deep-engine-native.exe");
const bevyExecutable = path.join(bevyCache, "target", "release", "deep-bevy-benchmark-runner.exe");
if (!options.skipBuild) buildExecutables();
const settings = { width: 1280, height: 720, warmupFrames: options.warmupFrames,
  sampleFrames: options.sampleFrames, instances: options.instances, msaaSamples: 4,
  camera: { yaw: 0.55, pitch: 0, distance: 4, focal: 2.05, near: 0.1, far: 100 },
  qualityProfile: "pbr-forward-hdr-tonemapped" };
const rounds = [], rawFiles = [];
for (let index = 0; index < options.rounds; index += 1) {
  const round = index + 1, order = index % 2 ? ["reference", "candidate"] : ["candidate", "reference"];
  let candidate, reference;
  for (const side of order) {
    if (side === "candidate") candidate = await runDeep(round);
    else reference = await runBevy(round);
  }
  rounds.push({ round, order, candidate: candidate.measurements, reference: reference.measurements,
    raw: { candidate: candidate.raw, reference: reference.raw } });
}
const firstDeep = rounds[0].raw.candidate;
const firstBevy = rounds[0].raw.reference;
const environment = { platform: process.platform, arch: process.arch,
  candidate: firstDeep.report.adapter, reference: firstBevy.environment.gpu,
  viewport: [settings.width, settings.height] };
const report = pairedReport({ rounds, fixture, settings, environment,
  provenance: { runner: "scripts/run-deep-bevy-paired-benchmark.mjs", packetPath,
    cache, rawFiles, generatedAt: new Date().toISOString() } });
const output = path.resolve(root, options.output);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, readiness: report.readiness, fixture, rounds: rounds.length }, null, 2));
if (options.requireComplete && report.readiness.status !== "raw-complete") process.exitCode = 2;

async function runDeep(round) {
  const env = { DEEP_ENGINE_TELEMETRY_WARMUP_FRAMES: String(options.warmupFrames),
    DEEP_ENGINE_TELEMETRY_SAMPLE_FRAMES: String(options.sampleFrames), DEEP_ENGINE_TELEMETRY_VIEWPORT: "1280x720" };
  const result = await runMonitored(deepExecutable, ["--smoke-telemetry", packetPath], env, `round-${round}-deep`);
  const parsed = parseDeepTelemetry(result.stdout);
  const rawPath = path.join(directories.raw, `round-${round}-deep.json`);
  await writeFile(rawPath, `${JSON.stringify(parsed.report, null, 2)}\n`);
  rawFiles.push(rawPath, ...result.rawFiles);
  return { measurements: measurements(parsed.frame, parsed.gpu, { peakHostBytes: result.metrics.peakHostBytes,
    peakGpuBytes: result.metrics.peakGpuBytes }), raw: { ...parsed, processMetrics: result.metrics } };
}

async function runBevy(round) {
  const rawPath = path.join(directories.raw, `round-${round}-bevy.json`);
  const result = await runMonitored(bevyExecutable, ["--output", rawPath, "--warmup-frames", String(options.warmupFrames),
    "--sample-frames", String(options.sampleFrames), "--instances", String(options.instances), "--hidden"],
  { WGPU_BACKEND: "vulkan" }, `round-${round}-bevy`);
  const raw = JSON.parse(await readFile(rawPath, "utf8"));
  rawFiles.push(rawPath, ...result.rawFiles);
  const normalized = normalizeRawRun(raw, { rawPath });
  return { measurements: { ...normalized.measurements, "peak-host-bytes": result.metrics.peakHostBytes,
    "peak-gpu-bytes": result.metrics.peakGpuBytes }, raw: { ...raw, processMetrics: result.metrics } };
}

async function runMonitored(executable, args, environment, label) {
  const stdoutPath = path.join(directories.raw, `${label}.stdout.log`);
  const stderrPath = path.join(directories.raw, `${label}.stderr.log`);
  const metricsPath = path.join(directories.raw, `${label}.process-metrics.json`);
  run("pwsh", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    path.join(root, "scripts/benchmarks/run-windows-process-metrics.ps1"), "-Executable", executable,
    "-ArgumentJson", JSON.stringify(args), "-EnvironmentJson", JSON.stringify(environment),
    "-StdoutPath", stdoutPath, "-StderrPath", stderrPath, "-MetricsPath", metricsPath],
  process.env, label, 300_000);
  const metrics = JSON.parse(await readFile(metricsPath, "utf8"));
  return { stdout: await readFile(stdoutPath, "utf8"), stderr: await readFile(stderrPath, "utf8"), metrics,
    rawFiles: [stdoutPath, stderrPath, metricsPath] };
}

function buildExecutables() {
  const deepEnv = { ...process.env, CARGO_HOME: directories.cargoHome, CARGO_TARGET_DIR: directories.deepTarget,
    TEMP: directories.tmp, TMP: directories.tmp };
  run("cargo", ["+1.97.0", "build", "--locked", "--release", "--manifest-path",
    path.join(root, "packages/deep-engine-native/Cargo.toml"), "--bin", "deep-engine-native"], deepEnv, "Deep build", 1_800_000);
  const bevyEnv = { ...process.env, CARGO_HOME: path.join(bevyCache, "cargo-home"),
    CARGO_TARGET_DIR: path.join(bevyCache, "target"), TEMP: path.join(bevyCache, "tmp"), TMP: path.join(bevyCache, "tmp") };
  run("cargo", ["+1.97.0", "build", "--locked", "--release", "--offline", "--manifest-path",
    path.join(root, "scripts/benchmarks/bevy-0.19.1/Cargo.toml")], bevyEnv, "Bevy build", 1_800_000);
}
function run(command, args, env, label, timeout = 180_000) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", windowsHide: true,
    timeout, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${label} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result;
}
function assertExternal(value) {
  const relative = path.relative(root, value);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("benchmark cache must be outside repository");
  }
}
function parseArgs(args) {
  const value = { rounds: 5, warmupFrames: 30, sampleFrames: 120, instances: 256,
    output: "test-output/bevy-019-benchmark/paired-evidence.json", skipBuild: false, requireComplete: false };
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key === "--rounds") value.rounds = Number(args[++i]);
    else if (key === "--warmup-frames") value.warmupFrames = Number(args[++i]);
    else if (key === "--sample-frames") value.sampleFrames = Number(args[++i]);
    else if (key === "--instances") value.instances = Number(args[++i]);
    else if (key === "--output") value.output = args[++i];
    else if (key === "--skip-build") value.skipBuild = true;
    else if (key === "--require-complete") value.requireComplete = true;
    else throw new Error(`unknown argument ${key}`);
  }
  if (value.rounds < 5 || value.warmupFrames < 10 || value.sampleFrames < 30) throw new Error("sampling floor is not met");
  return value;
}
