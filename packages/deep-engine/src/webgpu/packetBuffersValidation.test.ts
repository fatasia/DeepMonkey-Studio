import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderPacket } from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import { PacketBuffers } from "./packetBuffers.js";
import { mainPipelineKey, shadowPipelineKey, type Pipelines } from "./pipelines.js";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const owned = new Set<GPUBuffer>(), allocated: GPUBuffer[] = [], events: string[] = [];
  const checks: ReturnType<typeof deferred<GPUError | null>>[] = [];
  const device = { limits: { maxBufferSize: 256 * 1024 * 1024 },
    pushErrorScope: vi.fn((filter: string) => { events.push(`push:${filter}`); }),
    popErrorScope: vi.fn(() => { events.push("pop"); const check = deferred<GPUError | null>(); checks.push(check); return check.promise; }),
    createBuffer: vi.fn(({ label }: { label?: string }) => { events.push("create"); const buffer = { label, destroy: vi.fn() } as unknown as GPUBuffer; allocated.push(buffer); return buffer; }),
    queue: { writeBuffer: vi.fn(() => { events.push("write"); }) } };
  const session = { state: "ready", device, own(buffer: GPUBuffer) { owned.add(buffer); return buffer; },
    release(buffer: GPUBuffer) { if (owned.delete(buffer)) buffer.destroy(); } };
  const cache = new PacketBuffers(session as unknown as DeviceSession);
  const pass = { setPipeline: vi.fn(), setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), drawIndexed: vi.fn() };
  const pipelines = { main: "main", shadow: "shadow",
    mainPipelines: new Map([
      [mainPipelineKey("plain", false, "ccw"), "main"], [mainPipelineKey("plain", false, "cw"), "mirror"],
    ]), shadowPipelines: new Map([
      [shadowPipelineKey("solid", "ccw"), "shadow"], [shadowPipelineKey("solid", "cw"), "shadowMirror"],
    ]) } as unknown as Pipelines;
  const draw = () => cache.draw(pass as unknown as GPURenderPassEncoder, pipelines, "opaque");
  const settle = (start = 0) => checks.slice(start, start + 3).forEach(check => check.resolve(null));
  const byLabel = (label: string) => allocated.filter(buffer =>
    (buffer as GPUBuffer & { label?: string }).label === label);
  return { cache, device, session, owned, allocated, events, checks, pass, draw, settle, byLabel };
}

