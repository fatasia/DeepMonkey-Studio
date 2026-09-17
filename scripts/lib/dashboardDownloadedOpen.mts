import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runDashboardOfflineNative } from "../../apps/api/src/dashboardOfflineNativeProcess.js";
import { parseDeepRuntimePackage } from "../../packages/deep-engine/src/runtimePackage/index.ts";
import { createNativeWindowVerifier } from "./nativeWindowVerifier.mjs";

/** Real player processes; instrumentation only observes stdout and stops after presentation. */
export async function verifyDashboardDownloadedOpen(directory: string, archive: Uint8Array, expectedArtifact: Uint8Array,
  expectedAtlasCount = 2) {
  const executable = path.join(directory, "extracted/deep-native-player.exe");
  const packagePath = path.join(directory, "extracted/runtime-package.json");
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha(readFileSync(packagePath)), sha(expectedArtifact));
  const zipWindow = await createNativeWindowVerifier(parseDeepRuntimePackage)({ packagePath, nativeExecutable: executable, frames: 3, signal: undefined });
  const output = path.join(directory, "dmda-open"); await mkdir(output);
  const controller = new AbortController(), finished = new Error("Acceptance stopped after Native present");
  let log = "", presented = false, launchedHash = "", processHandle: ChildProcess | undefined;
  const timer = setTimeout(() => controller.abort(new Error("DMDA native presentation timed out")), 15_000);
  const observeSpawn = ((file: string, args: string[], options: object) => {
    assert.equal(file, executable); assert.equal(args[0], "--package");
    launchedHash = sha(readFileSync(args[1]!)); assert.equal(launchedHash, sha(expectedArtifact));
    const child = spawn(file, args, { ...options, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LOCALAPPDATA: path.join(output, "local-app-data"),
        PATH: path.join(process.env.SystemRoot ?? "C:/Windows", "System32") } });
    processHandle = child;
    const receive = (bytes: Buffer) => {
      log += bytes.toString();
      if (log.length > 1024 * 1024) { controller.abort(new Error("Native log budget exceeded")); return; }
      if (!presented && log.includes("native package recovery checkpoint committed after present")) {
        presented = true; controller.abort(finished);
      }
    };
    child.stdout.on("data", receive); child.stderr.on("data", receive);
    return child;
  }) as typeof spawn;
  try {
    await assert.rejects(runDashboardOfflineNative(archive, executable, { signal: controller.signal, spawnProcess: observeSpawn }),
      reason => reason === finished);
    assert(presented); assert(log.includes("native GPU:")); assert(log.includes(`atlases=${expectedAtlasCount}`));
    await writeFile(path.join(output, "player.log"), log);
    const evidence = { scope: "downloaded-zip-and-dmda-native-open", zipWindow, dmda: {
      artifactSha256: launchedHash, presentedCheckpoint: true, nodeRuntimeOnPlayerPath: false,
      launchArgumentsPreserved: true, stoppedAfterPresent: true } };
    await writeFile(path.join(directory, "downloaded-open.json"), JSON.stringify(evidence, null, 2));
    return evidence;
  } finally {
    clearTimeout(timer);
    if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill();
  }
}
