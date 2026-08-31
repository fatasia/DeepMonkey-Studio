import { describe, expect, it, vi } from "vitest";
import { GpuFrameTimeMonitor } from "./gpuFrameTimeMonitor";

describe("GpuFrameTimeMonitor", () => {
  it("keeps timestamp tracking off until diagnostics explicitly enables it", async () => {
    const backend = { trackTimestamp: true };
    const resolveTimestampsAsync = vi.fn().mockResolvedValue(4.5);
    const monitor = new GpuFrameTimeMonitor({ backend, resolveTimestampsAsync }, 1);

    expect(backend.trackTimestamp).toBe(false);
    monitor.onFrameRendered();
    expect(resolveTimestampsAsync).not.toHaveBeenCalled();

    monitor.setEnabled(true);
    expect(backend.trackTimestamp).toBe(true);
    monitor.onFrameRendered();
    await vi.waitFor(() => expect(monitor.snapshot().sampleCount).toBe(1));
    expect(monitor.snapshot()).toMatchObject({ supported: true, p50Ms: 4.5, p95Ms: 4.5, maximumMs: 4.5 });

    monitor.setEnabled(false);
    expect(backend.trackTimestamp).toBe(false);
  });

  it("ignores an in-flight timestamp after diagnostics closes", async () => {
    let resolveSample!: (value: number) => void;
    const backend = { trackTimestamp: true };
    const monitor = new GpuFrameTimeMonitor({ backend, resolveTimestampsAsync: () => new Promise((resolve) => (resolveSample = resolve)) }, 1);

    monitor.setEnabled(true);
    monitor.onFrameRendered();
    monitor.setEnabled(false);
    resolveSample(8);
    await Promise.resolve();

    expect(monitor.snapshot().sampleCount).toBe(0);
  });

  it("reports unsupported renderers without attempting a query", () => {
    const resolveTimestampsAsync = vi.fn();
    const monitor = new GpuFrameTimeMonitor({ backend: { trackTimestamp: false }, resolveTimestampsAsync }, 1);
    monitor.setEnabled(true);
    monitor.onFrameRendered();

    expect(monitor.snapshot().supported).toBe(false);
    expect(resolveTimestampsAsync).not.toHaveBeenCalled();
  });
});
