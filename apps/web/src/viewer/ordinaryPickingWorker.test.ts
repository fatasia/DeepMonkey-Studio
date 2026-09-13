import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPickingIndex } from "./ordinaryPickingBuild";
import type { PickingSnapshot } from "./ordinaryPickingGeometry";
import { PickingWorker } from "./ordinaryPickingWorker";

const snapshot = (): PickingSnapshot => ({ position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), index: null, start: 0, count: Infinity });
class WorkerFixture {
  static instances: WorkerFixture[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  data: PickingSnapshot | undefined;
  constructor() { WorkerFixture.instances.push(this); }
  postMessage(data: PickingSnapshot, transfer: Transferable[]) { this.data = structuredClone(data, { transfer }); }
  terminate() { this.terminated = true; }
  reply() { this.onmessage?.({ data: { serialized: buildPickingIndex(this.data!) } } as MessageEvent); }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); WorkerFixture.instances = []; });
function setup() { vi.stubGlobal("Worker", WorkerFixture); return new PickingWorker(); }

describe("picking Worker lifecycle", () => {
  it("transfers only the supplied snapshot and reuses the worker serially", async () => {
    const worker = setup(); const source = snapshot(); const pending = worker.build(source, new AbortController().signal);
    expect(source.position.byteLength).toBe(0); const instance = WorkerFixture.instances[0]!; instance.reply();
    expect((await pending).roots.length).toBe(1);
    const second = worker.build(snapshot(), new AbortController().signal); instance.reply(); await second;
    expect(WorkerFixture.instances).toHaveLength(1); worker.dispose(); expect(instance.terminated).toBe(true);
  });

  it.each(["abort", "dispose", "error", "decode", "invalid", "timeout"])("settles %s, releases handlers and permits a clean retry", async (reason) => {
    if (reason === "timeout") vi.useFakeTimers();
    const worker = setup(); const controller = new AbortController(); const pending = worker.build(snapshot(), controller.signal);
    const failure = expect(pending).rejects.toBeInstanceOf(Error); const instance = WorkerFixture.instances[0]!;
    if (reason === "abort") controller.abort();
    if (reason === "dispose") worker.dispose();
    if (reason === "error") instance.onerror?.();
    if (reason === "decode") instance.onmessageerror?.();
    if (reason === "invalid") instance.onmessage?.({ data: { error: "build failed" } } as MessageEvent);
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(30000);
    await failure; expect(instance.terminated).toBe(true); expect(instance.onmessage).toBeNull();
    const retry = worker.build(snapshot(), new AbortController().signal); WorkerFixture.instances[1]!.reply(); await retry; worker.dispose();
  });

  it("falls back cleanly when the browser does not provide Workers", async () => {
    vi.stubGlobal("Worker", undefined); const worker = new PickingWorker();
    await expect(worker.build(snapshot(), new AbortController().signal)).rejects.toThrow("unavailable"); worker.dispose();
  });
});
