import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDashboardDeploymentConfig, registerConfiguredDashboardNative } from "./dashboardNativeStartup.js";

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
  it("rejects relative configuration, executable paths and missing device identity", async () => {
    await expect(readDashboardDeploymentConfig("relative.json")).rejects.toThrow(/absolute path/);
    for (const patch of [{ nativeExecutable: "relative.exe" }, { expectedDeviceFingerprintSha256: "" },
      { nativeExecutable: path.resolve("player.sh") }, { configuration: { locale: "", packageVersion: "1" } }]) {
      await expect(readDashboardDeploymentConfig(await configFile({ ...deployment, ...patch }))).rejects.toThrow(/requires/);
    }
  });
});
