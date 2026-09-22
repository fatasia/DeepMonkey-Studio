import type { ConversionTaskRecord, ConverterPluginManifest } from "@bim-studio/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { ConversionTaskService, type ConverterExecutionContext } from "./conversionTasks.js";
import type { ConversionPersistence } from "./conversionLeaseSession.js";
import type { ConversionTaskLease } from "./conversionTaskLease.js";
const manifest: ConverterPluginManifest = { contractVersion: 1, id: "test.lease", name: "lease", version: "1", execution: "server-worker",
  inputFormats: ["obj"], outputs: [{ kind: "geometry", format: "glb", required: true }], configurationSchema: { type: "object" }, capabilities: [],
  limits: { timeoutMs: 100000, maxInputBytes: 100, maxOutputBytes: 100, maxMemoryMb: 256, maxCpuPercent: 100 } };
const request = { projectId: "project", pluginId: manifest.id, input: { objectKey: "projects/project/source/input.obj", fileName: "input.obj", format: "obj", size: 1 } };
const artifact = (context: ConverterExecutionContext) => ({ kind: "geometry" as const, format: "glb", objectKey: `${context.outputPrefix}geometry.glb`, size: 1 });
function persistence() {
  const records = new Map<string, ConversionTaskRecord>(), leases = new Map<string, ConversionTaskLease>();
  const store: ConversionPersistence = {
    listConversionTasks: () => [...records.values()].map(row => structuredClone(row)),
    refreshConversionTasks: async () => store.listConversionTasks(),
    saveConversionTask: vi.fn(async (task, _updates, token) => {
      if (leases.has(task.id) && token?.ownerId !== leases.get(task.id)!.ownerId) throw new Error("lease fence rejected");
      records.set(task.id, structuredClone(task));
    }),
    acquireConversionTaskLease: vi.fn(async (taskId, ownerId) => {
      if (leases.has(taskId)) return undefined;
      const lease = { taskId, ownerId, epoch: "1", expiresAt: new Date(Date.now() + 30000).toISOString() };
      leases.set(taskId, lease); return lease;
    }),
    renewConversionTaskLease: vi.fn(async lease => leases.get(lease.taskId)),
    releaseConversionTaskLease: vi.fn(async lease => { if (leases.get(lease.taskId)?.ownerId === lease.ownerId) leases.delete(lease.taskId); }),
    activeConversionTaskLease: async id => leases.has(id),
    requestConversionCancellation: async id => {
      const lease = leases.get(id);if (!lease) return false;
      leases.set(id, { ...lease, cancelRequested: true });return true;
    },
  };
  return { store, records, leases };
}
afterEach(() => vi.useRealTimers());

it("claims before queued persistence, renews during execution, and releases after commit", async () => {
  vi.useFakeTimers();const { store, records, leases } = persistence();let finish!: () => void;
  const service = new ConversionTaskService([{ manifest, execute: async context => {
    await new Promise<void>(resolve => { finish = resolve; });context.publishArtifact(artifact(context));
  } }], undefined, () => "task", store);
  await service.submitDurable(request);await vi.advanceTimersByTimeAsync(10000);
  expect(store.renewConversionTaskLease).toHaveBeenCalledOnce();expect(leases.size).toBe(1);
  expect(records.get("task")?.status).toBe("running");
  for (const call of vi.mocked(store.saveConversionTask).mock.calls) expect(call[2]).toMatchObject({ taskId: "task", epoch: "1" });
  finish();await vi.advanceTimersByTimeAsync(0);
  expect(records.get("task")?.status).toBe("succeeded");expect(leases.size).toBe(0);
  await vi.advanceTimersByTimeAsync(20000);expect(store.renewConversionTaskLease).toHaveBeenCalledTimes(2);
});

