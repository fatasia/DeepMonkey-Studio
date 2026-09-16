import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { parseDeepRuntimePackage, serializeDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { createDashboardOfflineArchive, dashboardArchiveCanonicalSha256 } from "./dashboardOfflineArchive.js";
import { serializeDashboardOfflineArchive } from "./dashboardOfflineArchiveBytes.js";
import { createDashboardPortableZip } from "./dashboardPortableZip.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "dashboard zip with spaces-"));
  directories.push(directory);
  const parsed = parseDeepRuntimePackage(await readFile(new URL("../../../packages/deep-engine/fixtures/dashboard-composition-v1.json", import.meta.url)));
  if (!parsed.valid) throw new Error("Invalid test fixture");
  const artifact = new TextEncoder().encode(serializeDeepRuntimePackage(parsed.value));
  const authority = { projectId: "project-golden", applicationId: "dashboard-composition-golden", publicationId: "publication-golden", applicationRevision: 1 };
  const body = { schema: "deep-engine.dashboard-publication-freeze" as const, schemaVersion: 1 as const, authority, entryPageId: "page.378d4cac696fa43e72c270f690e15329771ecf6ff6ac0b2cff9e4a2eca2dac15", documentSha256: "a".repeat(64), data: [], resources: [], totalBytes: 0 };
  const freezeManifest = { ...body, manifestSha256: dashboardArchiveCanonicalSha256(body) };
  // 仅结构夹具，不作为真实窗口或正式发布证据。
  const capability = { schema: "deep-engine.dashboard-publication-capability" as const, schemaVersion: 1 as const, authority, freezeManifestSha256: freezeManifest.manifestSha256, sourceSemanticHash: "b".repeat(64), compileGraphHash: "c".repeat(64), targetArtifactHash: sha(artifact), compiler: { id: "test-only", version: "1", sha256: "d".repeat(64), configurationSha256: "e".repeat(64) }, evidence: { verifier: "native-dashboard-window-v1" as const, fixtureSha256: "f".repeat(64), deviceFingerprintSha256: "0".repeat(64), fontSha256: [] }, objects: [] };
  const archive = serializeDashboardOfflineArchive(createDashboardOfflineArchive({ freezeManifest, capability, artifact }));
  const executable = path.join(directory, "fixture.exe");
  const pe = Buffer.alloc(128); pe.writeUInt16LE(0x5a4d); pe.writeUInt32LE(64, 60); pe.writeUInt32LE(0x00004550, 64);
  await writeFile(executable, pe);
  return { directory, executable, archive, artifact, pe };
}

describe("Dashboard Windows portable ZIP", () => {
  it("rejects a valid PE replaced at the deployed path", async () => {
    const input = await fixture();
    const options = { expectedSha256: sha(input.pe) };
    await expect(createDashboardPortableZip(input.archive, input.executable, options)).resolves.toBeInstanceOf(Uint8Array);
    input.pe[100] ^= 1; await writeFile(input.executable, input.pe);
    await expect(createDashboardPortableZip(input.archive, input.executable, options)).rejects.toThrow("changed since deployment");
  });
  it("writes a real deterministic ZIP with identical verified bytes and complete hashes", async () => {
    const input = await fixture();
    const bytes = await createDashboardPortableZip(input.archive, input.executable);
    expect(bytes.slice(0, 2)).toEqual(Uint8Array.of(0x50, 0x4b));
    expect(await createDashboardPortableZip(input.archive, input.executable)).toEqual(bytes);
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    expect(await zip.file("runtime-package.json")!.async("uint8array")).toEqual(input.artifact);
    expect(await zip.file("deep-native-player.exe")!.async("nodebuffer")).toEqual(input.pe);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("text"));
    expect(manifest.artifactSha256).toBe(sha(input.artifact));
    expect(manifest.runtimePackageSha256).not.toBe(manifest.artifactSha256);
    expect(Object.keys(zip.files).sort()).toEqual([...Object.keys(manifest.files), "manifest.json"].sort());
    for (const [name, expected] of Object.entries(manifest.files)) expect(sha(await zip.file(name)!.async("uint8array"))).toBe(expected);
    expect(await zip.file("LICENSE")!.async("text")).toContain("Deep Monkey");
    expect(await zip.file("THIRD_PARTY_NOTICES.md")!.async("text")).toContain("jszip");
  });

  it("rejects tampered DMDA, non-PE executables, DLLs, relative paths and cancellation", async () => {
    const input = await fixture();
    const bad = input.archive.slice(); bad[bad.length - 1] ^= 1;
    await expect(createDashboardPortableZip(bad, input.executable)).rejects.toThrow();
    await expect(createDashboardPortableZip(input.archive, "fixture.exe")).rejects.toThrow("absolute");
    await writeFile(input.executable, "not executable");
    await expect(createDashboardPortableZip(input.archive, input.executable)).rejects.toThrow("PE");
    input.pe.writeUInt16LE(0x2000, 86); await writeFile(input.executable, input.pe);
    await expect(createDashboardPortableZip(input.archive, input.executable)).rejects.toThrow("DLL");
    await expect(createDashboardPortableZip(input.archive, input.executable, { signal: AbortSignal.abort() })).rejects.toThrow();
  });

  it.skipIf(process.platform !== "win32")("runs PowerShell rejection paths before any executable launch", async () => {
    const input = await fixture();
    const zip = await JSZip.loadAsync(await createDashboardPortableZip(input.archive, input.executable));
    for (const [name, entry] of Object.entries(zip.files)) await writeFile(path.join(input.directory, name), await entry.async("uint8array"));
    const launch = (...args: string[]) => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(input.directory, "Start-Dashboard.ps1"), ...args], { encoding: "utf8", timeout: 15000 });
    const unknown = launch("--package", "other.json");
    expect(unknown.status).toBe(1); expect(unknown.stderr).toContain("accepts no arguments");
    await writeFile(path.join(input.directory, "runtime-package.json"), "tampered");
    const tampered = launch();
    expect(tampered.status).toBe(1); expect(tampered.stderr).toContain("File hash mismatch");
    const manifestPath = path.join(input.directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files["runtime-package.json"] = sha(Buffer.from("tampered"));
    await writeFile(manifestPath, JSON.stringify(manifest));
    const replacedHash = launch();
    expect(replacedHash.status).toBe(1); expect(replacedHash.stderr).toContain("Manifest payload hash changed");
  });

  it.skipIf(process.platform !== "win32")("launches a local test EXE with only the fixed verified package argument", async () => {
    const input = await fixture();
    const source = path.join(input.directory, "Player.cs");
    await writeFile(source, 'class Player { static int Main(string[] args) { System.IO.File.WriteAllLines(System.IO.Path.Combine(System.AppDomain.CurrentDomain.BaseDirectory, "received.txt"), args); return 0; } }');
    const compiler = path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    execFileSync(compiler, ["/nologo", "/target:exe", `/out:${input.executable}`, source], { windowsHide: true });
    const zip = await JSZip.loadAsync(await createDashboardPortableZip(input.archive, input.executable));
    for (const [name, entry] of Object.entries(zip.files)) await writeFile(path.join(input.directory, name), await entry.async("uint8array"));
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(input.directory, "Start-Dashboard.ps1")], { encoding: "utf8", timeout: 15000 });
    expect(result.stderr).toBe(""); expect(result.status).toBe(0);
    expect((await readFile(path.join(input.directory, "received.txt"), "utf8")).trim().split(/\r?\n/)).toEqual(["--package", path.join(input.directory, "runtime-package.json")]);
  });
});
