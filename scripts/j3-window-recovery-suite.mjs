import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(fileURLToPath(import.meta.url), "../..");
const output = "test-output/interrupted-0930/window-recovery-suite/evidence.json";
const logDirectory = "test-output/interrupted-0930/window-recovery-suite";
export const WINDOW_RECOVERY_COMPONENTS = [
  { id: "actual-window", script: "scripts/j3-window-recovery-parity.mjs", evidence: "test-output/interrupted-0930/window-recovery/evidence.json" },
  { id: "web-candidate-success", script: "scripts/j3-device-epoch-replacement.mjs", evidence: "test-output/interrupted-0930/epoch-replacement/evidence.json" },
  { id: "web-candidate-failure", script: "scripts/j3-device-epoch-failure.mjs", evidence: "test-output/interrupted-0930/epoch-failure/evidence.json" },
];

export function freshWindowEnvironment(env) {
  const child = { ...env }; delete child.DEEP_WINDOW_LOSS_CHILD; delete child.J3_WINDOW_NATIVE_OUTPUT;
  return child;
}

/** Preserve full child diagnostics before rethrowing; J5's compact tail is not a process log. */
export function createWindowRecoveryScriptRunner({ spawn = spawnSync,
  writeLog = async (file, content) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }, stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value),
} = {}) {
  return async script => {
    assert(WINDOW_RECOVERY_COMPONENTS.some(component => component.script === script), "unknown window suite child");
    const startedAt = new Date().toISOString();
    const result = spawn(process.execPath, [path.join(root, script)], { cwd: root, env: freshWindowEnvironment(process.env),
      encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
    const log = `${logDirectory}/${path.basename(script, ".mjs")}.log`;
    await writeLog(log, `script=${script}\nstartedAt=${startedAt}\nfinishedAt=${new Date().toISOString()}\nexit=${result.status}\n`
      + `stdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}\nprocessError:\n${result.error?.stack ?? ""}\n`);
    if (result.stdout) stdout(result.stdout);
    if (result.stderr) stderr(result.stderr);
    if (result.error || result.status !== 0) {
      const cause = result.error ?? new Error(result.stderr?.trim() || result.stdout?.trim() || "Child produced no diagnostic output.");
      throw new Error(`${script} failed with exit ${result.status}; full child log: ${log}`, { cause });
    }
  };
}

export async function snapshotWindowRecoverySources() {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = directory + "/" + entry.name;
      if (entry.isDirectory()) await visit(file); else if (entry.isFile()) files.push(file);
    }
  }
  for (const directory of ["apps/web/src", "packages/contracts/src", "packages/deep-engine/src",
    "packages/deep-engine/wgsl", "packages/deep-engine-native/src", "packages/deep-engine-native/assets"]) await visit(directory);
  files.push("package.json", "pnpm-lock.yaml", "apps/web/package.json", "packages/contracts/package.json", "packages/deep-engine/package.json",
    "packages/deep-engine-native/Cargo.toml", "packages/deep-engine-native/Cargo.lock", "packages/deep-engine-native/build.rs",
    "packages/deep-engine-native/tests/fixtures/runtime-package-author-lod-v1.json",
    "scripts/j5-dual-end-gate.mjs", "scripts/j3-window-recovery-suite.mjs", ...WINDOW_RECOVERY_COMPONENTS.map(component => component.script));
  const sources = Object.fromEntries(await Promise.all(files.sort().map(async file =>
    [file, createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")])));
  return { sha256: createHash("sha256").update(JSON.stringify(sources)).digest("hex"), sources };
}

/** Existing children own their GPU/Cargo work, once each and sequentially. */
export async function executeWindowRecoverySuite({
  runScript = createWindowRecoveryScriptRunner(),
  removeEvidence = file => rm(path.join(root, file), { force: true }),
  readEvidence = async file => JSON.parse(await readFile(path.join(root, file), "utf8")),
  snapshotSources = snapshotWindowRecoverySources,
  publishEvidence = async evidence => {
    await mkdir(path.dirname(path.join(root, output)), { recursive: true });
    await writeFile(path.join(root, output), JSON.stringify(evidence, null, 2));
  },
} = {}) {
  await removeEvidence(output);
  try {
    for (const component of WINDOW_RECOVERY_COMPONENTS) await removeEvidence(component.evidence);
    const before = await snapshotSources(), records = {};
    for (const component of WINDOW_RECOVERY_COMPONENTS) {
      await runScript(component.script);
      const evidence = await readEvidence(component.evidence);
      assert.equal(evidence.passed, true, `${component.id}: child gate failed`);
      assert.equal(evidence.stable, true, `${component.id}: child gate unstable`);
      assert.equal(evidence.currentRun, true, `${component.id}: prior receipts are not current evidence`);
      assert.equal(evidence.web?.length, 2, `${component.id}: two fresh Web instances required`);
      assert(evidence.sources && Object.keys(evidence.sources).length > 0, `${component.id}: child source identity required`);
      for (const [file, hash] of Object.entries(evidence.sources)) {
        assert.equal(hash, before.sources[file], `${component.id}: child source differs for ${file}`);
      }
      records[component.id] = evidence;
    }
    const window = records["actual-window"];
    assert.equal(window.native?.length, 2, "two fresh Native children required");
    assert.equal(window.execution?.native, "fresh-two-child-processes");
    for (const id of ["web-candidate-success", "web-candidate-failure"]) {
      assert(records[id].web.every(round => round.actualUnknownDriverFault === false), `${id}: notification must remain explicitly synthetic`);
    }
    const after = await snapshotSources();
    assert.equal(after.sha256, before.sha256, "product sources changed during suite; rerun the complete fresh suite");
    const evidence = { passed: true, stable: true, currentRun: true, sourceIdentity: before,
      scope: "Native actual destroyed window rebuild and Web actual destroyed fallback; extra candidate checks are Web-only",
      pairedWindow: window,
      webOnlyChecks: { success: records["web-candidate-success"], failure: records["web-candidate-failure"] } };
    await publishEvidence(evidence); return evidence;
  } catch (error) { await removeEvidence(output); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("window suite requires fresh default children; no options supported");
  const evidence = await executeWindowRecoverySuite();
  console.log(JSON.stringify({ passed: evidence.passed, currentRun: evidence.currentRun, scope: evidence.scope }));
}
