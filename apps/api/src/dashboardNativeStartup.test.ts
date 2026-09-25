import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDashboardDeploymentConfig, registerConfiguredDashboardNative, resolveDashboardDeviceFingerprint } from "./dashboardNativeStartup.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function configFile(value: unknown) {
  const directory = await mkdtemp(path.join(tmpdir(), "dashboard-startup-"));
  directories.push(directory);
  const file = path.join(directory, "deployment.json");
  await writeFile(file, JSON.stringify(value));
  return file;
}
const deployment = { nativeExecutable: path.resolve("player.exe"), expectedDeviceFingerprintSha256: "a".repeat(64),
  configuration: { locale: "zh-CN", packageVersion: "1.0.0" } };

describe("Dashboard deployment startup", () => {
  it("does not touch server dependencies without explicit configuration", async () => {
    const unavailable = new Proxy({}, { get() { throw new Error("Unexpected access"); } });
    await expect(registerConfiguredDashboardNative(unavailable as never, unavailable as never, "")).resolves.toBeUndefined();
  });
  it("reads explicit Windows executable and expected verifier identity", async () => {
    expect(await readDashboardDeploymentConfig(await configFile(deployment))).toEqual(deployment);
  });
  it("discovers the local GPU identity only for an explicit desktop-local deployment", async () => {
    const local = { nativeExecutable: path.resolve("player.exe"),
      deviceFingerprint: { mode: "runtime-local" as const, probePackagePath: path.resolve("probe.json") } };
    const fingerprint = "b".repeat(64);
    const verify = async () => ({ report: { deviceFingerprintSha256: fingerprint } }) as never;
    await expect(resolveDashboardDeviceFingerprint(local, { BIM_STUDIO_DEPLOYMENT_MODE: "desktop-local" }, verify)).resolves.toBe(fingerprint);
    await expect(resolveDashboardDeviceFingerprint(local, {}, verify)).rejects.toThrow(/desktop-local/);
  });
  it("accepts a portable runtime-local device probe and rejects mixed identity modes", async () => {
    const deviceFingerprint = { mode: "runtime-local", probePackagePath: path.resolve("probe.json") };
    const local = { nativeExecutable: deployment.nativeExecutable, deviceFingerprint, configuration: deployment.configuration };
    expect((await readDashboardDeploymentConfig(await configFile(local))).deviceFingerprint).toEqual(deviceFingerprint);
    await expect(readDashboardDeploymentConfig(await configFile({ ...deployment, deviceFingerprint }))).rejects.toThrow(/requires/);
  });
  it("accepts server-owned Web static paths and rejects malformed optional configurations", async () => {
    const webStatic = { root: path.resolve("dist/dashboard-static"), licensedFonts: [] };
    expect((await readDashboardDeploymentConfig(await configFile({ ...deployment, webStatic }))).webStatic).toEqual(webStatic);
    for (const patch of [{ webStatic: null }, { webStatic: { root: "relative", licensedFonts: [] } }, { layoutCapture: null }]) {
      await expect(readDashboardDeploymentConfig(await configFile({ ...deployment, ...patch }))).rejects.toThrow(/requires/);
    }
  });
  it("supports request-scoped Android signing without requiring a server keystore", async () => {
    const androidApk = { templateApkPath: path.resolve("template.apk"), buildToolsPath: path.resolve("build-tools") };
    expect((await readDashboardDeploymentConfig(await configFile({ ...deployment, androidApk }))).androidApk).toEqual(androidApk);
    for (const invalid of [null, { ...androidApk, keystorePath: path.resolve("key.jks") },
      { ...androidApk, keystorePath: path.resolve("key.jks"), keystoreStorePassword: "secret" },
      { ...androidApk, keystoreKeyPassword: "orphan" }]) {
      await expect(readDashboardDeploymentConfig(await configFile({ ...deployment, androidApk: invalid }))).rejects.toThrow(/requires/);
    }
  });
  it("rejects relative configuration, executable paths and missing device identity", async () => {
    await expect(readDashboardDeploymentConfig("relative.json")).rejects.toThrow(/absolute path/);
    for (const patch of [{ nativeExecutable: "relative.exe" }, { expectedDeviceFingerprintSha256: "" },
      { expectedDeviceFingerprintSha256: undefined, deviceFingerprint: { mode: "runtime-local", probePackagePath: "relative.json" } },
      { nativeExecutable: path.resolve("player.sh") }, { configuration: { locale: "", packageVersion: "1" } }]) {
      await expect(readDashboardDeploymentConfig(await configFile({ ...deployment, ...patch }))).rejects.toThrow(/requires/);
    }
  });
});
