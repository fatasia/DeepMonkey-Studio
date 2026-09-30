import { readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

export function validateProbeGiNativeEvidence(native, fixture) {
  const expected = new Set(fixture.cases.map(test => test.id));
  const actual = new Set(native?.results?.map(row => row.id));
  if (native?.passed !== true || native.runs !== 2 || native.results?.length !== expected.size
    || actual.size !== expected.size || [...actual].some(id => !expected.has(id))
    || native.results.some(row => row.passed !== true || row.value?.length !== 3 || !row.value.every(Number.isFinite))) {
    throw Error("Native probe evidence lacks the complete successful fixture sample set");
  }
  return native;
}

/** Deletion plus actual test-name/result checks prevent a stale JSON from passing a failed run. */
export async function runFreshProbeGiNative({ root, out, fixture, spawn = spawnSync }) {
  const nativePath = path.join(out, "native.json"), evidencePath = path.join(out, "evidence.json");
  await rm(nativePath, { force: true });
  await rm(evidencePath, { force: true });
  try {
    const cargo = spawn("cargo", ["test", "--manifest-path", "packages/deep-engine-native/Cargo.toml",
      "--locked", "--test", "j2_probe_gi_parity", "--", "--ignored", "--nocapture"], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 600000,
    });
    const log = (cargo.stdout ?? "") + (cargo.stderr ?? "");
    await writeFile(path.join(out, "native.log"), log);
    if (cargo.error || cargo.status !== 0) throw Error(`Native probe leg failed (${cargo.status}): ${cargo.error?.message ?? "see native.log"}`);
    if (!/test j2_probe_gi_production_vectors \.\.\. ok/.test(log)
      || !/test result: ok\. [1-9]\d* passed/.test(log)) throw Error("Native production GPU test did not execute successfully");
    return validateProbeGiNativeEvidence(JSON.parse(await readFile(nativePath, "utf8")), fixture);
  } catch (error) {
    await rm(nativePath, { force: true });
    await rm(evidencePath, { force: true });
    throw error;
  }
}