function packet(revision = 0): RenderPacket {
  return { geometries: [{ id: "g", revision, vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    indices: new Uint32Array(revision ? [0, 1, 2, 0, 2, 1] : [0, 1, 2]) }],
    materials: [{ id: "m", baseColor: [0.5, 0.6, 0.7], metallic: 0, roughness: 0.5 }],
    instances: [{ id: "i", geometry: "g", material: "m", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] };
}

beforeEach(() => vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("validated GPU packet publication", () => {
  it("closes all three scopes synchronously and publishes only after every result succeeds", async () => {
    const f = fixture(); f.cache.set(packet()); f.events.length = 0;
    const result = f.cache.setValidated(packet(1)); let settled = false;
    void result.then(() => { settled = true; });
    expect(f.events).toEqual(["push:validation", "push:out-of-memory", "push:internal", "create", "write", "create", "write", "pop", "pop", "pop"]);
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    expect(f.pass.setIndexBuffer).toHaveBeenLastCalledWith(f.allocated[1], "uint32");
    f.checks[0]!.resolve(null); f.checks[2]!.resolve(null); await Promise.resolve();
    expect(settled).toBe(false); expect(f.owned.size).toBe(6);
    f.checks[1]!.resolve(null); expect(await result).toBe(true);
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 2 }); expect(f.owned.size).toBe(4);
    expect(f.allocated[0]!.destroy).toHaveBeenCalledOnce(); expect(f.allocated[1]!.destroy).toHaveBeenCalledOnce();
    expect(f.byLabel("Deep packet instances")[0]!.destroy).not.toHaveBeenCalled();
    expect(f.byLabel("Deep packet previous transforms")[0]!.destroy).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2])("rejects GPU error scope %i and retains the last valid draw", async index => {
    const f = fixture(); f.cache.set(packet());
    const result = f.cache.setValidated(packet(1)); const assertion = expect(result).rejects.toThrow("GPU packet preparation failed: allocation rejected");
    f.checks[index]!.resolve({ message: "allocation rejected" } as GPUError); f.settle(); await assertion;
    expect(f.owned.size).toBe(4); expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    for (const buffer of f.allocated.slice(4)) expect(buffer.destroy).toHaveBeenCalledOnce();
  });

  it("handles rejected scope promises and drains late failures without destroying active buffers", async () => {
    const f = fixture(); f.cache.set(packet());
    const result = f.cache.setValidated(packet(1)); const assertion = expect(result).rejects.toThrow("driver check failed");
    f.checks[0]!.reject(new Error("driver check failed")); await assertion;
    f.checks[1]!.reject(new Error("late internal error")); f.checks[2]!.resolve(null);
    await Promise.allSettled(f.checks.map(check => check.promise));
    expect(f.owned.size).toBe(4); expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    for (const buffer of f.allocated.slice(4)) expect(buffer.destroy).toHaveBeenCalledOnce();
  });

  it("rolls back immediately on abort, with late driver results unable to republish", async () => {
    const f = fixture(), controller = new AbortController(); f.cache.set(packet());
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = f.cache.setValidated(packet(1), controller.signal);
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await assertion; expect(f.owned.size).toBe(4);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    f.checks[0]!.reject(new Error("late driver failure")); f.settle(); await Promise.allSettled(f.checks.map(check => check.promise));
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    for (const buffer of f.allocated.slice(4)) expect(buffer.destroy).toHaveBeenCalledOnce();
  });

  it("lets the later validated request win even when driver checks finish out of order", async () => {
    const f = fixture(); f.cache.set(packet());
    const first = f.cache.setValidated(packet(1)); const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = f.cache.setValidated(packet(2)); await rejected;
    expect(f.owned.size).toBe(6); expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    f.settle(3); expect(await second).toBe(true);
    f.settle(); await Promise.allSettled(f.checks.map(check => check.promise));
    expect(f.owned.size).toBe(4); expect(f.pass.drawIndexed).toHaveBeenCalledWith(3, 1);
    f.draw(); expect(f.pass.setIndexBuffer).toHaveBeenLastCalledWith(f.byLabel("Deep indices").at(-1), "uint32");
    for (const buffer of f.allocated.slice(4, 6)) expect(buffer.destroy).toHaveBeenCalledOnce();
  });

  it.each(["set", "instances"] as const)("lets a synchronous %s supersede preparation", async mode => {
    const f = fixture(), p = packet(); f.cache.set(p);
    const candidate = f.cache.setValidated(packet(1)); const rejected = expect(candidate).rejects.toMatchObject({ name: "AbortError" });
    if (mode === "set") f.cache.set({ geometries: [], materials: [], instances: [] });
    else f.cache.updateInstances({ materials: [], instances: [] });
    await rejected; f.settle(); await Promise.allSettled(f.checks.map(check => check.promise));
    expect(f.draw()).toEqual({ drawCalls: 0, triangles: 0 }); expect(f.owned.size).toBe(mode === "set" ? 0 : 2);
    if (mode === "instances") { f.cache.updateInstances(p); expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 }); }
  });

  it("cancels in-flight checks on dispose and destroys every candidate exactly once", async () => {
    const f = fixture(); f.cache.set(packet());
    const result = f.cache.setValidated(packet(1)); const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    f.cache.dispose(); f.cache.dispose(); expect(f.owned.size).toBe(0); await rejected;
    f.settle(); await Promise.allSettled(f.checks.map(check => check.promise));
    for (const buffer of f.allocated) expect(buffer.destroy).toHaveBeenCalledOnce();
    await expect(f.cache.setValidated(packet())).rejects.toThrow("not ready");
  });

  it("does not publish a candidate if the device is lost before its checks return", async () => {
    const f = fixture(); f.cache.set(packet());
    const result = f.cache.setValidated(packet(1)); f.session.state = "lost"; f.settle();
    await expect(result).rejects.toMatchObject({ name: "AbortError" }); expect(f.owned.size).toBe(4);
    for (const buffer of f.allocated.slice(4)) expect(buffer.destroy).toHaveBeenCalledOnce();
    f.cache.dispose(); expect(f.owned.size).toBe(0);
  });

  it("does not cancel an existing request or open scopes for an already aborted request", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    const active = f.cache.setValidated(packet());
    await expect(f.cache.setValidated(packet(1), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.device.pushErrorScope).toHaveBeenCalledTimes(3); f.settle(); expect(await active).toBe(true);
  });

  it("pops successfully opened scopes after synchronous setup failure", async () => {
    const f = fixture(); f.cache.set(packet());
    f.device.queue.writeBuffer.mockImplementationOnce(() => { throw new Error("write failed"); });
    await expect(f.cache.setValidated(packet(1))).rejects.toThrow("write failed");
    expect(f.device.popErrorScope).toHaveBeenCalledTimes(3); f.settle();
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 }); expect(f.owned.size).toBe(4);
    expect(f.allocated[4]!.destroy).toHaveBeenCalledOnce();
  });

  it("reports partial scope setup and synchronous pop failures without leaking candidates", async () => {
    const f = fixture(); f.cache.set(packet());
    f.device.pushErrorScope.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("scope setup failed"); });
    await expect(f.cache.setValidated(packet(1))).rejects.toThrow("scope setup failed");
    expect(f.device.popErrorScope).toHaveBeenCalledTimes(1); f.settle();
    f.device.popErrorScope.mockImplementationOnce(() => { throw new Error("scope pop failed"); });
    const candidate = f.cache.setValidated(packet(1)); await expect(candidate).rejects.toThrow("scope pop failed");
    f.settle(1); expect(f.owned.size).toBe(4); expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    for (const buffer of f.allocated.slice(4)) expect(buffer.destroy).toHaveBeenCalledOnce();
  });

  it("retains successful resources after later signal abort and validates unchanged packets without uploads", async () => {
    const f = fixture(), controller = new AbortController();
    const first = f.cache.setValidated(packet(), controller.signal); f.settle(); expect(await first).toBe(true);
    controller.abort(); expect(f.owned.size).toBe(4); expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    const unchanged = f.cache.setValidated(packet()); f.settle(3); expect(await unchanged).toBe(false);
    expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(4); expect(f.owned.size).toBe(4);
  });
});
