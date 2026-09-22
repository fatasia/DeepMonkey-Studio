import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDeepRuntimePackage, serializeDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { createDashboardOfflineArchive, dashboardArchiveCanonicalSha256 } from "./dashboardOfflineArchive.js";
import { serializeDashboardOfflineArchive } from "./dashboardOfflineArchiveBytes.js";
import { createDashboardStandaloneExecutable } from "./dashboardStandaloneExecutable.js";

// 本文件验证包边界；真实 PE 资源读回由 nativeExecutableBranding.test.ts 覆盖。
const brand = vi.hoisted(() => vi.fn(async (bytes: Uint8Array) => Buffer.from(bytes)));
vi.mock("./nativeExecutableBranding.js", () => ({ applyNativeExecutableBranding: brand }));

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "dashboard standalone-")); directories.push(directory);
  const parsed = parseDeepRuntimePackage(await readFile(new URL("../../../packages/deep-engine/fixtures/dashboard-composition-v1.json", import.meta.url)));
  if (!parsed.valid) throw new Error("Invalid test fixture");
  const artifact = new TextEncoder().encode(serializeDeepRuntimePackage(parsed.value));
  const authority = { projectId: "project-golden", applicationId: "dashboard-composition-golden", publicationId: "publication-golden", applicationRevision: 1 };
  const body = { schema: "deep-engine.dashboard-publication-freeze" as const, schemaVersion: 1 as const, authority, entryPageId: "page.378d4cac696fa43e72c270f690e15329771ecf6ff6ac0b2cff9e4a2eca2dac15", documentSha256: "a".repeat(64), data: [], resources: [], totalBytes: 0 };
  const freezeManifest = { ...body, manifestSha256: dashboardArchiveCanonicalSha256(body) };
  // 结构夹具，不作为真实窗口或发布证据。
  const capability = { schema: "deep-engine.dashboard-publication-capability" as const, schemaVersion: 1 as const, authority, freezeManifestSha256: freezeManifest.manifestSha256, sourceSemanticHash: "b".repeat(64), compileGraphHash: "c".repeat(64), targetArtifactHash: sha(artifact), compiler: { id: "test-only", version: "1", sha256: "d".repeat(64), configurationSha256: "e".repeat(64) }, evidence: { verifier: "native-dashboard-window-v1" as const, fixtureSha256: "f".repeat(64), deviceFingerprintSha256: "0".repeat(64), fontSha256: [] }, objects: [] };
  const archive = serializeDashboardOfflineArchive(createDashboardOfflineArchive({ freezeManifest, capability, artifact }));
  const executable = path.join(directory, "fixture.exe");
  const pe = Buffer.alloc(128); pe.writeUInt16LE(0x5a4d); pe.writeUInt32LE(64, 60); pe.writeUInt32LE(0x00004550, 64);
  await writeFile(executable, pe);
  return { executable, archive, artifact, pe };
}

describe("Dashboard standalone executable", () => {
  it("applies the current product icon to cached candidates and preserves explicit client icons", async () => {
    const input = await fixture();
    const currentIcon = await readFile(new URL("../../desktop/src-tauri/icons/icon.ico", import.meta.url));
    await createDashboardStandaloneExecutable(input.archive, input.executable);
    expect(brand).toHaveBeenLastCalledWith(input.pe, { iconIco: currentIcon }, undefined);
    await createDashboardStandaloneExecutable(input.archive, input.executable, { branding: { applicationName: "Factory" } });
    expect(brand).toHaveBeenLastCalledWith(input.pe, { applicationName: "Factory", iconIco: currentIcon }, undefined);
    const custom = new Uint8Array([1, 2, 3]);
    await createDashboardStandaloneExecutable(input.archive, input.executable, { branding: { iconIco: custom } });
    expect(brand).toHaveBeenLastCalledWith(input.pe, { iconIco: custom }, undefined);
    expect(await readFile(input.executable)).toEqual(input.pe);
  });
  it("checks the deployed hash against the exact executable bytes used for packaging", async () => {
    const input = await fixture();
    const options = { expectedSha256: sha(input.pe) };
    await expect(createDashboardStandaloneExecutable(input.archive, input.executable, options)).resolves.toBeInstanceOf(Uint8Array);
    input.pe[100] ^= 1; await writeFile(input.executable, input.pe);
    await expect(createDashboardStandaloneExecutable(input.archive, input.executable, options)).rejects.toThrow("changed since deployment");
    await expect(createDashboardStandaloneExecutable(input.archive, input.executable, { expectedSha256: "bad" })).rejects.toThrow("Invalid expected");
  });
  it("preserves base EXE and exact validated runtime bytes with Native-readable footer and notices", async () => {
    const input = await fixture();
    const packed = Buffer.from(await createDashboardStandaloneExecutable(input.archive, input.executable));
    expect(packed.subarray(0, input.pe.length)).toEqual(input.pe);
    const footer = packed.subarray(-48);
    expect(footer.subarray(0, 8).toString("ascii")).toBe("DMDASH01");
    expect(footer.readBigUInt64LE(8)).toBe(BigInt(input.artifact.length));
    expect(footer.subarray(16).toString("hex")).toBe(sha(input.artifact));
    const payloadStart = packed.length - 48 - Number(footer.readBigUInt64LE(8));
    expect(new Uint8Array(packed.subarray(payloadStart, -48))).toEqual(input.artifact);
    expect(packed.subarray(payloadStart - 8, payloadStart).toString("ascii")).toBe("DMLICS01");
    const noticesLength = Number(packed.readBigUInt64LE(payloadStart - 16));
    const notices = JSON.parse(packed.subarray(payloadStart - 16 - noticesLength, payloadStart - 16).toString("utf8"));
    expect(notices.schema).toBe("deep-engine.embedded-notices"); expect(notices.schemaVersion).toBe(1);
    expect(notices.license).toBe(await readFile(new URL("../../../LICENSE", import.meta.url), "utf8"));
    expect(notices.thirdPartyNotices).toBe(await readFile(new URL("../../../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8"));
    expect(payloadStart - 16 - noticesLength).toBe(input.pe.length);
    expect(await createDashboardStandaloneExecutable(input.archive, input.executable)).toEqual(packed);
  });

  it("rejects a second overlay even if its stored size or digest has been corrupted", async () => {
    const input = await fixture();
    const packed = Buffer.from(await createDashboardStandaloneExecutable(input.archive, input.executable));
    packed.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, packed.length - 40);
    await writeFile(input.executable, packed);
    await expect(createDashboardStandaloneExecutable(input.archive, input.executable)).rejects.toThrow("already contains");
  });

  it("rejects invalid source archive, path, PE and pre-cancellation", async () => {
    const input = await fixture();
    const altered = input.archive.slice(); altered[altered.length - 1] ^= 1;
    await expect(createDashboardStandaloneExecutable(altered, input.executable)).rejects.toThrow();
    await expect(createDashboardStandaloneExecutable(input.archive, "relative.exe")).rejects.toThrow("absolute");
    await writeFile(input.executable, "not PE");
    await expect(createDashboardStandaloneExecutable(input.archive, input.executable)).rejects.toThrow("PE");
    await expect(createDashboardStandaloneExecutable(input.archive, input.executable, { signal: AbortSignal.abort() })).rejects.toThrow();
  });
});
