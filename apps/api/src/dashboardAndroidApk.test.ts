import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  ANDROID_SCENE_ASSET_PATH,
  createDashboardAndroidApk,
  injectSceneAsset,
} from "./dashboardAndroidApk.js";

const scenePackage = (body: string) => new TextEncoder().encode(body);

async function syntheticTemplateApk(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("AndroidManifest.xml", "manifest-bytes");
  zip.file("classes.dex", "dex-bytes");
  zip.file("resources.arsc", "arsc-bytes", { compression: "STORE" });
  zip.file("lib/arm64-v8a/libdeep.so", "so-bytes", { compression: "STORE" });
  zip.file("META-INF/MANIFEST.MF", "old-manifest");
  zip.file("META-INF/CERT.SF", "old-signature");
  zip.file("META-INF/CERT.RSA", "old-key");
  zip.file("assets/stale-asset.txt", "stale");
  return zip.generateAsync({ type: "uint8array" });
}

describe("injectSceneAsset", () => {
  it("注入场景资产并移除旧签名文件,模板其余条目保持原字节", async () => {
    const scene = scenePackage('{"schema":"deep-engine.dashboard-offline-archive-v1"}\n');
    const injected = await injectSceneAsset(await syntheticTemplateApk(), scene);
    const zip = await JSZip.loadAsync(injected);
    expect(await zip.file(ANDROID_SCENE_ASSET_PATH)!.async("uint8array")).toEqual(scene);
    expect(zip.file("META-INF/CERT.SF")).toBeNull();
    expect(zip.file("META-INF/CERT.RSA")).toBeNull();
    expect(zip.file("META-INF/MANIFEST.MF")).toBeNull();
    expect(await zip.file("resources.arsc")!.async("text")).toBe("arsc-bytes");
    expect(await zip.file("lib/arm64-v8a/libdeep.so")!.async("text")).toBe("so-bytes");
    expect(await zip.file("AndroidManifest.xml")!.async("text")).toBe("manifest-bytes");
  });

  it("重复注入同一场景产生相同字节(哈希审计要求确定性)", async () => {
    const scene = scenePackage('{"scene":"stable"}');
    const first = await injectSceneAsset(await syntheticTemplateApk(), scene);
    const second = await injectSceneAsset(await syntheticTemplateApk(), scene);
    expect(first).toEqual(second);
  });
});

describe("createDashboardAndroidApk", () => {
  const workDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(workDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  it.skipIf(!process.env.DEEP_ANDROID_BUILD_TOOLS || !existsSync(path.join(process.env.DEEP_ANDROID_BUILD_TOOLS, "zipalign.exe")))(
    "模板注入+zipalign+apksigner 全链出可验证 APK",
    async () => {
      const keystoreDir = await mkdtemp(path.join(tmpdir(), "deep-android-ks-"));
      workDirs.push(keystoreDir);
      const keystorePath = path.join(keystoreDir, "signing.keystore");
      const keystore = await generateKeystore(keystorePath);
      const templatePath = path.join(keystoreDir, "template.apk");
      const { writeFile: write } = await import("node:fs/promises");
      const template = await syntheticTemplateApk();
      await write(templatePath, template);
      const scene = scenePackage('{"schema":"e2e"}');
      const result = await createDashboardAndroidApk(scene, {
        templateApkPath: templatePath,
        buildToolsPath: process.env.DEEP_ANDROID_BUILD_TOOLS!,
        defaultSigning: async () => ({ keystore, storePassword: "deepmonkey", keyAlias: "deepmonkey" }),
      });
      expect(result.apk.byteLength).toBeGreaterThan(0);
      expect(result.scenePackageSha256).toMatch(/^[a-f0-9]{64}$/);
      const published = await JSZip.loadAsync(result.apk);
      expect(await published.file(ANDROID_SCENE_ASSET_PATH)!.async("uint8array")).toEqual(scene);
    },
    120_000,
  );
});

async function generateKeystore(keystorePath: string): Promise<Uint8Array> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("keytool", [
    "-genkeypair", "-v",
    "-keystore", keystorePath,
    "-storetype", "PKCS12",
    "-alias", "deepmonkey",
    "-keyalg", "RSA", "-keysize", "2048", "-validity", "30",
    "-storepass", "deepmonkey",
    "-dname", "CN=DeepMonkey Test, O=DeepMonkey, C=CN",
  ]);
  return readFile(keystorePath);
}