it("does not fail another live worker during initialization or mutate it on foreign cancellation", async () => {
  const { store, records } = persistence();let finish!: () => void;
  const registrations = [{ manifest, execute: async (context: ConverterExecutionContext) => {
    await new Promise<void>(resolve => { finish = resolve; });context.publishArtifact(artifact(context));
  } }];
  const first = new ConversionTaskService(registrations, undefined, () => "live", store);
  await first.submitDurable(request);await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const second = new ConversionTaskService(registrations, undefined, undefined, store);await second.initialize();
  expect(second.get("project", "live")?.status).toBe("running");
  expect(() => second.cancel("project", "live")).toThrow("另一执行器");
  expect(records.get("live")?.status).toBe("running");
  finish();await vi.waitFor(() => expect(records.get("live")?.status).toBe("succeeded"));
  await second.refresh();expect(second.get("project", "live")?.status).toBe("succeeded");
});

it("aborts on renewal loss and rejects late output without writing an unfenced terminal state", async () => {
  vi.useFakeTimers();const { store, records } = persistence();let context!: ConverterExecutionContext;
  const service = new ConversionTaskService([{ manifest, execute: async value => { context = value;await new Promise<void>(() => {}); } }], undefined, () => "lost", store);
  await service.submitDurable(request);await vi.advanceTimersByTimeAsync(0);
  vi.mocked(store.renewConversionTaskLease!).mockResolvedValueOnce(undefined);
  await vi.advanceTimersByTimeAsync(10000);
  expect(context.signal.aborted).toBe(true);expect(service.get("project", "lost")?.status).toBe("failed");
  expect(records.get("lost")?.status).toBe("running");
  expect(() => context.publishArtifact(artifact(context))).toThrow("不在运行中");
  await service.refresh();expect(records.get("lost")?.status).toBe("failed");
});

it("cleans up a lease when queued persistence fails and never invokes the executor", async () => {
  const { store, leases } = persistence();const execute = vi.fn();
  vi.mocked(store.saveConversionTask).mockRejectedValueOnce(new Error("database unavailable"));
  const service = new ConversionTaskService([{ manifest, execute }], undefined, () => "rejected", store);
  await expect(service.submitDurable(request)).rejects.toThrow("database unavailable");
  expect(leases.size).toBe(0);expect(execute).not.toHaveBeenCalled();expect(service.get("project", "rejected")).toBeUndefined();
});

it("delivers remote cancellation on heartbeat and refuses requests from another project", async () => {
  vi.useFakeTimers();const { store, records } = persistence();let context!: ConverterExecutionContext;
  const first = new ConversionTaskService([{ manifest, execute: async value => { context=value;await new Promise<void>(()=>{}); } }], undefined, ()=>"remote", store);
  await first.submitDurable(request);await vi.advanceTimersByTimeAsync(0);
  const second = new ConversionTaskService([], undefined, undefined, store);await second.initialize();
  await expect(second.cancelDurable("wrong-project", "remote")).rejects.toThrow("不存在");
  expect((await second.cancelDurable("project", "remote")).status).toBe("cancelling");
  await vi.advanceTimersByTimeAsync(10000);
  expect(context.signal.aborted).toBe(true);expect(records.get("remote")?.status).toBe("cancelled");
  expect(records.get("remote")?.artifacts).toEqual([]);
});

it("checks remote cancellation before completion even before the next heartbeat", async () => {
  vi.useFakeTimers();const { store, records } = persistence();let finish!:()=>void;
  const first=new ConversionTaskService([{manifest,execute:async context=>{await new Promise<void>(resolve=>{finish=resolve;});context.publishArtifact(artifact(context));}}],undefined,()=>"finish-race",store);
  await first.submitDurable(request);await vi.advanceTimersByTimeAsync(0);
  const second=new ConversionTaskService([],undefined,undefined,store);await second.initialize();
  await second.cancelDurable("project","finish-race");finish();await vi.advanceTimersByTimeAsync(0);
  expect(records.get("finish-race")?.status).toBe("cancelled");expect(records.get("finish-race")?.artifacts).toEqual([]);
});
