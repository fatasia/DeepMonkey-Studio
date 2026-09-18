import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PublishedSceneRecord } from "@bim-studio/contracts";
import type { CloudRenderWorkerClient, CloudRenderWorkerSession } from "@bim-studio/server-sdk";
import { cloudRenderPublicationIdentity } from "./cloudRenderPublicationIdentity.js";
import { CloudRenderControlPlane, MemoryCloudRenderRegistry, JsonCloudRenderRegistry } from "./cloudRenderControl.js";

const NOW = "2026-09-15T12:00:10.000Z", AT = "2026-09-15T12:00:00.000Z";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
function publication(): PublishedSceneRecord {
  return { projectId: "project", sceneId: "scene", version: 2, name: "Scene", publishedAt: AT,
    snapshot: { schemaVersion: 1, id: "scene", projectId: "project", name: "Scene", models: [], primitives: [], measurements: [],
      camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 }, target: { x: 0, y: 0, z: 0 } }, createdAt: AT, updatedAt: AT } };
}
async function fixture() {
  const registry = new MemoryCloudRenderRegistry();
  const response: CloudRenderWorkerSession = { contractVersion: 1, workerSessionId: "worker", sceneId: "scene", publishedAt: AT, state: "starting" };
  const worker: CloudRenderWorkerClient = {
    health: vi.fn<CloudRenderWorkerClient["health"]>().mockResolvedValue({ contractVersion: 1, workerId: "worker", status: "ready", observedAt: NOW,
      capacity: { maxSessions: 4, activeSessions: 0 }, gpu: { vendor: "NVIDIA", model: "L40S", memoryMiB: 48000, encoder: { hardware: true, codecs: ["h264"] } } }),
    createSession: vi.fn<CloudRenderWorkerClient["createSession"]>().mockResolvedValue(response),
    getSession: vi.fn<CloudRenderWorkerClient["getSession"]>().mockResolvedValue(response),
    stopSession: vi.fn<CloudRenderWorkerClient["stopSession"]>().mockResolvedValue(undefined),
  };
  const reopen = async () => {
    const control = new CloudRenderControlPlane(registry, { worker, publicOrigin: "https://studio.example.test", now: () => new Date(NOW) });
    await control.init(); return control;
  };
  const control = await reopen(), published = publication();
  await control.setEnabled(published, true); await control.startSession(published, "admin");
  return { control, registry, worker, published, reopen };
}

