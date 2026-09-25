#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { ANDROID_SCENE_ASSET_PATH, createDashboardAndroidApk } from "../src/dashboardAndroidApk.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const required = (name: string) => flag(name) ?? (() => { throw new Error(`missing ${name}`); })();
const templateApkPath = path.resolve(required("--template"));
const runtimePackagePath = path.resolve(required("--runtime-package"));
const outputPath = path.resolve(required("--out"));
const buildToolsPath = path.resolve(required("--build-tools"));
const keystorePath = path.resolve(required("--keystore"));
const storePassword = process.env.DEEP_ANDROID_VERIFY_STORE_PASSWORD;
const keyAlias = process.env.DEEP_ANDROID_VERIFY_KEY_ALIAS;
if (!storePassword || !keyAlias) throw new Error("missing Android verification signing environment");

const runtimePackage = new Uint8Array(await readFile(runtimePackagePath));
const result = await createDashboardAndroidApk(runtimePackage, {
  templateApkPath,
  buildToolsPath,
  defaultSigning: async () => ({
    keystore: new Uint8Array(await readFile(keystorePath)),
    storePassword,
    keyAlias,
    ...(process.env.DEEP_ANDROID_VERIFY_KEY_PASSWORD
      ? { keyPassword: process.env.DEEP_ANDROID_VERIFY_KEY_PASSWORD }
      : {}),
  }),
});
await writeFile(outputPath, result.apk);

const apk = await JSZip.loadAsync(result.apk, { checkCRC32: true });
const embedded = await apk.file(ANDROID_SCENE_ASSET_PATH)?.async("uint8array");
if (!embedded || !Buffer.from(embedded).equals(Buffer.from(runtimePackage))) {
  throw new Error("published APK does not contain the authoritative runtime package bytes");
}
execFileSync(path.join(buildToolsPath, "zipalign.exe"), ["-c", "-p", "4", outputPath], { stdio: "inherit" });
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "java.exe") : "java";
execFileSync(java, ["-jar", path.join(buildToolsPath, "lib", "apksigner.jar"), "verify",
  "--min-sdk-version", "24", outputPath], { stdio: "inherit" });
console.log(JSON.stringify({
  outputPath,
  apkBytes: result.apk.byteLength,
  apkSha256: createHash("sha256").update(result.apk).digest("hex"),
  runtimePackageBytes: runtimePackage.byteLength,
  runtimePackageSha256: result.scenePackageSha256,
  templateApkSha256: result.templateApkSha256,
}, null, 2));
