import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { compareNormalAttachments } from "./lib/j3NormalShadowParity.mjs";
import { compareShadowVisibility } from "./lib/j3ShadowVisibilityParity.mjs";
import { snapshotWindowRecoverySources } from "./j3-window-recovery-suite.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "test-output/interrupted-0930/shadow-visibility");
const compareOnly = process.argv.length === 3 && process.argv[2] === "--compare";
if (process.argv.length > (compareOnly ? 3 : 2)) throw Error("Only --compare is supported; default executes fresh Native and Web.");
const files = ["scripts/j3-shadow-visibility-parity.mjs", "scripts/lib/j3ShadowVisibilityParity.mjs",
  "scripts/lib/j3ShadowVisibilityIntervals.mjs", "scripts/j3-normal-shadow-parity.mjs", "scripts/lib/j3NormalShadowParity.mjs",
  "packages/deep-engine/lab/j3NormalShadowMatrix.ts", "packages/deep-engine/lab/j3NormalShadowProbe.ts",
  "packages/deep-engine/lab/j3NormalShadowReadbackShader.ts", "packages/deep-engine-native/tests/support/j3_shadow_visibility.rs",
  "packages/deep-engine-native/tests/support/j3_normal_attachments.rs",
  "packages/deep-engine-native/tests/support/shader_material_renderer.rs", "packages/deep-engine-native/tests/support/shader_material_observers.rs",
  "packages/deep-engine-native/tests/support/j3_hdr_frame.rs", "packages/deep-engine-native/tests/gpu_shader_material_draw.rs",
  "packages/deep-engine-native/tests/fixtures/runtime-package-v1.json", "packages/deep-engine/fixtures/j3-hdr-flat-normal-v1.json"];
async function identity() {
  const product = await snapshotWindowRecoverySources();
  const additional = Object.fromEntries(await Promise.all(files.map(async file =>
    [file, createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")])));
  const sources = Object.fromEntries(Object.entries({ ...product.sources, ...additional }).sort(([a], [b]) => a.localeCompare(b)));
  return { sha256: createHash("sha256").update(JSON.stringify(sources)).digest("hex"), sources };
}
await mkdir(output, { recursive: true }); await rm(path.join(output, "evidence.json"), { force: true });
const before = await identity();
if (!compareOnly) {
  const normalOutput = path.join(root, "test-output/interrupted-0930/normal-shadow/native.json");
  await rm(normalOutput, { force: true });
  const normal = spawnSync("cargo", ["test", "--manifest-path", "packages/deep-engine-native/Cargo.toml", "--locked",
    "--test", "gpu_shader_material_draw", "j3_gate_d_actual_normal_attachments", "--", "--ignored", "--nocapture"],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  const normalLog = (normal.stdout ?? "") + (normal.stderr ?? "");
  await writeFile(path.join(output, "native-normal.log"), normalLog);
  if (normal.error || normal.status !== 0 || !/test j3_normal_attachments::j3_gate_d_actual_normal_attachments \.\.\. ok/.test(normalLog)
    || !/test result: ok\. [1-9]\d* passed/.test(normalLog)) throw Error("Actual named Native normal test did not pass; see shadow-visibility/native-normal.log");
  await rm(path.join(output, "native.json"), { force: true });
  const cargo = spawnSync("cargo", ["test", "--manifest-path", "packages/deep-engine-native/Cargo.toml", "--locked",
    "--test", "gpu_shader_material_draw", "j3_gate_d_actual_shadow_visibility", "--", "--ignored", "--nocapture"],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  const log = (cargo.stdout ?? "") + (cargo.stderr ?? ""); await writeFile(path.join(output, "native.log"), log);
  if (cargo.error || cargo.status !== 0 || !/test j3_shadow_visibility::j3_gate_d_actual_shadow_visibility \.\.\. ok/.test(log)
    || !/test result: ok\. [1-9]\d* passed/.test(log)) throw Error("Actual named Native shadow test did not pass; see shadow-visibility/native.log");
  // Existing Web producer owns the same 24 actual normal/HDR/map captures. No duplicate native invocation.
  const web = spawnSync(process.execPath, [path.join(root, "scripts/j3-normal-shadow-parity.mjs"), "--web-only"],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  await writeFile(path.join(output, "web.log"), (web.stdout ?? "") + (web.stderr ?? ""));
  if (web.error || web.status !== 0) throw Error("Actual Web shadow/HDR producer failed; see shadow-visibility/web.log");
}
const read = async file => JSON.parse(await readFile(path.join(root, file), "utf8"));
const result = compareShadowVisibility(await read("test-output/interrupted-0930/normal-shadow/cpu-plan.json"),
  await read("test-output/interrupted-0930/normal-shadow/web.json"),
  await read("test-output/interrupted-0930/shadow-visibility/native.json"));
const normals = compareOnly ? undefined : compareNormalAttachments(
  await read("test-output/interrupted-0930/normal-shadow/cpu-plan.json"),
  await read("test-output/interrupted-0930/normal-shadow/web.json"),
  await read("test-output/interrupted-0930/normal-shadow/native.json"));
const after = await identity();
if (before.sha256 !== after.sha256) throw Error("Product/observer sources changed during shadow comparison.");
const evidence = { ...result, ...(normals ? { normals } : {}), currentRun: !compareOnly, sourceIdentity: before,
  execution: compareOnly ? { native: "explicit-prior-receipt-comparison", web: "explicit-prior-receipt-comparison" }
    : { native: "fresh-named-normal-and-legal-two-four-cascade-tests", web: "fresh-web-production-twenty-four-frames" } };
await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ passed: evidence.passed, stable: evidence.stable, currentRun: evidence.currentRun,
  pointsCompared: evidence.pointsCompared, maxVisibilityIntervalGap: evidence.maxVisibilityIntervalGap,
  differences: evidence.differences.length, scope: evidence.scope }));
if (!result.passed || !result.stable || (normals && (!normals.passed || !normals.stable))) process.exitCode = 1;