describe("cloud render durable publication identity", () => {
  it("canonicalizes reordered JSON and undefined while retaining explicit version and scene content", () => {
    const original = publication();
    const reordered = Object.fromEntries(Object.entries(original).reverse()) as unknown as PublishedSceneRecord;
    reordered.snapshot = { ...original.snapshot, thumbnail: undefined } as unknown as PublishedSceneRecord["snapshot"];
    expect(cloudRenderPublicationIdentity(reordered)).toBe(cloudRenderPublicationIdentity(original));
    expect(cloudRenderPublicationIdentity({ ...original, version: 1 })).not.toBe(cloudRenderPublicationIdentity(original));
    const changed = structuredClone(original); changed.snapshot.camera.position.x++;
    expect(cloudRenderPublicationIdentity(changed)).not.toBe(cloudRenderPublicationIdentity(original));
  });
  it.each(["version", "snapshot"])("does not stop or refresh another %s at the same timestamp", async field => {
    const { control, registry, worker, published } = await fixture();
    const stale = structuredClone(published);
    if (field === "version") stale.version = 1; else stale.snapshot.camera.position.x++;
    const before = await registry.load();
    await expect(control.setEnabled(stale, false)).rejects.toMatchObject({ code: "publication_changed" });
    await expect(control.stopSession(stale.sceneId, stale)).rejects.toMatchObject({ code: "publication_changed" });
    await expect(control.refreshSession(stale)).rejects.toMatchObject({ code: "publication_changed" });
    await expect(control.startSession(stale, "admin")).rejects.toMatchObject({ code: "publication_changed" });
    expect(worker.stopSession).not.toHaveBeenCalled(); expect(worker.getSession).not.toHaveBeenCalled();
    expect(await registry.load()).toEqual(before);
    expect((await control.overview([stale])).scenes[0]!.publicationChanged).toBe(true);
  });
  it("persists the full identity and restores matching version operations", async () => {
    const { registry, worker, published, reopen } = await fixture();
    expect((await registry.load()).sessions[0]!.publicationIdentity).toBe(cloudRenderPublicationIdentity(published));
    const restored = await reopen();
    await expect(restored.stopSession(published.sceneId, { ...published, version: 1 })).rejects.toMatchObject({ code: "publication_changed" });
    expect(worker.stopSession).not.toHaveBeenCalled();
    expect((await restored.overview([published])).scenes[0]!.publicationChanged).toBe(false);
    await restored.setEnabled(published, false);
    expect(worker.stopSession).toHaveBeenCalledExactlyOnceWith("worker");
    expect((await registry.load()).sessions[0]!.publicationIdentity).toBe(cloudRenderPublicationIdentity(published));
  });
  it("refuses legacy version-bound operations but permits administrator stop and rebuild", async () => {
    const { registry, worker, published, reopen } = await fixture();
    const legacy = await registry.load(); delete legacy.sessions[0]!.publicationIdentity; await registry.save(legacy);
    const restored = await reopen();
    await expect(restored.setEnabled(published, false)).rejects.toMatchObject({ code: "publication_identity_missing", message: expect.stringContaining("管理员停止旧会话") });
    await expect(restored.refreshSession(published)).rejects.toMatchObject({ code: "publication_identity_missing" });
    await expect(restored.startSession(published, "admin")).rejects.toMatchObject({ code: "publication_identity_missing" });
    await expect(restored.stopSession(published.sceneId, published)).rejects.toMatchObject({ code: "publication_identity_missing" });
    expect(worker.stopSession).not.toHaveBeenCalled();
    expect((await restored.overview([published])).scenes[0]!.publicationChanged).toBe(true);
    await restored.stopSession(published.sceneId);
    await restored.setEnabled(published, true); await restored.startSession(published, "admin");
    expect((await registry.load()).sessions[0]!.publicationIdentity).toBe(cloudRenderPublicationIdentity(published));
    expect(worker.stopSession).toHaveBeenCalledTimes(1);
  });
  it("retains version identity through a real JSON registry and fresh control instance", async () => {
    const { worker, published } = await fixture();
    vi.mocked(worker.stopSession).mockClear();
    const directory = await mkdtemp(path.join(tmpdir(), "bim-cloud-identity-")); directories.push(directory);
    const options = { worker, publicOrigin: "https://studio.example.test", now: () => new Date(NOW) };
    const first = new CloudRenderControlPlane(new JsonCloudRenderRegistry(directory), options);
    await first.init(); await first.setEnabled(published, true); await first.startSession(published, "admin");
    const diskRegistry = new JsonCloudRenderRegistry(directory);
    expect((await diskRegistry.load()).sessions[0]!.publicationIdentity).toBe(cloudRenderPublicationIdentity(published));
    const restored = new CloudRenderControlPlane(diskRegistry, options); await restored.init();
    await expect(restored.stopSession(published.sceneId, { ...published, version: 1 })).rejects.toMatchObject({ code: "publication_changed" });
    expect(worker.stopSession).not.toHaveBeenCalled();
    await restored.stopSession(published.sceneId, published);
    expect(worker.stopSession).toHaveBeenCalledExactlyOnceWith("worker");
    expect((await new JsonCloudRenderRegistry(directory).load()).sessions[0]!.snapshot.state).toBe("closed");
  });
  it.each(["a".repeat(63), "g".repeat(64)])("rejects malformed persisted identity %s", async identity => {
    const { registry, reopen } = await fixture();
    const record = await registry.load(); record.sessions[0]!.publicationIdentity = identity; await registry.save(record);
    await expect(reopen()).rejects.toThrow("发布身份损坏");
  });
  it("freezes the publication before waiting on Worker health", async () => {
    const { control, registry, worker, published } = await fixture();
    await control.stopSession(published.sceneId);
    const original = structuredClone(published);
    const healthy = await worker.health();
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(worker.health).mockImplementationOnce(async () => { await waiting; return healthy; });
    const starting = control.startSession(published, "admin");
    published.version = 3; published.snapshot.camera.position.x = 900;
    finish(); await starting;
    expect((await registry.load()).sessions[0]!.publicationIdentity).toBe(cloudRenderPublicationIdentity(original));
    await expect(control.stopSession(published.sceneId, published)).rejects.toMatchObject({ code: "publication_changed" });
    await control.stopSession(original.sceneId, original);
  });
});
