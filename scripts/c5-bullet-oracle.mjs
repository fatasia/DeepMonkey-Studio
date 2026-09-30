import { readFile, writeFile, copyFile, rm, mkdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "../packages/deep-engine/node_modules/esbuild/lib/main.js";
import { compareBullet } from "./lib/c5BulletComparison.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)), out = `${root}/test-output/c5-bullet`;
const flags = process.argv.slice(2);
if (flags.some(f => f !== "--compare")) throw Error("Only --compare is supported");
const historic = flags.includes("--compare");
await mkdir(out, { recursive: true });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const source = await readFile(`${out}/download/pybullet-3.2.7.tar.gz`);
if (digest(source) !== "042879db8d101ac7590dee475fc6aded508b85fe1273fdbbfde1d88bd200e14f") throw Error("Pinned Bullet source hash mismatch");
function run(name, command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, ...env },
    encoding: "utf8", windowsHide: true, timeout: 600000 });
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error || result.status !== 0) throw Error(`${name} failed: ${log.slice(-2500)}`);
  return log;
}
if (!historic) {
  const started = Date.now(); await rm(`${out}/evidence.json`, { force: true });
  await rm(`${out}/bullet.json`, { force: true });
  await build({ entryPoints: [`${root}/packages/deep-engine/lab/c5ClothOracleExport.ts`],
    outfile: `${out}/cloth-export.mjs`, bundle: true, format: "esm", platform: "node" });
  const { exportClothOracleInput } = await import(new URL("../test-output/c5-bullet/cloth-export.mjs", import.meta.url));
  await writeFile(`${out}/cloth-input.json`, JSON.stringify(exportClothOracleInput()));
  const webLog = run("Web stack/hinge/mechanisms", "cmd.exe", ["/d", "/s", "/c", "pnpm --filter @bim-studio/web exec vitest run src/viewer/rapierPhysicsStackGolden.test.ts src/viewer/rapierPhysicsHingeLimitGolden.test.ts src/viewer/rapierPositionServoGearGolden.test.ts"]);
  await writeFile(`${out}/web-stack.log`, webLog);
  const nativeLog = run("Native stack", "cargo", ["test", "--manifest-path", "packages/deep-engine-native/Cargo.toml", "--locked",
    "--lib", "native_physics::golden_tests::stack_records_per_step_poses_for_cross_end_tolerance_pairing", "--", "--exact"]);
  await writeFile(`${out}/native-stack.log`, nativeLog);
  if (!/test result: ok\. [1-9]\d* passed/.test(nativeLog)) throw Error("Native stack did not execute");
  const hingeLog = run("Native hinge", "cargo", ["test", "--manifest-path", "packages/deep-engine-native/Cargo.toml", "--locked", "--lib",
    "native_physics::golden_tests::hinge_exports_existing_actual_golden_for_independent_oracle", "--", "--exact"]);
  await writeFile(`${out}/native-hinge.log`, hingeLog);
  if (!/test result: ok\. [1-9]\d* passed/.test(hingeLog)) throw Error("Native hinge did not execute");
  const mechanismLog = run("Native mechanisms", "cargo", ["test", "--manifest-path", "packages/deep-engine-native/Cargo.toml", "--locked",
    "--lib", "native_physics::motor_gear_tests"]);
  await writeFile(`${out}/native-mechanisms.log`, mechanismLog);
  if (!/test result: ok\. [1-9]\d* passed/.test(mechanismLog)) throw Error("Native mechanisms did not execute");
  for (const side of ["web", "native"]) {
    if ((await stat(`${out}/${side}-slider.json`)).mtimeMs < started) throw Error(`${side} slider output is stale`);
    const path = `${root}/test-output/t17-motor-gear/${side}-gear-poses.json`;
    if ((await stat(path)).mtimeMs < started) throw Error(`${side} gear output is stale`);
    await copyFile(path, `${out}/${side}-gear.json`);
  }
  for (const side of ["web", "native"]) if ((await stat(`${out}/${side}-hinge.json`)).mtimeMs < started) throw Error(`${side} hinge output is stale`);
  for (const side of ["web", "native"]) {
    const path = `${root}/test-output/t17-cross-tolerance/${side}-stack-poses.json`;
    if ((await stat(path)).mtimeMs < started) throw Error(`${side} stack output is stale`);
    await copyFile(path, `${out}/${side}-stack-poses.json`);
  }
  await writeFile(`${out}/oracle.log`, run("Bullet DIRECT", process.env.C5_PYTHON ?? "python", ["scripts/c5-bullet-oracle.py"], { PYTHONPATH: `${out}/site` }));
}
const [webText, nativeText, clothText, bulletText] = await Promise.all(["web-stack-poses.json", "native-stack-poses.json", "cloth-input.json", "bullet.json"].map(p => readFile(`${out}/${p}`, "utf8")));
const [webHingeText, nativeHingeText] = await Promise.all(["web-hinge.json", "native-hinge.json"].map(p => readFile(`${out}/${p}`, "utf8")));
const [webGearText, nativeGearText, webSliderText, nativeSliderText] = await Promise.all([
  "web-gear.json", "native-gear.json", "web-slider.json", "native-slider.json"].map(p => readFile(`${out}/${p}`, "utf8")));
const evidence = { ...compareBullet({ webText, nativeText, clothText, bulletText, webHingeText, nativeHingeText,
  webGearText, nativeGearText, webSliderText, nativeSliderText }), currentRun: !historic,
  sourceSha256: digest(source), sourceUrl: "https://pypi.org/project/pybullet/3.2.7/",
  evidenceMode: historic ? "historical files only" : "Web/Native/Bullet executed in this run" };
await writeFile(`${out}/evidence.json`, JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
