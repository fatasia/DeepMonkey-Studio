import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { readSceneViewerArchiveSource } from "../apps/desktop/scripts/scene-viewer-archive-source.mjs";
import { compileNativeSceneCandidate } from "../apps/api/dist/nativeSceneCandidateCompiler.js";
import { createDashboardAndroidApk } from "../apps/api/dist/dashboardAndroidApk.js";

// Reuses the production compiler and APK injection/signing chain. No Cargo or emulator.
const [archive, outputArg] = process.argv.slice(2);
if (!archive || !outputArg) throw new Error("Expected <frozen three-webview archive> <QA output directory>");
const source = await readSceneViewerArchiveSource(archive);
if (!source.publication.name.startsWith("QA ")) throw new Error("Only isolated named QA scene copies are accepted");
const output = path.resolve(outputArg);
await mkdir(output, { recursive: true });
const models = new Map(source.project.models.map(model => {
  const bytes = source.resources.get(model.manifest.geometryUrl);
  if (!bytes) throw new Error(`Frozen model missing: ${model.id}`);
  return [model.id, Uint8Array.from(bytes)];
}));
const compiled = await compileNativeSceneCandidate({ scene: source.publication.snapshot, models,
  textures: new Map([...source.resources].map(([url, bytes]) => [url, Uint8Array.from(bytes)])),
  packageId: "scene.qa.offline.20261007", packageVersion: "1.0.0" });
const packageBytes = Buffer.from(compiled.packageJson);
await writeFile(path.join(output, "runtime-package.json"), packageBytes);
const template = path.resolve(process.env.BIM_QA_ANDROID_TEMPLATE ?? "data/android/deep-scene-viewer-template.apk");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const templateHash = hash(await readFile(template));
const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? path.join(process.env.LOCALAPPDATA, "Android", "Sdk");
const result = await createDashboardAndroidApk(packageBytes, { templateApkPath: template, templateApkSha256: templateHash,
  buildToolsPath: path.join(sdk, "build-tools", "35.0.0"),
  defaultSigning: async () => ({ keystore: await readFile(path.join(process.env.USERPROFILE, ".android", "deepmonkey-template.keystore")),
    keyAlias: "deepmonkey-template", storePassword: "deepmonkey-template" }) });
const apkPath = path.join(output, "qa-scene-offline.apk");
await writeFile(apkPath, result.apk);
const JSZip = createRequire(new URL("../apps/api/package.json", import.meta.url))("jszip");
const apk = await JSZip.loadAsync(result.apk);
const embedded = await apk.file("assets/runtime-package.json")?.async("nodebuffer");
if (!embedded || hash(embedded) !== hash(packageBytes)) throw new Error("APK embedded frozen runtime bytes differ");
const evidence = { purpose: "Current frozen QA publication compiled with production worker, packaged into existing Android template",
  sceneId: source.publication.sceneId, publishedAt: source.publication.publishedAt,
  compilerSha256: compiled.compilerSha256, compilation: compiled.evidence,
  compatibility: compiled.report, templatePath: template, templateSha256: templateHash,
  binaryFreshness: "Existing 2026-09-24 template; current-source Native binary not rebuilt in this probe",
  apkPath, apkBytes: result.apk.byteLength, apkSha256: hash(result.apk), runtimeBytes: packageBytes.length,
  runtimeSha256: result.scenePackageSha256, embeddedRuntimeVerified: true,
  abis: Object.keys(apk.files).filter(name => /^lib\/[^/]+\/libdeep_scene_viewer\.so$/.test(name)) };
await writeFile(path.join(output, "apk-evidence.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ apkPath, apkBytes: evidence.apkBytes, runtimeBytes: evidence.runtimeBytes,
  compilerSha256: evidence.compilerSha256, status: compiled.report.status, templateSha256: templateHash }, null, 2));
