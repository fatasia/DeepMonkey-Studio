import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BEVY_VERSION, externalCacheRoot, normalizeRawRun, sha256, verifyFrozenSources }
  from "./lib/bevy019BenchmarkEvidence.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const runnerRoot = path.join(repositoryRoot, "scripts", "benchmarks", `bevy-${BEVY_VERSION}`);
const options = parseArgs(process.argv.slice(2));
const cacheRoot = externalCacheRoot(repositoryRoot);
const cargoHome = path.join(cacheRoot, "cargo-home");
const targetDirectory = path.join(cacheRoot, "target");
const temporaryDirectory = path.join(cacheRoot, "tmp");
const rawDirectory = path.join(cacheRoot, "raw-evidence");
const output = path.resolve(repositoryRoot, options.output);
const rawOutput = path.join(rawDirectory, `${Date.now()}-${process.pid}.json`);
const sourceManifestPath = path.join(runnerRoot, "source-manifest.json");
const sourceManifestBytes = await readFile(sourceManifestPath);
const sourceManifest = JSON.parse(sourceManifestBytes);
await verifyFrozenSources(repositoryRoot, sourceManifest);
await Promise.all([cargoHome, targetDirectory, temporaryDirectory, rawDirectory, path.dirname(output)]
  .map(directory => mkdir(directory, { recursive: true })));

const cargoEnvironment = { ...process.env, CARGO_HOME: cargoHome, CARGO_TARGET_DIR: targetDirectory,
  TEMP: temporaryDirectory, TMP: temporaryDirectory };
if (options.offline) cargoEnvironment.CARGO_NET_OFFLINE = "true";
const manifestPath = path.join(runnerRoot, "Cargo.toml");
const command = ["+1.97.0", "run", "--locked", "--release", "--manifest-path", manifestPath];
if (options.offline) command.push("--offline");
command.push("--", "--output", rawOutput, "--warmup-frames", String(options.warmupFrames),
  "--sample-frames", String(options.sampleFrames), "--duration-seconds", String(options.durationSeconds),
  "--instances", String(options.instances));
if (options.hidden) command.push("--hidden");
const executed = spawnSync(options.cargo, command, { cwd: repositoryRoot, env: cargoEnvironment,
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
if (executed.status !== 0) {
  process.stderr.write(executed.stdout ?? "");
  process.stderr.write(executed.stderr ?? "");
  throw new Error(`Bevy runner failed with exit code ${executed.status ?? "unknown"}`);
}
const raw = JSON.parse(await readFile(rawOutput, "utf8"));
const evidence = normalizeRawRun(raw, { runner: "scripts/run-bevy-019-benchmark.mjs",
  runnerSourceManifestSha256: sha256(sourceManifestBytes), cargoLockSha256: sourceManifest.files
    .find(entry => entry.path.endsWith("Cargo.lock"))?.sha256,
  bevyCrate: sourceManifest.bevy, rustToolchain: "1.97.0-x86_64-pc-windows-msvc",
  isolation: { cacheRoot, cargoHome, targetDirectory, temporaryDirectory },
  rawEvidence: rawOutput, capturedAt: new Date().toISOString() });
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ output, rawOutput, cacheRoot, readiness: evidence.readiness,
  measurements: evidence.measurements }, null, 2));
if (options.requireContractComplete && evidence.readiness.status !== "raw-complete") process.exitCode = 2;

function parseArgs(args) {
  const result = { output: "test-output/bevy-019-benchmark/evidence.json", cargo: "cargo",
    warmupFrames: 120, sampleFrames: 600, durationSeconds: 0, instances: 4096,
    hidden: false, offline: false, requireContractComplete: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--output") result.output = required(args, ++index, argument);
    else if (argument === "--cargo") result.cargo = required(args, ++index, argument);
    else if (argument === "--warmup-frames") result.warmupFrames = number(required(args, ++index, argument));
    else if (argument === "--sample-frames") result.sampleFrames = number(required(args, ++index, argument));
    else if (argument === "--duration-seconds") result.durationSeconds = number(required(args, ++index, argument));
    else if (argument === "--instances") result.instances = number(required(args, ++index, argument));
    else if (argument === "--hidden") result.hidden = true;
    else if (argument === "--offline") result.offline = true;
    else if (argument === "--require-contract-complete") result.requireContractComplete = true;
    else if (argument === "--smoke") Object.assign(result, { warmupFrames: 10, sampleFrames: 30, instances: 256, hidden: true });
    else throw new Error(`unknown argument ${argument}`);
  }
  return result;
}
function required(args, index, name) { if (!args[index]) throw new Error(`${name} requires a value`); return args[index]; }
function number(value) { const parsed = Number(value); if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid number ${value}`); return parsed; }

