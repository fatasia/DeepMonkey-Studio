import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { validateSceneClientArchiveManifest } from "./sceneClientArchiveManifest.mjs";

const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { runtimeContentSha256 } = await import(pathToFileURL(requireWeb.resolve("@bim-studio/deep-engine/runtime-package")).href);
function sign(manifest) {
  const { files, contentHash: _hash, generatedAt: _time, ...metadata } = manifest;
  manifest.contentHash = { algorithm: "sha256", value: runtimeContentSha256({ metadata,
    files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) }) };
  return manifest;
}
function fixture(target = "three-webview") {
  const manifest = { kind: "bim-studio-scene-client-package", schemaVersion: 1, purpose: "delivery", target,
    renderer: "webgl", toolbarVisible: false, projectId: "p", sceneId: "s", sceneName: "场景", publishedAt: null,
    generatedAt: "2026-09-15T12:00:00Z", capabilities: { twoD: true, threeD: true, dataBindings: true, liveConnections: true },
    files: ["scene.json", "project.json", "applications.json", "runtime.json", "README.txt"].map(path => ({ path, bytes: 0, sha256: "a".repeat(64), sourceUrl: "generated" })) };
  if (target === "deep-native") {
    manifest.nativeRuntime = { kind: "deep-engine.runtime-package", schemaVersion: 3, path: "native/runtime-package.json",
      reportPath: "native/compatibility-report.json", status: "ready", packageHash: { algorithm: "sha256", value: "b".repeat(64) } };
    manifest.capabilities = { status: "ready", reportPath: manifest.nativeRuntime.reportPath };
    for (const path of ["native/runtime-package.json", "native/compilation-evidence.json", "native/compatibility-report.json"])
      manifest.files.push({ path, bytes: 0, sha256: "c".repeat(64), sourceUrl: "generated" });
  }
  manifest.files.sort((a, b) => a.path < b.path ? -1 : 1);
  return sign(manifest);
}
for (const target of ["three-webview", "deep-native"]) test(`accepts ${target} and preserves input identity`, () => {
  const manifest = fixture(target), before = structuredClone(manifest);
  assert.equal(validateSceneClientArchiveManifest(manifest, { expectedTarget: target }), manifest);
  assert.deepEqual(manifest, before);
  manifest.publishedAt = "2026-09-16T00:00:00Z";
  assert.equal(validateSceneClientArchiveManifest(sign(manifest)), manifest);
});

for (const [field, value] of [["kind", "other"], ["schemaVersion", 2], ["purpose", "diagnostic"], ["target", "unknown"],
  ["renderer", "native"], ["toolbarVisible", 1], ["projectId", " "], ["sceneId", null], ["sceneName", ""],
  ["publishedAt", "invalid"], ["generatedAt", null], ["files", {}]]) test(`rejects malformed ${field}`, () => {
  const manifest = fixture(); manifest[field] = value;
  assert.throws(() => validateSceneClientArchiveManifest(manifest));
});
test("rejects absent root and expected target mismatch", () => {
  for (const value of [null, [], "manifest"]) assert.throws(() => validateSceneClientArchiveManifest(value));
  assert.throws(() => validateSceneClientArchiveManifest(fixture(), { expectedTarget: "deep-native" }), /expectedTarget/);
});
for (const [field, value] of [["bytes", -1], ["bytes", 0.5], ["bytes", Number.MAX_SAFE_INTEGER + 1], ["sha256", "A".repeat(64)],
  ["sha256", "short"], ["sourceUrl", null], ["path", null]]) test(`rejects file ${field} ${value}`, () => {
  const manifest = fixture(); manifest.files[0][field] = value;
  assert.throws(() => validateSceneClientArchiveManifest(sign(manifest)), /文件项/);
});
for (const path of ["../escape", "C:/escape", "foo\\bar", "manifest.json", "CON.txt", "scene.json", "SCENE.JSON", "scene.json/child"])
  test(`rejects unsafe/conflicting path ${path}`, () => {
    const manifest = fixture(); manifest.files.push({ ...manifest.files[0], path });
    assert.throws(() => validateSceneClientArchiveManifest(sign(manifest)), /路径|保留/);
  });
test("requires sorted paths and mandatory text files", () => {
  const manifest = fixture(); manifest.files.reverse();
  assert.throws(() => validateSceneClientArchiveManifest(sign(manifest)), /排序/);
  manifest.files = fixture().files.filter(file => file.path !== "README.txt");
  assert.throws(() => validateSceneClientArchiveManifest(sign(manifest)), /必要文本/);
});
for (const field of ["kind", "schemaVersion", "path", "reportPath", "status", "packageHash"]) test(`rejects malformed Native ${field}`, () => {
  const manifest = fixture("deep-native"); manifest.nativeRuntime[field] = "invalid";
  assert.throws(() => validateSceneClientArchiveManifest(sign(manifest)), /Native/);
});
test("requires Native files, capability binding, and no Three mixing", () => {
  const missing = fixture("deep-native"); missing.files = missing.files.filter(file => file.path !== "native/compilation-evidence.json");
  assert.throws(() => validateSceneClientArchiveManifest(sign(missing)), /Native 文件/);
  const mismatch = fixture("deep-native"); mismatch.capabilities.reportPath = "wrong";
  assert.throws(() => validateSceneClientArchiveManifest(sign(mismatch)), /capabilities/);
  const mixed = fixture("deep-native"); mixed.target = "three-webview";
  assert.throws(() => validateSceneClientArchiveManifest(sign(mixed)), /Three/);
  const capability = fixture(); capability.capabilities.status = "ready";
  assert.throws(() => validateSceneClientArchiveManifest(sign(capability)), /capabilities/);
});
test("checks canonical metadata and file identity but excludes generatedAt and sourceUrl", () => {
  const manifest = fixture(); manifest.generatedAt = "2026-09-17T00:00:00Z"; manifest.files[0].sourceUrl = "changed";
  validateSceneClientArchiveManifest(manifest);
  for (const mutate of [value => { value.sceneName = "changed"; }, value => { value.files[0].bytes++; }, value => { value.files[0].sha256 = "d".repeat(64); }]) {
    const changed = fixture(); mutate(changed);
    assert.throws(() => validateSceneClientArchiveManifest(changed), /contentHash 不匹配/);
  }
  manifest.contentHash.algorithm = "sha1";
  assert.throws(() => validateSceneClientArchiveManifest(manifest), /contentHash 无效/);
});
