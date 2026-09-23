#!/usr/bin/env node
// 场景安卓查看器模板 APK 组装:
//   aapt2 link(manifest+assets) → 注入双架构 .so → zipalign -p → apksigner 签名。
// 模板 APK 是发布链的输入:apps/api 的 dashboardAndroidApk 按发布场景注入
// assets/runtime-package.json 并重签;本脚本产出的模板自带占位资产。
// 用法:node apps/api/scripts/build-android-template.mjs --out <apk路径> [--abi arm64-v8a,x86_64]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";

const repoRoot = path.resolve(new URL("../../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = flag("--out") ?? path.join(repoRoot, "data", "android", "deep-scene-viewer-template.apk");
const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME
  ?? path.join(process.env.LOCALAPPDATA, "Android", "Sdk");
const buildTools = process.env.DEEP_ANDROID_BUILD_TOOLS
  ?? path.join(sdk, "build-tools", existsSync(path.join(sdk, "build-tools", "35.0.0")) ? "35.0.0" : "34.0.0");
const platform = path.join(sdk, "platforms", "android-36", "android.jar");
const shellDir = path.join(repoRoot, "packages", "deep-scene-viewer-android");
const abis = (flag("--abi") ?? "arm64-v8a,x86_64").split(",");

const jniLibAbi = { "arm64-v8a": "aarch64-linux-android", "x86_64": "x86_64-linux-android" };
const soName = "libdeep_scene_viewer.so";
// 体积瘦身档 android-release 优先;不存在时回退普通 release。
const soPaths = new Map();
for (const abi of abis) {
  const soDir = ["android-release", "release"]
    .map(profile => path.join(shellDir, "target", jniLibAbi[abi], profile))
    .find(dir => existsSync(path.join(dir, soName)));
  if (!soDir) throw new Error(`缺少 ${soName}(android-release/release 均无);先交叉编译 ${jniLibAbi[abi]}`);
  soPaths.set(abi, path.join(soDir, soName));
}
if (!existsSync(platform)) throw new Error(`缺少 android.jar: ${platform}`);

const work = mkdtempSync(path.join(tmpdir(), "deep-template-"));
try {
  const baseApk = path.join(work, "template-unsigned.apk");
  execFileSync(path.join(buildTools, "aapt2.exe"), ["link", "-o", baseApk,
    "--manifest", path.join(shellDir, "android", "AndroidManifest.xml"),
    "-A", path.join(shellDir, "android", "assets"),
    "-I", platform, "--min-sdk-version", "24", "--target-sdk-version", "35"], { stdio: "inherit" });

  const zip = new JSZip();
  const loaded = await new JSZip().loadAsync(readFileSync(baseApk));
  for (const entry of Object.values(loaded.files)) {
    if (entry.dir) continue;
    zip.file(entry.name, await entry.async("uint8array"), { date: new Date("2000-01-01T00:00:00Z"), createFolders: false });
  }
  for (const abi of abis) {
    zip.file(`lib/${abi}/${soName}`, readFileSync(soPaths.get(abi)), { date: new Date("2000-01-01T00:00:00Z"), createFolders: false, compression: "STORE" });
  }
  const inflated = path.join(work, "template-inflated.apk");
  writeFileSync(inflated, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", platform: "DOS" }));

  const aligned = path.join(work, "template-aligned.apk");
  execFileSync(path.join(buildTools, "zipalign.exe"), ["-f", "-p", "4", inflated, aligned], { stdio: "inherit" });

  mkdirSync(path.dirname(out), { recursive: true });
  const keystore = process.env.DEEP_TEMPLATE_KEYSTORE
    ?? path.join(process.env.USERPROFILE ?? repoRoot, ".android", "deepmonkey-template.keystore");
  if (!existsSync(keystore)) {
    execFileSync("keytool", ["-genkeypair", "-v", "-keystore", keystore, "-storetype", "PKCS12",
      "-alias", "deepmonkey-template", "-keyalg", "RSA", "-keysize", "2048", "-validity", "3650",
      "-storepass", "deepmonkey-template",
      "-dname", "CN=DeepMonkey Template, O=DeepMonkey, C=CN"], { stdio: "inherit" });
  }
  // apksigner 是 .bat:Node ≥ 20 需 shell:true;口令为模板测试口令,发布由服务端重签覆盖。
  execFileSync(path.join(buildTools, "apksigner.bat"), ["sign",
    "--min-sdk-version", "24",
    "--ks", keystore, "--ks-key-alias", "deepmonkey-template",
    "--ks-pass", "pass:deepmonkey-template", "--key-pass", "pass:deepmonkey-template",
    "--out", out, aligned], { stdio: "inherit", shell: true, windowsHide: true });
  execFileSync(path.join(buildTools, "apksigner.bat"), ["verify", "--min-sdk-version", "24", out],
    { stdio: "inherit", shell: true, windowsHide: true });

  const bytes = readFileSync(out);
  console.log(`template apk: ${out}`);
  console.log(`size: ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MiB  sha256: ${createHash("sha256").update(bytes).digest("hex")}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
