import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareLocalPublicationRuntime } from "../apps/api/scripts/prepare-local-publication-runtime.mjs";

test("Windows-only publication runtime requires Native and excludes Android tools", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "studio-local-runtime-test-"));
  try {
    const native = path.join(root, "native.exe"), probe = path.join(root, "probe.json"), output = path.join(root, "output");
    const pe = Buffer.alloc(1024 * 1024); pe.write("MZ"); await writeFile(native, pe);
    await writeFile(probe, JSON.stringify({ schemaVersion: 1, note: "unit fixture for file validation only", meshes: [] }));
    const options = { outputRoot: output, nativeExecutable: native, nativeProbePackage: probe,
      includeAndroid: false, androidTemplate: path.join(root, "absent.apk"), javaHome: path.join(root, "no-java"),
      androidBuildTools: path.join(root, "no-tools"), version: "0.2.0" };
    const manifest = await prepareLocalPublicationRuntime(options);
    assert.deepEqual(Object.keys(manifest.resources).sort(), ["nativeExecutable", "nativeProbePackage"]);
    assert.equal(manifest.environment.JAVA_HOME, undefined);
    assert.equal(manifest.dashboardDeploymentTemplate.androidApk, undefined);
    assert.equal(manifest.dashboardDeploymentTemplate.configuration.packageVersion, "0.2.0");
    assert.equal((await readFile(path.join(output, manifest.resources.nativeExecutable.path))).equals(pe), true);
    await assert.rejects(stat(path.join(output, "publication/android")), { code: "ENOENT" });
    await assert.rejects(prepareLocalPublicationRuntime({ ...options, nativeExecutable: path.join(root, "missing.exe") }), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
