import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { parseDeepRuntimePackage, serializeDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { createDashboardOfflineArchive, dashboardArchiveCanonicalSha256 } from "./dashboardOfflineArchive.js";
import { serializeDashboardOfflineArchive } from "./dashboardOfflineArchiveBytes.js";
import { createDashboardOfflineNativeLaunchPlan } from "./dashboardOfflineNativeLauncher.js";
import { runDashboardOfflineNative } from "./dashboardOfflineNativeProcess.js";

const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

async function validArchiveBytes(): Promise<Uint8Array> {
  const fixture = new Uint8Array(await readFile(new URL("../../../packages/deep-engine/fixtures/dashboard-composition-v1.json", import.meta.url)));
  const parsed = parseDeepRuntimePackage(fixture);
  if (!parsed.valid) throw new Error("dashboard fixture invalid");
  const artifact = new TextEncoder().encode(serializeDeepRuntimePackage(parsed.value));
  const authority = { projectId: "project-golden", applicationId: "dashboard-composition-golden", publicationId: "publication-golden", applicationRevision: 1 } as const;
  const resource = { id: "font-main", kind: "font" as const, objectKey: "projects/project-golden/fonts/main.woff2", mime: "font/woff2", nodeIds: ["node-main"], revision: 1, bytes: 3, sha256: sha(Uint8Array.of(1, 2, 3)), faceIndex: 0, licenseEvidence: "OFL" };
  const freezeBody = { schema: "deep-engine.dashboard-publication-freeze" as const, schemaVersion: 1 as const, authority, entryPageId: "page.378d4cac696fa43e72c270f690e15329771ecf6ff6ac0b2cff9e4a2eca2dac15", documentSha256: "a".repeat(64), data: [], resources: [resource], totalBytes: 3 };
  const freezeManifest = { ...freezeBody, manifestSha256: dashboardArchiveCanonicalSha256(freezeBody) };
  const capability = { schema: "deep-engine.dashboard-publication-capability" as const, schemaVersion: 1 as const, authority, freezeManifestSha256: freezeManifest.manifestSha256, sourceSemanticHash: "b".repeat(64), compileGraphHash: "c".repeat(64), targetArtifactHash: sha(artifact), compiler: { id: "native-dashboard-v5", version: "1.0.0", sha256: "d".repeat(64), configurationSha256: "e".repeat(64) }, evidence: { verifier: "native-dashboard-window-v1" as const, fixtureSha256: "f".repeat(64), deviceFingerprintSha256: "0".repeat(64), fontSha256: [{ resourceId: resource.id, sha256: resource.sha256, faceIndex: 0 }] }, objects: [{ nodeId: "node-main", status: "supported" as const, deferredFields: [] }] };
  return serializeDashboardOfflineArchive(createDashboardOfflineArchive({ freezeManifest, capability, artifact }));
}

describe("dashboard offline native launcher", () => {
  it.each(["spawn-error", "nonzero-exit"])("cleans runtime files after %s", async failure => {
    const child = new EventEmitter();
    let directory = "";
    const spawnProcess = vi.fn((_exe: string, _args: string[], options: { cwd: string }) => {
      directory = options.cwd; return child;
    });
    const running = runDashboardOfflineNative(await validArchiveBytes(), process.execPath,
      { spawnProcess: spawnProcess as unknown as typeof spawn });
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    const rejection = expect(running).rejects.toThrow(failure === "spawn-error" ? "spawn failed" : "Native Dashboard exited: 2");
    if (failure === "spawn-error") child.emit("error", new Error("spawn failed"));
    expect((await stat(directory)).isDirectory()).toBe(true);
    child.emit("close", 2, null);
    await rejection;
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passes exact validated bytes to the process and cleans only after close", async () => {
    const bytes = await validArchiveBytes();
    const expected = createDashboardOfflineNativeLaunchPlan(bytes);
    const child = new EventEmitter();
    let directory = "", packagePath = "";
    const spawnProcess = vi.fn((_exe: string, args: string[], options: { cwd: string; shell: boolean }) => {
      expect(_exe).toBe(process.execPath);
      expect(options.shell).toBe(false);
      expect(args).toHaveLength(2);
      expect(args[0]).toBe("--package");
      directory = options.cwd; packagePath = args[1]!;
      return child;
    });
    const running = runDashboardOfflineNative(bytes, process.execPath, { spawnProcess: spawnProcess as unknown as typeof spawn });
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    expect(sha(await readFile(packagePath))).toBe(expected.targetArtifactHash);
    child.emit("exit", 0);
    expect((await stat(packagePath)).isFile()).toBe(true);
    child.emit("close", 0, null);
    await expect(running).resolves.toMatchObject({ status: "closed", targetArtifactHash: expected.targetArtifactHash });
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("kills cancelled playback and retains files until the child closes", async () => {
    const controller = new AbortController();
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
    let directory = "";
    const spawnProcess = vi.fn((_exe: string, _args: string[], options: { cwd: string }) => {
      directory = options.cwd; return child;
    });
    const running = runDashboardOfflineNative(await validArchiveBytes(), process.execPath,
      { signal: controller.signal, spawnProcess: spawnProcess as unknown as typeof spawn });
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    const reason = new Error("playback cancelled");
    controller.abort(reason);
    expect(child.kill).toHaveBeenCalledOnce();
    expect((await stat(directory)).isDirectory()).toBe(true);
    const rejection = expect(running).rejects.toBe(reason);
    child.emit("close", null, "SIGTERM");
    await rejection;
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never spawns for tampered archive bytes", async () => {
    const bytes = await validArchiveBytes(); bytes[bytes.length - 1] ^= 1;
    const spawnProcess = vi.fn();
    await expect(runDashboardOfflineNative(bytes, process.execPath, { spawnProcess })).rejects.toThrow();
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("turns verified DMDA bytes into a minimal local native plan", async () => {
    const bytes = await validArchiveBytes();
    const plan = createDashboardOfflineNativeLaunchPlan(bytes);
    expect(plan).toMatchObject({ protocol: "dashboard-offline-native-launch-plan-v1", target: "deep-native-dashboard-v5", authority: { projectId: "project-golden", applicationId: "dashboard-composition-golden", publicationId: "publication-golden", applicationRevision: 1 }, sourceSemanticHash: "b".repeat(64), compileGraphHash: "c".repeat(64), targetArtifactHash: sha(plan.artifact) });
    expect(Object.keys(plan).sort()).toEqual(["archiveManifestSha256", "artifact", "authority", "compileGraphHash", "entryPageId", "protocol", "runtimePackageSha256", "sourceSemanticHash", "target", "targetArtifactHash"]);
    expect(JSON.stringify(plan)).not.toContain("objectKey");
    expect(JSON.stringify(plan)).not.toContain("https:");
    expect(JSON.stringify(plan)).not.toContain("browser");
  });

  it("copies archive payloads so native-plan mutation cannot change caller bytes", async () => {
    const bytes = await validArchiveBytes();
    const before = Uint8Array.from(bytes);
    const plan = createDashboardOfflineNativeLaunchPlan(bytes);
    plan.artifact[0] ^= 1;
    expect(bytes).toEqual(before);
    expect(plan.authority).not.toBeUndefined();
  });

  it("fails closed for malformed or artifact-tampered DMDA bytes", async () => {
    const bytes = await validArchiveBytes();
    expect(() => createDashboardOfflineNativeLaunchPlan(bytes.subarray(0, 11))).toThrow("truncated");
    const altered = Uint8Array.from(bytes);
    altered[altered.byteLength - 1] ^= 1;
    expect(() => createDashboardOfflineNativeLaunchPlan(altered)).toThrow();
  });
});
