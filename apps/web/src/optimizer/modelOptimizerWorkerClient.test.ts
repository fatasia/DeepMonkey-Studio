import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelOptimizerWorkerClient } from "./modelOptimizerWorkerClient";

class FakeWorker {
  static current: FakeWorker;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { message: string }) => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.current = this; }
}
afterEach(() => vi.unstubAllGlobals());

describe("optimizer worker lifetime", () => {
  it("does not post a delayed file read to a terminated worker", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const client = new ModelOptimizerWorkerClient();
    let release!: (buffer: ArrayBuffer) => void;
    const file = { name: "slow.glb", arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { release = resolve; }) } as File;
    const pending = client.inspect(file).catch(error => error);
    client.terminate(); release(new ArrayBuffer(4));
    await Promise.resolve(); await Promise.resolve();
    expect(FakeWorker.current.postMessage).not.toHaveBeenCalled();
    expect(await pending).toMatchObject({ name: "AbortError" });
  });

  it("rejects later requests after a worker crash instead of hanging", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const client = new ModelOptimizerWorkerClient();
    FakeWorker.current.onerror?.({ message: "worker crashed" });
    const pending = client.inspect(new File([], "next.glb")).catch(error => error);
    await Promise.resolve(); await Promise.resolve();
    expect(FakeWorker.current.postMessage).not.toHaveBeenCalled();
    expect(await pending).toMatchObject({ message: "worker crashed" });
  });

  it("settles pending requests once and ignores messages after termination", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const client = new ModelOptimizerWorkerClient();
    const pending = client.inspect(new File([], "next.glb")).catch(error => error);
    await Promise.resolve(); await Promise.resolve();
    client.terminate(); client.terminate();
    FakeWorker.current.onmessage?.({ data: { id: 1, type: "inspect-result", result: {} } });
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(FakeWorker.current.terminate).toHaveBeenCalledTimes(1);
  });
});
