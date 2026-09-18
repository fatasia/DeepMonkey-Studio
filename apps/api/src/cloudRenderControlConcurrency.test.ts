import { describe, expect, it, vi } from "vitest";
import type { PublishedSceneRecord } from "@bim-studio/contracts";
import type { CloudRenderWorkerClient, CloudRenderWorkerHealth, CloudRenderWorkerSession } from "@bim-studio/server-sdk";
import { CloudRenderControlPlane, MemoryCloudRenderRegistry } from "./cloudRenderControl.js";

const NOW = "2026-09-15T12:00:10.000Z";
const CURRENT = "2026-09-15T12:00:00.000Z";

describe("cloud render concurrency", () => {
  it("rejects an old publication disable without stopping the current session or changing policy", async () => {
    const { control, registry, worker, publication } = await fixture();
    await control.startSession(publication, "admin");
    const before = await registry.load();
    const result = await settle(control.setEnabled({ ...publication, publishedAt: "2026-09-14T12:00:00.000Z" }, false));
    expect(result.status).toBe("rejected");
    expect(worker.stopSession).not.toHaveBeenCalled();
    expect(await registry.load()).toEqual(before);
  });

  it("rejects an old publication refresh without marking the current session failed", async () => {
    const { control, registry, worker, publication } = await fixture();
    await control.startSession(publication, "admin");
    const before = await registry.load();
    await expect(control.refreshSession({ ...publication, publishedAt: "2026-09-14T12:00:00.000Z" })).rejects.toMatchObject({ statusCode: 409 });
    expect(worker.getSession).not.toHaveBeenCalled();
    expect(await registry.load()).toEqual(before);
  });

  it("permits only one concurrent start while the Worker health request is pending", async () => {
    const { control, worker, publication } = await fixture();
    const gate = healthGate(worker);
    const first = settle(control.startSession(publication, "admin-1"));
    await gate.entered;
    const second = settle(control.startSession(publication, "admin-2"));
    gate.release();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(worker.createSession).toHaveBeenCalledTimes(1);
  });

  it("does not allocate after disable succeeds during the pending health check", async () => {
    const { control, registry, worker, publication } = await fixture();
    const gate = healthGate(worker);
    const starting = settle(control.startSession(publication, "admin"));
    await gate.entered;
    await control.setEnabled(publication, false);
    gate.release();
    expect((await starting).status).toBe("rejected");
    expect(worker.createSession).not.toHaveBeenCalled();
    expect((await registry.load()).policies[0]?.enabled).toBe(false);
    expect((await registry.load()).sessions).toEqual([]);
  });

  it("does not let a delayed disable overwrite a newer enable policy", async () => {
    const { control, registry, worker, publication } = await fixture();
    await control.startSession(publication, "admin");
    const gate = deferred<void>();
    vi.mocked(worker.stopSession).mockImplementation(async () => { gate.enter(); await gate.result; });
    const disabling = settle(control.setEnabled(publication, false));
    await gate.entered;
    await control.setEnabled(publication, true);
    gate.resolve(undefined);
    expect(await disabling).toMatchObject({ status: "rejected", reason: { statusCode: 409, code: "policy_changed" } });
    expect((await registry.load()).policies[0]?.enabled).toBe(true);
    expect((await registry.load()).sessions[0]?.snapshot.state).toBe("closed");
  });

  it.each(["success", "error"] as const)("ignores late refresh %s after shutdown is confirmed", async (outcome) => {
    const { control, registry, worker, publication, response } = await fixture();
    await control.startSession(publication, "admin");
    const gate = deferred<CloudRenderWorkerSession>();
    vi.mocked(worker.getSession).mockImplementation(async () => { gate.enter(); return gate.result; });
    const refreshing = settle(control.refreshSession(publication));
    await gate.entered;
    await control.stopSession(publication.sceneId);
    const closed = await registry.load();
    expect(closed.sessions[0]?.snapshot.state).toBe("closed");
    if (outcome === "error") gate.reject(new Error("late Worker failure"));
    else gate.resolve({ ...response, state: "media-ready", mediaEvidence: {
      kind: "webrtc-outbound-rtp", observedAt: NOW, peerConnectionId: "peer-1", videoTrackId: "track-1",
      codec: "h264", hardwareEncoder: true, encoderImplementation: "NVIDIA NVENC", encoderEvidence: "runtime-stats",
      width: 1920, height: 1080, framesEncoded: 120, packetsSent: 480, bytesSent: 1_200_000,
    } });
    expect(await refreshing).toMatchObject({ status: "fulfilled", value: { state: "closed" } });
    expect(await registry.load()).toEqual(closed);
  });

  it("releases the pending start slot after health failure so a retry can allocate", async () => {
    const { control, worker, publication } = await fixture();
    vi.mocked(worker.health).mockRejectedValueOnce(new Error("health unavailable"));
    await expect(control.startSession(publication, "admin")).rejects.toThrow();
    expect(worker.createSession).not.toHaveBeenCalled();
    await expect(control.startSession(publication, "admin")).resolves.toMatchObject({ state: "signaling" });
    expect(worker.createSession).toHaveBeenCalledTimes(1);
  });

  it("shares one Worker shutdown for concurrent stops of the same session", async () => {
    const { control, worker, publication } = await fixture();
    await control.startSession(publication, "admin");
    const gate = deferred<void>();
    vi.mocked(worker.stopSession).mockImplementation(async () => { gate.enter(); await gate.result; });
    const first = settle(control.stopSession(publication.sceneId));
    await gate.entered;
    const second = settle(control.stopSession(publication.sceneId));
    expect(worker.stopSession).toHaveBeenCalledTimes(1);
    gate.resolve(undefined);
    expect(await first).toMatchObject({ status: "fulfilled", value: { state: "closed" } });
    expect(await second).toMatchObject({ status: "fulfilled", value: { state: "closed" } });
    expect(worker.stopSession).toHaveBeenCalledTimes(1);
  });

  it("serializes registry writes across different scene policies", async () => {
    const registry = new PausingRegistry();
    const { control, publication } = await fixture(registry);
    const other = { ...publication, sceneId: "scene-2", snapshot: { ...publication.snapshot, id: "scene-2" } };
    await control.setEnabled(other, true);
    const gate = registry.pause();
    const first = control.setEnabled(publication, false);
    await gate.entered;
    const second = control.setEnabled(other, false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const writesWhileBlocked = registry.writeEntries;
    gate.resolve(undefined);
    await Promise.all([first, second]);
    expect(writesWhileBlocked).toBe(1);
    expect(registry.maxConcurrent).toBe(1);
    expect(registry.writeEntries).toBe(2);
    expect((await registry.load()).policies.map((policy) => [policy.sceneId, policy.enabled])).toEqual([
      ["scene-1", false], ["scene-2", false],
    ]);
  });

  it.each(["disable", "stop"] as const)("waits for in-flight creation and Worker acknowledgement before %s completes", async (action) => {
    const { control, registry, worker, publication, response } = await fixture();
    const creating = deferred<CloudRenderWorkerSession>(), closing = deferred<void>();
    vi.mocked(worker.createSession).mockImplementation(async () => { creating.enter(); return creating.result; });
    vi.mocked(worker.stopSession).mockImplementation(async () => { closing.enter(); return closing.result; });
    const starting = settle(control.startSession(publication, "admin")); await creating.entered;
    let completed = false;
    const stopping = settle(action === "disable" ? control.setEnabled(publication, false) : control.stopSession(publication.sceneId))
      .then((value) => { completed = true; return value; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completed).toBe(false); expect(worker.stopSession).not.toHaveBeenCalled();
    creating.resolve(response); await closing.entered;
    expect(completed).toBe(false);
    expect(worker.stopSession).toHaveBeenCalledWith(response.workerSessionId);
    expect((await registry.load()).policies[0]?.enabled).toBe(true);
    closing.resolve(undefined);
    expect((await stopping).status).toBe("fulfilled");
    expect(await starting).toMatchObject({ status: "rejected", reason: { code: "session_cancelled" } });
    expect((await registry.load()).sessions[0]?.snapshot.state).toBe("closed");
    expect((await registry.load()).policies[0]?.enabled).toBe(action !== "disable");
  });

  it("preserves a create failure while a disable waits and releases the pending start reservation", async () => {
    const { control, registry, worker, publication } = await fixture();
    const creating = deferred<CloudRenderWorkerSession>();
    vi.mocked(worker.createSession).mockImplementation(async () => { creating.enter(); return creating.result; });
    const starting = settle(control.startSession(publication, "admin")); await creating.entered;
    const disabling = settle(control.setEnabled(publication, false));
    creating.reject(new Error("Worker creation rejected"));
    expect(await starting).toMatchObject({ status: "rejected", reason: { code: "worker_create_failed" } });
    expect(await disabling).toMatchObject({ status: "rejected", reason: { code: "worker_create_failed" } });
    expect(worker.stopSession).not.toHaveBeenCalled();
    expect((await registry.load()).sessions[0]?.snapshot).toMatchObject({ state: "failed", failureCode: "worker_create_failed" });
    expect((await registry.load()).policies[0]?.enabled).toBe(true);
    // 未确认的失败会话仍阻止新分配，但不得误报仍在启动。
    await expect(control.startSession(publication, "admin")).rejects.toThrow("仍有云渲染会话");
  });

  it("retains the late-created Worker identity when shutdown fails and allows a stop retry", async () => {
    const { control, registry, worker, publication, response } = await fixture();
    const creating = deferred<CloudRenderWorkerSession>();
    vi.mocked(worker.createSession).mockImplementation(async () => { creating.enter(); return creating.result; });
    vi.mocked(worker.stopSession).mockRejectedValueOnce(new Error("stop unavailable"));
    const starting = settle(control.startSession(publication, "admin")); await creating.entered;
    const disabling = settle(control.setEnabled(publication, false));
    creating.resolve(response);
    expect(await disabling).toMatchObject({ status: "rejected", reason: { code: "worker_stop_failed" } });
    expect(await starting).toMatchObject({ status: "rejected", reason: { code: "worker_stop_failed" } });
    expect((await registry.load()).sessions[0]?.snapshot).toMatchObject({ state: "failed", workerSessionId: response.workerSessionId });
    await expect(control.setEnabled(publication, false)).resolves.toMatchObject({ enabled: false });
    expect(worker.stopSession).toHaveBeenCalledTimes(2);
    expect((await registry.load()).sessions[0]?.snapshot.state).toBe("closed");
  });
});

class PausingRegistry extends MemoryCloudRenderRegistry {
  writeEntries = 0;
  maxConcurrent = 0;
  private active = 0;
  private pending?: ReturnType<typeof deferred<void>>;
  pause() {
    this.writeEntries = 0; this.maxConcurrent = 0;
    this.pending = deferred<void>(); return this.pending;
  }
  override async save(document: Parameters<MemoryCloudRenderRegistry["save"]>[0]): Promise<void> {
    this.writeEntries++; this.active++; this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    const gate = this.pending; this.pending = undefined;
    try {
      if (gate) { gate.enter(); await gate.result; }
      await super.save(document);
    } finally { this.active--; }
  }
}

function deferred<T>() {
  let enter!: () => void, resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const entered = new Promise<void>((done) => { enter = done; });
  const result = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { enter, entered, result, resolve, reject };
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then((value) => ({ status: "fulfilled", value }), (reason: unknown) => ({ status: "rejected", reason }));
}

function healthGate(worker: CloudRenderWorkerClient) {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  vi.mocked(worker.health).mockImplementation(async () => { enter(); await waiting; return health(); });
  return { entered, release };
}

async function fixture(registry = new MemoryCloudRenderRegistry()) {
  const response: CloudRenderWorkerSession = { contractVersion: 1, workerSessionId: "worker-session-1",
    sceneId: "scene-1", publishedAt: CURRENT, state: "starting" };
  const worker: CloudRenderWorkerClient = {
    health: vi.fn<CloudRenderWorkerClient["health"]>().mockResolvedValue(health()),
    createSession: vi.fn<CloudRenderWorkerClient["createSession"]>().mockResolvedValue(response),
    getSession: vi.fn<CloudRenderWorkerClient["getSession"]>().mockResolvedValue(response),
    stopSession: vi.fn<CloudRenderWorkerClient["stopSession"]>().mockResolvedValue(undefined),
  };
  const control = new CloudRenderControlPlane(registry, { worker, publicOrigin: "https://studio.example.test", now: () => new Date(NOW) });
  await control.init();
  const publication: PublishedSceneRecord = { sceneId: "scene-1", projectId: "default", name: "工厂", publishedAt: CURRENT,
    snapshot: { schemaVersion: 1, id: "scene-1", projectId: "default", name: "工厂", models: [], primitives: [], measurements: [],
      camera: { mode: "orbit", position: { x: 1, y: 1, z: 1 }, target: { x: 0, y: 0, z: 0 } }, createdAt: CURRENT, updatedAt: CURRENT } };
  await control.setEnabled(publication, true);
  return { control, registry, worker, publication, response };
}

function health(): CloudRenderWorkerHealth {
  return { contractVersion: 1, workerId: "worker-1", status: "ready", observedAt: NOW,
    capacity: { maxSessions: 4, activeSessions: 1 },
    gpu: { vendor: "NVIDIA", model: "L40S", memoryMiB: 48_000, encoder: { hardware: true, codecs: ["h264"] } } };
}
